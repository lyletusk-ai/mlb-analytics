# SQL patterns + the position-eligibility helper

Common BigQuery query patterns for the MLB Index data, plus the **#1 gotcha helper**: how to correctly check if a player can play a position.

---

## The #1 gotcha: position eligibility

**Problem:** `PLAYER_META.primaryPosition` is sometimes missing. The naive `isPositionEligible(name, pos)` falls through to `return true` when meta is missing, so a hitter accidentally gets allowed at P.

**Fix:** Use **`_resolvedPositionEligible(name, pos)`** which resolves the pitcher/hitter split from the actual data pools — `ALL + RP_ALL = pitcher`, `ALL_IF + ALL_OF = hitter`, in BOTH = two-way (Ohtani), in NEITHER = defer.

```js
// JavaScript reference implementation (mlb_pitchers.html line ~40246):
function _resolvedPositionEligible(playerName, pos) {
  const inPitcherPool = ALL.some(r => r.Name === playerName)
                     || RP_ALL.some(r => r.Name === playerName);
  const inHitterPool  = ALL_IF.some(r => r.Name === playerName)
                     || ALL_OF.some(r => r.Name === playerName);
  if (inPitcherPool && inHitterPool) return true;          // two-way (Ohtani)
  if (inPitcherPool) return pos === 'P';                   // pitcher only
  if (inHitterPool)  return pos !== 'P';                   // hitter only
  return (typeof isPositionEligible === 'function')
    ? isPositionEligible(playerName, pos) : true;          // unknown → defer
}
```

**BigQuery equivalent:**

```sql
WITH player_class AS (
  SELECT
    player_id,
    name,
    LOGICAL_OR(pool IN ('SP', 'RP')) AS in_pitcher_pool,
    LOGICAL_OR(pool IN ('IF', 'OF')) AS in_hitter_pool
  FROM `mlb_index.players`
  GROUP BY player_id, name
),
position_eligible AS (
  SELECT
    pc.player_id,
    pc.name,
    pos,
    CASE
      WHEN pc.in_pitcher_pool AND pc.in_hitter_pool THEN TRUE        -- two-way
      WHEN pc.in_pitcher_pool THEN pos = 'P'
      WHEN pc.in_hitter_pool  THEN pos != 'P'
      ELSE TRUE                                                       -- unknown — allow
    END AS eligible
  FROM player_class pc
  CROSS JOIN UNNEST(['P','C','1B','2B','3B','SS','LF','CF','RF','DH']) AS pos
)
SELECT * FROM position_eligible WHERE eligible;
```

---

## Pattern: Top-N by metric within a group

```sql
-- Top 3 prospects per org by FV
SELECT * EXCEPT(rk) FROM (
  SELECT
    name, team, pos, fv,
    ROW_NUMBER() OVER (PARTITION BY team ORDER BY fv DESC) AS rk
  FROM `mlb_index.prospects`
)
WHERE rk <= 3
ORDER BY team, rk;
```

---

## Pattern: Team's effective starting lineup

The lineup the team would field if every position got the highest-FV player at that position.

```sql
WITH eligible AS (
  SELECT p.player_id, p.name, p.team_canonical, p.fv, p.position
  FROM `mlb_index.players` p
  WHERE p.team_canonical = 'Pittsburgh Pirates'
    AND p.position IN ('C','1B','2B','3B','SS','LF','CF','RF','DH')
)
SELECT position,
  ARRAY_AGG(STRUCT(name, fv) ORDER BY fv DESC LIMIT 1)[OFFSET(0)] AS starter
FROM eligible
GROUP BY position
ORDER BY ARRAY_POSITION(['C','1B','2B','3B','SS','LF','CF','RF','DH'], position);
```

---

## Pattern: Trailing-window stats (the time-grain convention)

The skill convention is **trailing window** rather than calendar buckets. For a "last 365 days" rate:

```sql
-- Pitchers: last-365-day K%
WITH recent_starts AS (
  SELECT pitcher_id, k_pct, batters_faced
  FROM `mlb_index.statcast_game_log`
  WHERE game_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY)
)
SELECT
  pitcher_id,
  SAFE_DIVIDE(
    SUM(k_pct * batters_faced),
    SUM(batters_faced)
  ) AS k_pct_trailing_365
FROM recent_starts
GROUP BY pitcher_id;
```

---

## Pattern: What-If sandbox application

When the user has roster overrides loaded, compute the team's effective lineup honoring all the bags.

