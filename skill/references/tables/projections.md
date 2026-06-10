# YBY (year-by-year) + FG projection systems

The projection layer underneath every FV computation. Three intertwined tables:

1. **`YBY`** — historical year-by-year stats per player
2. **`PITCHER_FG`, `IF_FG`, `OF_FG`** — FanGraphs projection systems (Steamer, ZiPS, THE BAT, depthcharts)
3. **The dynamic Marcel-weight blend** — how the live in-season pace pulls the projection

---

## `YBY` / `IF_YBY` / `OF_YBY`

**Description:** Per-player array of historical seasons. Used as the prior for Marcel projections.

**Structure:** `YBY[name] = [{ year, ip, era, war, ... }, ...]` for pitchers; `IF_YBY[name]` / `OF_YBY[name]` similar shape for hitters with `pa`, `ops`, `hr`, `rbi`, etc.

**Key fields (pitchers):**

| Field | Type | Description |
|---|---|---|
| `year` | INT | Season year (e.g., 2023, 2024, 2025, 2026) |
| `ip` | FLOAT | Innings pitched |
| `era` | FLOAT | Earned run average |
| `whip` | FLOAT | Walks + hits per IP |
| `k9`, `bb9`, `hr9` | FLOAT | Per-9 rates |
| `k_pct`, `bb_pct` | FLOAT | Per-PA rates |
| `xfip` | FLOAT | Expected FIP |
| `fb_mph` | FLOAT | Average fastball velocity |
| `babip` | FLOAT | Batting average on balls in play |
| `war` | FLOAT | Wins above replacement for that season |
| `gs` | INT | Games started |
| `pa` | INT | Plate appearances faced |
| `_proj` | BOOL | If true, this is a synthesized projection-only season (not real data) — see McClanahan / Jared Jones stopgap |

**Key fields (hitters):**

| Field | Type | Description |
|---|---|---|
| `year`, `pa`, `g` | various | Standard playing-time fields |
| `avg`, `obp`, `slg`, `ops` | FLOAT | Slash-line stats |
| `hr`, `rbi`, `r`, `sb`, `bb_pct`, `k_pct` | various | Counting + rate stats |
| `oaa`, `drs`, `sprint` | various | Defense + speed metrics (for OAA, DRS, sprint speed) |
| `_proj` | BOOL | Synthesized stopgap flag |

---

## FG projection systems (`PITCHER_FG`, `IF_FG`, `OF_FG`)

**Description:** Per-player object of projection-system → projected season. The FG ensemble.

**Structure:** `PITCHER_FG[name] = { steamer_ros: {...}, zips: {...}, thebat: {...}, depthcharts: {...}, standard: {...} }`

Each inner object has 2026 projections from that system.

**Systems represented:**

| System | What it is |
|---|---|
| `steamer_ros` | Steamer ROS (rest of season) projection — recommended for in-season analysis |
| `zips` | Dan Szymborski's ZiPS |
| `thebat` / `thebatx` | Derek Carty's THE BAT (X is the more recent version) |
| `depthcharts` | FG's manually-curated PT distribution |
| `standard` | FG standard projection (older) |

---

## The dynamic Marcel-weight blend

This is the secret sauce that the projection systems use to mix prior + current-season pace into the 2026 projection.

**Key constant:** `_MARCEL_STAB_PA` — per-stat stabilization PA target.

```js
const _MARCEL_STAB_PA = {
  k_pct: 100, bb_pct: 150,
  hr: 200, sb: 200,
  ops: 250, slg: 300,
  obp: 280, avg: 350,
  rbi: 350, r: 350
};
```

**Formula sketch:**
For 2026 projection of stat X:
- `marcel = weighted_average(priors, partial_2026)` (PA-weighted)
- `fg_ensemble = average(steamer, zips, thebatx)` for that stat
- `grow = min(1.0, currentPA / _MARCEL_STAB_PA[stat])`
- `marcel_weight = max(base_marcel, base_marcel + (TARGET - base_marcel) * grow)` where `TARGET = 0.80`
- `final = marcel_weight * marcel + (1 - marcel_weight) * fg_ensemble`

**Self-documented in the FV breakdown:**
> "13–20% ensemble weight (dynamic, drops as 2026 PA grows)"

**Validated by:** `backtest_dynamic_weight.py` — directional-correctness harness comparing OLD flat-Marcel vs NEW dynamic-Marcel projections.

