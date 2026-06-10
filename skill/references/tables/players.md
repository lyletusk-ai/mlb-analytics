# Player pools (ALL, RP_ALL, ALL_IF, ALL_OF) + PLAYER_META

The four core "tables" in the data model. All are JavaScript arrays embedded in `mlb_pitchers.html`, parsed from CSVs at app boot via `parseCSV(...).map(...)`. Each row is one player.

---

## `ALL` — Starting Pitchers

**Description:** All MLB starting pitchers on 40-man rosters or minor-league deals deep enough to matter. Sourced from `mlb_starting_pitchers_2025.csv` (Spotrac roster) + FG depthcharts projections.

**Approximate row count:** ~218

**Primary key:** `Name` (with team disambiguation for duplicates)

**Key columns:**

| Column | Type | Description |
|---|---|---|
| `Name` | STRING | Full name with diacritics |
| `Team` | STRING | Canonical team name ("New York Yankees") or abbreviation ("NYY") |
| `FV` | FLOAT | The headline valuation (see metrics.md) |
| `WAR` | FLOAT | 2025 actual WAR |
| `2026 WAR` | FLOAT | Pre-season 2026 projection |
| `2026 ERA` | FLOAT | Pre-season projected ERA |
| `2026 GS` | INT | Pre-season projected games started |
| `2026 IP` | FLOAT | Pre-season projected innings pitched |
| `GS`, `IP`, `ERA` | various | 2025 actuals (for trailing-window stats) |
| `Pos` | STRING | Position code, almost always "SP" |
| `Age_int` | INT | Age as of 2026 season |
| `_projOnly` | BOOL | True for synthesized stopgap rows (McClanahan, Jared Jones) |

**Relationships:**
- Joins to `CONTRACTS` on `Name`
- Joins to `PLAYER_META` on `Name`
- Has 1-many `YBY[Name]` array of historical seasons
- Has 1-many `PITCHER_FG[Name]` projection-system breakdowns

**Sample queries:**
```sql
-- BigQuery: top 10 starters by FV who are FAs after 2026
SELECT p.name, p.team, p.fv, c.fa_year, c.payroll_2026
FROM `mlb_index.starting_pitchers` p
JOIN `mlb_index.contracts` c ON p.name = c.player_name
WHERE c.fa_year = 2026
ORDER BY p.fv DESC
LIMIT 10;

-- Tarik Skubal's projection vs actual (trailing window)
SELECT name, team, war AS war_2025, `2026 ERA` AS proj_era_2026
FROM `mlb_index.starting_pitchers`
WHERE name = 'Tarik Skubal';
```

---

## `RP_ALL` — Relievers

**Description:** All MLB relievers (closers, setup, middle, long). Sourced from `mlb_relievers_2025.csv`.

**Approximate row count:** ~274

**Primary key:** `Name`

**Key columns:** Same shape as `ALL`, plus reliever-specific:

| Column | Type | Description |
|---|---|---|
| `Role` | STRING | "Closer" / "Setup" / "Middle" / "Long" — normalized to short codes (CL/SU/MR/LR) in node construction |
| `2026 SV` | INT | Projected saves |
| `2026 HLD` | INT | Projected holds |
| `2026 G` | INT | Projected games pitched |

**Relationships:** Same as `ALL`.

**Sample queries:**
```sql
-- Best closers by FV
SELECT name, team, fv, `2026 ERA` AS proj_era
FROM `mlb_index.relievers`
WHERE Role = 'Closer'
ORDER BY fv DESC
LIMIT 15;
```

---

## `ALL_IF` — Infielders + Catchers + DH

**Description:** All position players whose primary position is C, 1B, 2B, 3B, SS, IF (generic), or DH. Some utility players also appear in `ALL_OF`.

**Approximate row count:** ~341

**Primary key:** `Name`

**Key columns:**

