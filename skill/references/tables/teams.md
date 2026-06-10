# Team-level tables

## `TEAM_COLORS`

**Description:** The canonical 30-team list (with one alias duplicate). Used for div lookups, display colors, and as the seed for any "iterate over all teams" loop.

**Approximate row count:** 31 — includes both `"Oakland Athletics"` AND `"Athletics"` as keys (the alias problem).

**Primary key:** Team display name (string).

**Key fields:**

| Field | Type | Description |
|---|---|---|
| `<team>` | STRING | The hex color used for the team's accent in the constellation / diamond view |

**Sample:**
```js
TEAM_COLORS['New York Yankees'] = '#0c2e5e';
TEAM_COLORS['Los Angeles Dodgers'] = '#005a9c';
TEAM_COLORS['Athletics'] = '#003831';            // the one prospects use
TEAM_COLORS['Oakland Athletics'] = '#003831';    // legacy alias — skip in rank loops
```

---

## `TEAM_PAYROLL_2026`

**Description:** Spotrac's official 2026 active-roster payroll dollars per team. Refreshed via `fetch_team_payrolls.py`.

**Approximate row count:** 30 (no alias duplicate here — uses "Athletics" only).

**Primary key:** Team name (string).

**Sample:**
```js
TEAM_PAYROLL_2026['Los Angeles Dodgers'] = 298000000;   // $298M
TEAM_PAYROLL_2026['Athletics'] = 89000000;
```

---

## `TEAM_DIVISION`

**Description:** Maps each team to its division.

**Approximate row count:** 30 + alias.

**Sample:**
```js
TEAM_DIVISION['New York Yankees'] = 'AL East';
TEAM_DIVISION['Cincinnati Reds'] = 'NL Central';
```

---

## `CBT_THRESHOLDS`

**Description:** Competitive Balance Tax thresholds by year, with all four bands.

**Structure:**
```js
const CBT_THRESHOLDS = {
  2026: { first: 244e6, second: 264e6, third: 284e6, fourth: 304e6 },
  2027: { ... },
  2028: { ... }
};
```

**Use:**
- The Outlook panel highlights which CBT band a team is in
- The Matchmaker panel ranks trade fits by available room under each threshold
- The What-If sandbox simulates a sign / trade and recomputes the new band

---

## The Athletics alias problem

This is the single biggest gotcha in the team-level data.

**The team that plays in Sacramento is called:**
- `"Athletics"` — in prospect rows, in TEAM_PAYROLL_2026
- `"Oakland Athletics"` — in TEAM_COLORS (legacy), in some CSV team fields

**`_canonTeam(name)` is supposed to unify them, but doesn't always succeed.**

**Rule of thumb:**
- For team-rank loops (farm rank, payroll rank, etc.), iterate `Object.keys(TEAM_COLORS)` and **explicitly skip `"Oakland Athletics"`**.
- For player-team filtering, use `_canonTeam(player.team)` and compare to `_canonTeam(target_team)`.

**See:** `_computeEffectiveFarmRanks()` (mlb_pitchers.html line ~40246) and the payroll IIFE at line ~41106.

---

## Sample queries

```sql
-- Team payroll vs CBT first threshold
SELECT t.team, t.payroll_2026,
  244e6 - t.payroll_2026 AS room_under_first_cbt
FROM `mlb_index.team_payroll` t
WHERE t.team != 'Oakland Athletics'
ORDER BY room_under_first_cbt DESC;

-- Distribute team prospect FV by division
SELECT division,
  COUNT(DISTINCT team) AS teams,
  ROUND(SUM(fv), 1) AS total_prospect_fv,
  ROUND(AVG(fv), 2) AS avg_prospect_fv
FROM `mlb_index.prospects` p
JOIN `mlb_index.team_division` d ON p.team = d.team
WHERE p.team != 'Oakland Athletics'
GROUP BY division
ORDER BY total_prospect_fv DESC;
```

---

## Proposed BigQuery schema

```sql
CREATE OR REPLACE TABLE `mlb_index.teams` (
  team               STRING      NOT NULL,    -- canonical name
  legacy_alias       STRING,                  -- "Oakland Athletics" for the A's
  abbreviation       STRING,                  -- "NYY", "LAD"
  division           STRING,                  -- "AL East", "NL Central"
  league             STRING,                  -- "AL" / "NL"
  accent_color_hex   STRING,                  -- "#0c2e5e"
  payroll_2026       FLOAT64                  -- Spotrac dollar amount
);

CREATE OR REPLACE TABLE `mlb_index.cbt_thresholds` (
  year    INT64       NOT NULL,
  band    STRING      NOT NULL,    -- 'first' / 'second' / 'third' / 'fourth'
  amount  FLOAT64     NOT NULL
);
```

The single `team` row replaces the dual `"Athletics"` / `"Oakland Athletics"` key issue.