---

## `_projOnly` stopgap injection

For players the FG depthcharts dropped (typically due to long-term injury — McClanahan, Jared Jones), the app injects a synthetic row:

```js
const WANT = [
  { name: 'Shane McClanahan', team: 'Tampa Bay Rays', birthYear: 1997 },
  { name: 'Jared Jones',      team: 'Pittsburgh Pirates', birthYear: 2001 }
];

// For each:
//   1. Blend PITCHER_FG (depthcharts + thebat + steamer_ros) into a single proj
//   2. Inject as a single _proj-tagged YBY season:
//        YBY['Shane McClanahan'] = [{ year: 2026, _proj: true, ip, era, war, ... }];
//   3. Add a row to ALL with _projOnly: true so the engine sees them
//   4. Inject BIRTH_YEAR and a PLAYER_META stub
```

The `computePitcherValue()` function detects single-`_proj` arrays and short-circuits:
```js
if (Array.isArray(seasons) && seasons.length === 1 && seasons[0]._proj) {
  const w = seasons[0].war;
  return { fv: round(w * 3.85), proj5yr: round(w * 3.5) };
}
```

---

## Sample queries

```sql
-- A player's full historical seasons
SELECT name, year, ip, era, war, _proj
FROM `mlb_index.player_seasons`
WHERE name = 'Paul Skenes'
ORDER BY year DESC;

-- Which 2026 starters had a 4+ WAR season in the last 3 years?
WITH career_peak AS (
  SELECT name, MAX(war) AS peak_war
  FROM `mlb_index.player_seasons`
  WHERE year BETWEEN 2023 AND 2025 AND NOT _proj
  GROUP BY name
)
SELECT p.name, p.team_canonical, p.fv, c.peak_war
FROM `mlb_index.players` p
JOIN career_peak c USING (name)
WHERE p.pool = 'SP' AND c.peak_war >= 4
ORDER BY c.peak_war DESC;

-- FG ensemble average ERA for a player
SELECT name,
  AVG(projected_era) AS fg_ensemble_era
FROM `mlb_index.fg_projections`
WHERE name = 'Tarik Skubal'
  AND system IN ('steamer_ros', 'zips', 'thebatx', 'depthcharts')
GROUP BY name;
```

---

## Proposed BigQuery schema

```sql
-- One row per (player, year)
CREATE OR REPLACE TABLE `mlb_index.player_seasons` (
  player_id  INT64       NOT NULL,
  name       STRING      NOT NULL,
  year       INT64       NOT NULL,
  is_pitcher BOOL,
  -- pitcher stats
  ip         FLOAT64,
  era        FLOAT64,
  whip       FLOAT64,
  k_pct      FLOAT64,
  bb_pct     FLOAT64,
  k9         FLOAT64,
  bb9        FLOAT64,
  hr9        FLOAT64,
  xfip       FLOAT64,
  fb_mph     FLOAT64,
  babip      FLOAT64,
  war        FLOAT64,
  gs         INT64,
  -- hitter stats
  pa         INT64,
  g          INT64,
  avg_stat   FLOAT64,
  obp        FLOAT64,
  slg        FLOAT64,
  ops        FLOAT64,
  hr         INT64,
  rbi        INT64,
  r          INT64,
  sb         INT64,
  oaa        FLOAT64,
  drs        FLOAT64,
  sprint     FLOAT64,
  -- meta
  is_proj_only BOOL DEFAULT FALSE   -- _proj stopgap flag
)
PARTITION BY RANGE_BUCKET(year, GENERATE_ARRAY(2010, 2030, 1))
CLUSTER BY name;

-- One row per (player, year, system) for FG projections
CREATE OR REPLACE TABLE `mlb_index.fg_projections` (
  player_id      INT64       NOT NULL,
  name           STRING      NOT NULL,
  year           INT64       NOT NULL,
  system         STRING      NOT NULL,    -- 'steamer_ros' / 'zips' / 'thebatx' / 'depthcharts' / 'standard'
  projected_war  FLOAT64,
  projected_era  FLOAT64,
  projected_ops  FLOAT64,
  -- ... full stat shape from the source CSV
)
CLUSTER BY name, system;
```

Partitioning on `year` is sensible because most queries filter by year (`WHERE year = 2026` or `year BETWEEN 2023 AND 2025`).
