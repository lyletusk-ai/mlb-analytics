# Entities

## Player

The atomic unit of analysis. Every row in every pool / projection / contract table is "about" a player.

### Subtypes

A player belongs to **one or more** of these pools (some players appear in multiple):

| Subtype | Pool source | Roughly |
|---|---|---|
| **SP** (Starting Pitcher) | `ALL` | ~218 rows |
| **RP** (Reliever) | `RP_ALL` | ~274 rows |
| **IF** (Infielder + C + DH) | `ALL_IF` | ~341 rows |
| **OF** (Outfielder) | `ALL_OF` | ~220 rows |
| **PR** (Prospect / minor leaguer) | `PROSPECT_BY_NAME` | ~500 rows |

A **two-way player** (Shohei Ohtani, Reid Detmers in some splits) appears in BOTH a pitcher pool AND a hitter pool. The `_resolvedPositionEligible()` helper checks for this case and allows the player at any position.

A **utility player** (Polanco, Vientos) may appear in BOTH IF and OF. The constellation graph dedupes by `name|team` but the underlying pools have row duplicates.

### Canonical identifier

**MLB Stats API `player_id`** (integer, from `statsapi.mlb.com`).

- Stored in `PLAYER_META[name].player_id` (when available)
- The graph node `id` is currently `name` (or `name|team` when names collide), NOT the MLB id — this is a known sloppiness; ideally migrate to `mlb_player_id` everywhere
- For display, always use the player's full name (with diacritics: "José Ramírez", "Julio Rodríguez")

### Disambiguation

When two players share a name:
- The data pools store both rows (e.g., two "Max Muncy"s — Athletics + Dodgers)
- The graph node `resolveNodeId()` function suffixes the second occurrence's id with `|team`
- For queries: `WHERE name = 'Max Muncy' AND team = 'Los Angeles Dodgers'`

## Team

The 30 MLB organizations. Used as both a roster grouping (active 26-man / 40-man players) AND as a farm-system grouping (prospects in the org's pipeline).

### Tables that hold team info

- **`TEAM_COLORS`** — 30 teams + 1 alias (the Athletics double-entry). Keys are the team display names.
- **`TEAM_PAYROLL_2026`** — Spotrac's official 2026 active-roster payroll dollars per team.
- **`TEAM_DIVISION`** — Maps team → 'AL East' / 'NL Central' / etc.
- **`CBT_THRESHOLDS`** — Luxury-tax thresholds for 2026–2028.

### The Athletics alias problem

The team that plays in Sacramento goes by **two names** in the data:
- `"Oakland Athletics"` — the legacy CSV / TEAM_COLORS key
- `"Athletics"` — what prospect rows actually use

`_canonTeam()` helper attempts to unify but doesn't always succeed. **For any team-rank loop, explicitly skip `"Oakland Athletics"`** (the same guard the payroll IIFE at line ~41106 uses, and the farm-rank `_computeEffectiveFarmRanks` helper uses).

```sql
-- BigQuery: when ranking all 30 teams, exclude the alias
SELECT team, total_fv
FROM player_pools
WHERE team != 'Oakland Athletics'   -- prospect rows use 'Athletics' only
GROUP BY team
```

## Org / Farm system

A subset of "team" — the **minor league pipeline** that feeds a major-league club. Modeled as `PROSPECT_BY_NAME[name].org` (synonymous with `.team`).

Every prospect belongs to one org. Acquired prospects (`_WHATIF_PROSPECT_ACQUIRED`) shift to a new org for What-If analysis. The `_computeEffectiveFarmRanks()` function ranks all 30 orgs by their total prospect FV.

## Relationships

```
Team ──┬── (1:many) ─── MLB Player (active roster)
       │
       └── (1:many) ─── Prospect (farm system)
                              │
                              └── (1:1 graduation) ─── MLB Player (eventually)

MLB Player ─── (1:1) ─── Contract (CONTRACTS[name])
MLB Player ─── (1:1) ─── PlayerMeta (PLAYER_META[name])
MLB Player ─── (1:many) ─── YBY Season (YBY[name] is an array of seasons)
MLB Player ─── (1:many) ─── FG Projection (PITCHER_FG[name] is an object of system → season)
```

## Optional filters (not mandatory — analyst's choice)

When the analyst's question doesn't care about edge cases, these are sensible defaults:

| Filter | When to apply |
|---|---|
| `injuryStatus NOT IN ('Minors','Reassigned','Designated','Outright','Released','Free Agent','Suspended','Restricted')` | Active-roster-only analysis (computeTeamDiamondSlots uses this) |
| Combined `2025 + 2026 G >= 50` (hitters) or `GS >= 12` (pitchers) | Excludes tiny-sample debuts |
| `_projOnly != true` | Excludes stopgap projection-only rows (McClanahan, Jared Jones) |
| `WHERE name NOT IN _WHATIF_RELEASED[team]` | When the user has a What-If sandbox running |

The app code uses these contextually — there's no global WHERE clause that always applies.
