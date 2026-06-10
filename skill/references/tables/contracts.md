# CONTRACTS + payroll modeling

## `CONTRACTS`

**Description:** Per-player guaranteed money + control years. Sourced from Spotrac roster pages.

**Approximate row count:** Most active MLB players are covered; minor leaguers + recently signed FAs may not be.

**Primary key:** `name` (string).

**Structure:** `CONTRACTS[name] = { ... }`

**Key fields:**

| Field | Type | Description |
|---|---|---|
| `name` | STRING | Player name |
| `fa_year` | INT | First year of free agency (e.g., 2027 means under team control through 2026, FA winter 2026–27) |
| `aav` | FLOAT | Average annual value of the current contract |
| `payroll_2026` | FLOAT | Specific 2026 base salary |
| `payroll_2027`, `payroll_2028`, ... | FLOAT | Future years on a guaranteed deal |
| `option_year` | INT | Year of any club / mutual / player option (if any) |
| `option_buyout` | FLOAT | Buyout dollar amount if the option is declined |

**Note:** `fa_year` is sometimes **unreliable for stars** — Spotrac inherits bogus far-future values for some superstars (Lindor's deal, etc.). The `_moveKind` resolver in `parseAIQuery` (line ~28746) treats `fa_year` between 2026–2027 as "FA pending" and `>= 2028` as "under control," but defaults to "sign" rather than "trade" if values are weird.

---

## Years of control

```js
function yearsOfControl(name, asOfYear = 2026) {
  const c = CONTRACTS[name];
  if (!c || !Number.isFinite(+c.fa_year)) return 0;
  return Math.max(0, +c.fa_year - asOfYear);
}
```

Used as a multiplier in `computePitcherValue` / `computeIFValue` / `computeOFValue` — every year of control is worth ~`dollarPerWar * projWar` minus the player's salary, summed.

---

## Sample queries

```sql
-- Players whose contracts run through 2030+ (long-term commitments)
SELECT player_name, fa_year, aav, payroll_2026
FROM `mlb_index.contracts`
WHERE fa_year >= 2030
ORDER BY aav DESC
LIMIT 20;

-- Per-team committed payroll 2026 (active roster guaranteed money)
SELECT p.team_canonical, ROUND(SUM(c.payroll_2026), 1) AS committed_2026
FROM `mlb_index.players` p
JOIN `mlb_index.contracts` c ON p.player_id = c.player_id
GROUP BY p.team_canonical
ORDER BY committed_2026 DESC;

-- 2027 FA class: top 30 by FV
SELECT p.name, p.team_canonical, p.fv, c.fa_year, c.aav
FROM `mlb_index.players` p
JOIN `mlb_index.contracts` c ON p.player_id = c.player_id
WHERE c.fa_year = 2027
ORDER BY p.fv DESC
LIMIT 30;
```

---

## What-If payroll model

When the analyst is in the What-If sandbox, payroll calculations must factor in:

| State bag | Effect on team payroll |
|---|---|
| `_WHATIF[team][pos] = name` (slot override) | **Adds** the new player's AAV / projected new contract |
| `_WHATIF_BENCH[team]`, `_WHATIF_BULLPEN[team]`, `_WHATIF_ROTATION[team]` (storage zone adds) | **Adds** AAV |
| `_WHATIF_RELEASED[team]` (trade-away) | **Subtracts** the player's payroll_2026 (full salary sheds) |
| `_WHATIF_CUT[team]` (cut / waive / release) | **No subtraction** — dead money stays on the books (only the roster spot is freed) |

**Critical rule from the codebase comments:**
> "A sign/swap displaces the incumbent to bench depth (salary stays). A CUT (cut/release/waive — listed in cut_players) opens the roster spot but the guaranteed salary stays as dead money, so payroll barely moves. A trade-away (remove/drop) sheds the whole contract, so payroll drops."

---

## CBT band lookup

```sql
WITH payroll AS (
  SELECT team_canonical, SUM(payroll_2026) AS payroll_2026
  FROM `mlb_index.contracts`
  GROUP BY team_canonical
)
SELECT p.team_canonical, p.payroll_2026,
  CASE
    WHEN p.payroll_2026 >= 304e6 THEN 'fourth_band (Steve Cohen tax)'
    WHEN p.payroll_2026 >= 284e6 THEN 'third_band'
    WHEN p.payroll_2026 >= 264e6 THEN 'second_band'
    WHEN p.payroll_2026 >= 244e6 THEN 'first_band'
    ELSE 'under_threshold'
  END AS cbt_band,
  ROUND(244e6 - p.payroll_2026, 0) AS room_under_first
FROM payroll p
ORDER BY p.payroll_2026 DESC;
```

---

## Proposed BigQuery schema

```sql
CREATE OR REPLACE TABLE `mlb_index.contracts` (
  player_id        INT64       NOT NULL,
  player_name      STRING      NOT NULL,
  fa_year          INT64,
  aav              FLOAT64,
  payroll_2026     FLOAT64,
  payroll_2027     FLOAT64,
  payroll_2028     FLOAT64,
  payroll_2029     FLOAT64,
  payroll_2030     FLOAT64,
  option_year      INT64,
  option_type      STRING,     -- 'club' / 'mutual' / 'player' / 'vesting'
  option_buyout    FLOAT64,
  fa_year_is_estimate BOOL     -- True if fa_year was derived heuristically
);
```

For a richer model, store a separate `contract_years` table with one row per (player_id, year) so future arbitration / extension projections fit cleanly.