| Column | Type | Description |
|---|---|---|
| `Name` | STRING | Full name |
| `Team` | STRING | Canonical name or abbreviation |
| `Pos` | STRING | "C" / "1B" / "2B" / "3B" / "SS" / "IF" / "DH" — defaults to "IF" if blank |
| `FV` | FLOAT | Headline valuation |
| `WAR` | FLOAT | 2025 actual WAR |
| `2026 WAR` | FLOAT | Pre-season projection (frozen at opening day) |
| `2026 OPS` | FLOAT | Pre-season projected OPS |
| `2026 HR`, `2026 SB`, `2026 BB%`, `2026 K%` | various | Pre-season counting projections |
| `OPS`, `HR`, `SB`, etc. | various | 2025 actuals |
| `Age_int` | INT | Age as of 2026 |
| `_projOnly` | BOOL | Stopgap flag |

**Position eligibility:**

`Pos` (the CSV column) is NOT the source of truth — `PLAYER_META[name].primaryPosition` (from MLB Stats API) is. For an effective position:

```js
function effPos(r) {
  const meta = PLAYER_META[r.Name];
  const mlbPos = meta && meta.primaryPosition;
  const HITTER_POS = new Set(['C','1B','2B','3B','SS','LF','CF','RF','DH','OF']);
  if (mlbPos && HITTER_POS.has(mlbPos)) return mlbPos;
  return r.Pos;
}
```

**Relationships:** Joins to CONTRACTS, PLAYER_META, IF_YBY, IF_FG.

---

## `ALL_OF` — Outfielders

**Description:** All position players whose primary position is LF, CF, RF, or OF. Some utility players overlap with `ALL_IF`.

**Approximate row count:** ~220

**Primary key:** `Name`

**Key columns:** Same shape as `ALL_IF` but `Pos` is "LF" / "CF" / "RF" / "OF".

**Relationships:** Joins to CONTRACTS, PLAYER_META, OF_YBY, OF_FG.

---

## `PLAYER_META` — Per-player metadata

**Description:** Side-table keyed by name with metadata pulled from MLB Stats API. Not all players have entries.

**Structure:** `PLAYER_META[name] = { ... }`

**Key fields:**

| Field | Type | Description |
|---|---|---|
| `player_id` | INT | Official MLBAM id (the canonical join key) |
| `primaryPosition` | STRING | Canonical position from Stats API ("SS", "LF", "P") |
| `injuryStatus` | STRING | Current status — empty / "Active" / "Day-to-Day" / "10-Day IL" / "60-Day IL" / "Minors" / "Reassigned" / "Designated" / "Released" / "Free Agent" / "Restricted" / "Suspended" |
| `debutDate` | DATE | First MLB game date (sometimes missing for established vets) |
| `bats`, `throws` | STRING | "L" / "R" / "S" |

**Optional active-roster filter:**
```js
const STATUS_REGEX = /Minors|Reassigned|Designated|Outright|Released|Free Agent|Suspended|Restricted/i;
const isActive = (name) => !STATUS_REGEX.test(PLAYER_META[name]?.injuryStatus || '');
```

Used by `computeTeamDiamondSlots`, `_isOnActiveRoster`, etc. Not applied globally — analyst's choice.

**Gotcha:** `primaryPosition` is **sometimes missing**, which is why `isPositionEligible()` falls through to `return true` and lets a hitter accidentally slot at P. Always use `_resolvedPositionEligible()` instead, which falls back to pool-based detection (ALL+RP_ALL vs ALL_IF+ALL_OF).

---

## Proposed BigQuery schema

When migrating from CSVs to BigQuery, the four pools collapse into a single `players` table with a `pool` discriminator:

```sql
CREATE OR REPLACE TABLE `mlb_index.players` (
  player_id      INT64       NOT NULL,
  name           STRING      NOT NULL,
  team_canonical STRING      NOT NULL,
  team_raw       STRING,                       -- as in CSV ("NYY")
  pool           STRING      NOT NULL,         -- 'SP' / 'RP' / 'IF' / 'OF'
  position       STRING,                       -- effective pos from primaryPosition
  age            INT64,
  fv             FLOAT64,
  proj_war_2026  FLOAT64,
  proj_5yr_war   FLOAT64,
  war_2025       FLOAT64,
  injury_status  STRING,
  debut_date     DATE,
  proj_only      BOOL        DEFAULT FALSE,    -- stopgap flag
  bats           STRING,
  throws         STRING
)
CLUSTER BY team_canonical, pool;
```

Joins on `player_id`, partitioned by nothing (small dataset), clustered for the common `WHERE team = ... AND pool = ...` filter.
