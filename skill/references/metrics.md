# Headline Metrics

Four metrics drive 95% of analysis in this app: **FV**, **Projected WAR**, **Farm rank**, and **Payroll / CBT impact**. Each is documented below with formula, source code reference, and edge cases.

---

## 1. FV (Future Value)

**Definition:** The headline player valuation. Roughly: "what is this player worth in dollar-equivalent surplus over their remaining years of team control?"

**Unit:** A unitless score on a 0–30+ scale. Top stars: 25–30. Solid starters: 10–18. Bench depth: 2–8. Replacement: 0–2.

**Where computed:**
- `computePitcherValue(name)` — SP + RP (uses YBY + AGE_CURVES + `_pitcherAgeCost`)
- `computeIFValue(name)` — Infielders, catchers, DH
- `computeOFValue(name)` — Outfielders

All three return `{ fv, proj5yr, baselineWar, ... }`.

**Formula (simplified):**
```
fv = baselineWar * dollarPerWar * yearsOfControl + (positional / defense adjustments)
   - ageCost(playerAge, ageCurve)
   + young-small-sample lift (if age <= 23 and 0 < mlbPA < 200)
```

**Key inputs:**
- `baselineWar` — Blended Marcel + FG-ensemble projection (Steamer / ZiPS / THE BAT)
- `dollarPerWar` — Market dollar-per-WAR (~$10M as of 2026; lives in `DOLLAR_PER_WAR_MARKET`)
- `yearsOfControl` — From `CONTRACTS[name].fa_year` minus 2026
- `ageCost` — Penalty for projected aging decline, per-position curve (`_pitcherAgeCost`, `_hitterAgeFactor`)

**Edge case — `_projOnly:true` short-circuit:**
For synthesized rows (McClanahan, Jared Jones — players missing from the FG depthcharts), the function detects a single `_proj`-tagged YBY season and short-circuits to:
```js
const w = projWar;
return { fv: round(w * 3.85), proj5yr: round(w * 3.5) };
```

**Edge case — young small-sample lift:**
For age ≤ 23 with 0 < `mlbPA` < 200:
```js
const w = mlbPa / 200;
return Math.max(baselineWar, w * baselineWar + (1 - w) * 1.6);
```
This nudges Carson Williams from a tiny-bad-sample 1.4 up to 4.2, Junior Caminero, etc.

**Sample BigQuery (proposed schema):**
```sql
SELECT player_name, team, position, fv
FROM `mlb_index.players_valuation`
WHERE position = 'SS'
ORDER BY fv DESC
LIMIT 10;
```

---

## 2. Projected WAR / 5-Year WAR

**Definition:**
- `projWar` — Single-season projected WAR for 2026
- `proj5yr` — Sum of projected WAR across 2026–2030 (uses `agingTrajectory()` per player)

**Where computed:**
- `agingTrajectory(name)` returns `{ currentWar, currentFV, years: [{ year, projWar, age }, ...] }` for years 2026–2030
- The diamond's year-stepper (`_teamYearProjection(team, year)`) sums per-player projWar for a future year

**Inputs:**
- Current-year WAR baseline (from `YBY[name]` or FG ensemble)
- Per-position age curve (pitcher vs hitter, with `lateMult` for steep > age 35 decline)

**Edge case — Time-Lapse:**
The constellation's Time-Lapse mode scrubs years 2026 → 2030 by re-projecting each dot's WAR via `_timeLapseValForNode(node, year)`.

---

## 3. Farm system rank

**Definition:** Each of the 30 orgs gets a rank (#1–#30) by total prospect FV.

**Where computed:** `_computeEffectiveFarmRanks()` (line ~40246 in `mlb_pitchers.html`)

**Formula:**
```
For each org:
  total_fv = SUM(prospect.fv) for prospect in PROSPECT_BY_NAME WHERE prospect.team == org
           MINUS prospects in _WHATIF_PROSPECT_TRADED[org]
           PLUS prospects in _WHATIF_PROSPECT_ACQUIRED[org]
Rank all 30 orgs by total_fv DESC
```

**Source:** `PROSPECT_BY_NAME` (500 prospects across all orgs).

**What-If aware:** The "effective" farm reflects in-progress trades. The rank chip in the diamond header (`#N/30`) re-renders whenever `_WHATIF_PROSPECT_*` mutates.

**Edge case — Athletics alias:** The seeding loop iterates `TEAM_COLORS` keys and explicitly skips `"Oakland Athletics"` (prospects use `"Athletics"` only). Without this skip, `total` is 31 not 30.

**Sample BigQuery (proposed schema):**
```sql
WITH prospect_fv AS (
  SELECT team_canonical, SUM(fv) AS total_fv
  FROM `mlb_index.prospects`
  WHERE team_canonical != 'Oakland Athletics'  -- skip legacy alias
  GROUP BY team_canonical
)
SELECT team_canonical, total_fv,
  RANK() OVER (ORDER BY total_fv DESC) AS farm_rank
FROM prospect_fv;
```

---

## 4. Payroll + CBT impact

**Definition:** A team's 2026 active-roster payroll dollars, and how far it sits from each CBT threshold.

**Where computed:**
- `teamPayrollBreakdown(team)` — Decomposes a team's payroll by player
- `playerPayrollInYear(name, year)` — A single player's salary in a future year (uses `CONTRACTS[name].payroll_year` or AAV)
- `whatIfTeamPayroll(team)` — Includes hypothetical sign / trade additions

**Inputs:**
- `TEAM_PAYROLL_2026[team]` — Spotrac's official 2026 base
- `CONTRACTS[name].payroll_2026`, `.aav` — Per-player guaranteed money
- `_WHATIF[team]` — Slot overrides (added players)
- `_WHATIF_BENCH[team]`, `_WHATIF_BULLPEN[team]`, `_WHATIF_ROTATION[team]` — Side storage additions
- `_WHATIF_RELEASED[team]` — Trade-aways (full salary sheds)
- `_WHATIF_CUT[team]` — Cuts (roster spot freed, dead money stays)

**CBT thresholds (2026):**
```js
const CBT_THRESHOLDS = {
  2026: { first: 244e6, second: 264e6, third: 284e6, fourth: 304e6 }
};
```

**Sample BigQuery (proposed):**
```sql
SELECT team, payroll_2026,
  CASE
    WHEN payroll_2026 < 244e6 THEN 'under_first'
    WHEN payroll_2026 < 264e6 THEN 'first_band'
    WHEN payroll_2026 < 284e6 THEN 'second_band'
    WHEN payroll_2026 < 304e6 THEN 'third_band'
    ELSE 'fourth_band'
  END AS cbt_band
FROM `mlb_index.team_payroll`
ORDER BY payroll_2026 DESC;
```

---

## Validated baselines (as of deploy `86f1d26`)

Useful for regression-test sanity checks. If a query produces wildly different values for these players, something has drifted:

| Player | Engine | FV |
|---|---|---|
| Paul Skenes | SP | 29.8 |
| Tarik Skubal | SP | 25.5 |
| Drew Rasmussen | SP | 8.1 |
| Shane McClanahan | SP (proj-only) | 9.8 |
| Rafael Devers | IF | 7.278 |
| Junior Caminero | IF | 15.8 |
| Carson Williams | IF (young-lift) | 4.2 |
| James Wood | OF | 15.4 |

These baselines are byte-equivalent to the deployed `e7ecea6` constants — see "FV regression sweep" in the session notes.
