# PROSPECT_BY_NAME (Farm-system layer)

The minor-league pipeline. Each row is one prospect; all 30 orgs are represented.

---

## `PROSPECT_BY_NAME`

**Description:** Top prospects in each MLB org's farm system, scouted FV-based. Sourced from FanGraphs prospect board + manual top-100 lists.

**Approximate row count:** 500 (across all 30 orgs)

**Primary key:** `name` (string, unique across all of MLB minor leagues)

**Structure:** `PROSPECT_BY_NAME[name] = { name, org, team, pos, level, age, eta, orgRank, scoutFV, note, isPitcher, division, FV, fv }`

**Key fields:**

| Field | Type | Description |
|---|---|---|
| `name` | STRING | Full name |
| `org`, `team` | STRING | The org the prospect plays for (both fields point to the same value — Athletics-aliased ones use "Athletics") |
| `pos` | STRING | Position code ("SS", "RHP", "OF", etc.) |
| `level` | STRING | Highest level reached: "AAA" / "AA" / "A+" / "A" / "R" |
| `age` | INT | Age as of 2026 season |
| `eta` | INT | Projected MLB debut year |
| `orgRank` | INT | Rank within the org (#1 = top prospect, #2 = #2, etc.) |
| `scoutFV` | INT | Scouting grade on the 20–80 scale (45, 50, 55, 60, 65, 70) |
| `fv`, `FV` | FLOAT | Computed dollar-value (both fields exist; prefer `fv`) |
| `note` | STRING | Free-text scout note |
| `isPitcher` | BOOL | True for SP / RP prospects |
| `division` | STRING | MLB division (AL East, NL Central, etc.) |

**Sample distribution (top 5 farm systems by prospect count):**
- Arizona Diamondbacks — 20
- Toronto Blue Jays — 19
- Los Angeles Dodgers — 19
- Baltimore Orioles — 18
- Kansas City Royals — 18

**Relationships:**
- Joins to `TEAM_COLORS` on `team` (with the Athletics caveat)
- The What-If trade machinery (`_WHATIF_PROSPECT_TRADED`, `_WHATIF_PROSPECT_ACQUIRED`) shifts prospects between orgs
- Many prospects also exist as constellation graph nodes — `HOLO.graphData.nodes` filtered by `n.role === 'PR'` or `n.kind === 'prospect'`

---

## Effective farm composition

The "effective" farm system for an org under a What-If sandbox:

```
effective_farm[org] =
    { p : prospect for p in PROSPECT_BY_NAME WHERE p.team == org }
  − { p.name for any name in _WHATIF_PROSPECT_TRADED[org] }
  ∪ { p for any name in _WHATIF_PROSPECT_ACQUIRED[org] }
```

The `_computeEffectiveFarmRanks()` function (`mlb_pitchers.html` line ~40246) does this lookup, sums FV per org, and ranks 1–30. **Skip "Oakland Athletics" in the seed loop** (alias quirk — prospects use "Athletics" only).

---

## Sample queries

```sql
-- Top 10 prospects in baseball by FV
SELECT name, team, pos, level, fv, scout_fv
FROM `mlb_index.prospects`
ORDER BY fv DESC
LIMIT 10;

-- Farm rank (effective): top 10 systems by total prospect FV
WITH farm_fv AS (
  SELECT team, SUM(fv) AS total_fv, COUNT(*) AS prospect_count
  FROM `mlb_index.prospects`
  WHERE team != 'Oakland Athletics'      -- alias skip
  GROUP BY team
)
SELECT team, total_fv, prospect_count,
  RANK() OVER (ORDER BY total_fv DESC) AS farm_rank
FROM farm_fv
ORDER BY farm_rank
LIMIT 10;

-- Near-ready help: prospects ETA <= 2026 with FV >= 6
SELECT name, team, pos, age, eta, fv
FROM `mlb_index.prospects`
WHERE eta <= 2026 AND fv >= 6
ORDER BY fv DESC;
```

---

## Proposed BigQuery schema

```sql
CREATE OR REPLACE TABLE `mlb_index.prospects` (
  name           STRING      NOT NULL,
  team           STRING      NOT NULL,
  pos            STRING,
  is_pitcher     BOOL,
  level          STRING,
  age            INT64,
  eta            INT64,
  org_rank       INT64,
  scout_fv       INT64,        -- 20-80 scale
  fv             FLOAT64,      -- dollar-equivalent
  note           STRING,
  division       STRING
)
CLUSTER BY team;
```

Small dataset (~500 rows), so no partitioning needed. Clustered for the per-team farm-rank query.
