---
name: mlb-analytics-data
description: Domain knowledge for analyzing the MLB Player Index data — player pools (SP / RP / IF / OF / prospect), valuation engine (FV, projected WAR, 5-yr WAR), farm-system ranking, contract / CBT modeling, and the year-by-year (YBY) projection pipeline. Use when writing queries, computing metrics, or interpreting roster moves in the mlbplayerindex.com / mlb_pitchers.html app.
---

# MLB Analytics — Data Context

This skill teaches Claude the data model behind the MLB Player Index app — what each pool / table represents, how players are identified, how the headline metrics (FV, WAR, farm rank, payroll) are computed, and the gotchas that trip up analysis.

The data currently lives as embedded JSON + CSV in `mlb_pitchers.html` and as Python scripts in `~/Coding Projects/mlb-analytics/`. This skill documents the **conceptual model** and includes a **proposed BigQuery schema** for migration.

## When to use this skill

- Writing SQL or JS to compute player valuation
- Interpreting roster moves (signs, trades, swaps)
- Understanding farm-system rank changes
- Modeling CBT-aware trade scenarios
- Reading or modifying the `_PANEL_CMDS`, `computePitcherValue`, `computeIFValue`, `computeOFValue`, `_computeEffectiveFarmRanks` functions
- Migrating the file-based data to BigQuery

## Quick orientation

**Core entity:** Player. Every analysis ultimately rolls up to or down to player-level rows.

**Canonical identifier:** MLB Stats API `player_id` (integer). Name is for display only — same-named players (Max Muncy on Athletics + Dodgers) are disambiguated by `name|team` in the graph but should be resolved to the official `player_id` whenever possible.

**Time grain:** **Trailing window.** Stats default to "last 30 days" / "last season" / "last 365 days" rather than calendar-year buckets. The YBY table is annual but most metrics blend a trailing partial-season component.

**No mandatory filters.** Unlike most SaaS / e-comm warehouses, this data has no global "always exclude" rule — the analyst chooses what to drop based on the question (minor leaguers may matter for prospect analysis, not for roster construction). Common optional filters are listed in `references/entities.md`.

**Headline metrics:** FV (Future Value) · Projected WAR · Farm system rank · Payroll + CBT impact. All four are defined in `references/metrics.md`.

**The #1 gotcha:** Position eligibility. `PLAYER_META.primaryPosition` is sometimes missing, so the `isPositionEligible()` check falls through to `true` — a bug source where hitters get accidentally slotted at P. Use the pool-based `_resolvedPositionEligible()` helper instead (it checks ALL+RP_ALL vs ALL_IF+ALL_OF). See `references/sql-patterns.md`.

## Knowledge base navigation

- **`references/entities.md`** — Player (with SP / RP / IF / OF / prospect subtypes), Team / Org, and how they relate.
- **`references/metrics.md`** — The 4 headline metrics with exact formulas and edge cases.
- **`references/tables/players.md`** — The four MLB player pools (ALL, RP_ALL, ALL_IF, ALL_OF) + PLAYER_META.
- **`references/tables/prospects.md`** — PROSPECT_BY_NAME and the farm-system layer.
- **`references/tables/teams.md`** — Team-level tables, TEAM_COLORS, the Athletics alias problem.
- **`references/tables/contracts.md`** — CONTRACTS, TEAM_PAYROLL_2026, CBT_THRESHOLDS.
- **`references/tables/projections.md`** — YBY (year-by-year), FG projection systems (Steamer / ZiPS / THE BAT), the dynamic Marcel-weight blend.
- **`references/sql-patterns.md`** — Common BigQuery query patterns + the proposed schema mapping.

## SQL dialect: BigQuery

All examples in this skill use BigQuery SQL. Key dialect notes:

- Use backticks for table refs: `` `project.dataset.table` ``
- Date functions: `DATE_TRUNC(date, MONTH)`, `DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)`
- String matching: `REGEXP_CONTAINS(injury_status, r'Minors|Reassigned|Designated|...')`
- Array unnesting: `UNNEST(yby_seasons) AS season`
- JSON: `JSON_VALUE(meta_json, '$.primaryPosition')`
- Window functions over partitioned data: `RANK() OVER (PARTITION BY team_id ORDER BY total_prospect_fv DESC)`

## State of the data

This is a **single-developer hobby project**, not a production warehouse. The data is refreshed periodically via Python scripts (see `~/Coding Projects/mlb-analytics/*.py`); there's no streaming pipeline, no formal schema registry, and column names sometimes drift across CSVs. Treat all "tables" below as snapshots — they're what the analyst loads into their head, not what a CREATE TABLE would lock down.