```sql
WITH whatif_overrides AS (
  -- _WHATIF[team] = { 'SS': 'CJ Abrams', '3B': 'Manny Machado' }
  SELECT 'Pittsburgh Pirates' AS team, 'SS' AS pos, 'CJ Abrams' AS player UNION ALL
  SELECT 'Pittsburgh Pirates',         '3B',         'Manny Machado'
),
released AS (
  -- _WHATIF_RELEASED[team] = ['Ke\'Bryan Hayes', ...]
  SELECT 'Pittsburgh Pirates' AS team, 'Ke\'Bryan Hayes' AS player
),
team_pool AS (
  SELECT p.player_id, p.name, p.position, p.fv
  FROM `mlb_index.players` p
  WHERE p.team_canonical = 'Pittsburgh Pirates'
    AND p.name NOT IN (SELECT player FROM released)
),
slots AS (
  SELECT
    pos,
    COALESCE(
      -- 1) override first
      (SELECT player FROM whatif_overrides w WHERE w.pos = pos LIMIT 1),
      -- 2) natural top-FV at that position
      (SELECT name FROM team_pool t WHERE t.position = pos
       ORDER BY t.fv DESC LIMIT 1)
    ) AS slotted
  FROM UNNEST(['C','1B','2B','3B','SS','LF','CF','RF','DH']) AS pos
)
SELECT * FROM slots;
```

---

## Pattern: Farm-rank delta after a trade

```sql
-- "If Yankees trade Lombard Jr. to Astros, what happens to each org's farm rank?"
WITH effective_farm AS (
  SELECT
    CASE
      WHEN name = 'George Lombard Jr.' THEN 'Houston Astros'    -- ACQUIRED
      ELSE team
    END AS effective_team,
    fv
  FROM `mlb_index.prospects`
  WHERE NOT (team = 'New York Yankees' AND name = 'George Lombard Jr.')  -- TRADED
     OR name = 'George Lombard Jr.'                                       -- but keep his row, reassigned
),
team_fv AS (
  SELECT effective_team AS team, SUM(fv) AS total_fv
  FROM effective_farm
  WHERE effective_team != 'Oakland Athletics'   -- alias skip
  GROUP BY effective_team
)
SELECT team, total_fv, RANK() OVER (ORDER BY total_fv DESC) AS new_farm_rank
FROM team_fv
ORDER BY new_farm_rank;
```

---

## Pattern: CBT-aware trade matchmaking

```sql
-- Teams with the most room under the first CBT threshold (244M in 2026)
WITH team_payroll AS (
  SELECT team_canonical AS team, SUM(payroll_2026) AS payroll
  FROM `mlb_index.contracts`
  GROUP BY team_canonical
)
SELECT team, payroll,
  ROUND(244e6 - payroll, 0) AS room_under_first_cbt,
  CASE
    WHEN payroll < 244e6 THEN 'has room'
    WHEN payroll < 264e6 THEN 'first band'
    WHEN payroll < 284e6 THEN 'second band'
    WHEN payroll < 304e6 THEN 'third band'
    ELSE 'fourth band (Cohen tax)'
  END AS cbt_band
FROM team_payroll
ORDER BY room_under_first_cbt DESC;
```

---

## Pattern: Multi-year roster projection (Time-Lapse / Year stepper)

```sql
-- For each player on the open team, project WAR through 2030 via age curve
WITH base AS (
  SELECT player_id, name, team_canonical, age, war AS war_2025, fv
  FROM `mlb_index.players`
  WHERE team_canonical = 'Pittsburgh Pirates'
),
years AS (
  SELECT * FROM UNNEST([2026, 2027, 2028, 2029, 2030]) AS proj_year
)
SELECT
  b.player_id, b.name, y.proj_year,
  b.age + (y.proj_year - 2026) AS age_in_proj_year,
  -- Replace with your aging-curve UDF or join to a `mlb_index.age_curve` table:
  b.war_2025 * POWER(0.95, GREATEST(0, b.age + (y.proj_year - 2026) - 28)) AS proj_war
FROM base b CROSS JOIN years y
ORDER BY b.name, y.proj_year;
```

For real-world accuracy, use the position-specific `_pitcherAgeCost(age, curve)` / `_hitterAgeFactor(age, youthBump, declineRate)` helpers from `mlb_pitchers.html` line ~3711, ported to BigQuery as a UDF.

---

## Conventions

- **Use `team_canonical`** (the cleaned name) as the join key, not `team_raw` from CSVs
- **Skip `'Oakland Athletics'`** in any `GROUP BY team` for rank loops
- **Treat `fa_year >= 2030` as "long-term controlled"** rather than literal — Spotrac data for stars sometimes has wild values
- **Prefer `proj_war`** for forward-looking valuation; use `war_2025` only for trailing-window comparisons
- **Always check the `_proj_only` flag** when computing player metrics so stopgap rows don't contaminate aggregates
