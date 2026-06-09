# TODO

## Code cleanup — dead/bloated code (deferred)

Audited 2026-06-09. **Decision: hold off on deleting** — total savings (~506 KB,
~1.8% of `index.html`) is not significant enough to justify the risk right now.
Revisit if/when the file is being reworked or the savings become worthwhile.

All findings verified: zero call sites / zero references outside their declaration.
Named IIFEs (`(function foo(){...})()`) were explicitly excluded — they run on load.

### Dead data constants in `index.html` (~462 KB)

Declared via `JSON.parse(...)`, referenced nowhere else in the file.

| Const | Line | Size | Note |
|---|---|---|---|
| `HITTER_VS_PTYPE` | ~2793 | ~240 KB | Looks like data wired up for a feature never built/removed. Confirm before deleting. |
| `HITTER_SPRAY_SPLITS` | ~2795 | ~155 KB | Same — confirm not needed soon. |
| `HITTER_TWO_STRIKE` | ~2794 | ~65 KB | Same. |
| `PARK_FACTORS` | ~11502 | ~1.2 KB | |
| `CATCHER_THROWING` | ~2831 | 43 B | Empty placeholder: `JSON.parse("{}")`. |
| `PITCHER_PICKOFF` | ~2832 | 42 B | Empty placeholder: `JSON.parse("{}")`. |

### Dead functions in `index.html` (~11 KB)

Declared, zero call sites (not IIFEs).

| Function | Line | Size |
|---|---|---|
| `renderFVCascadePanel` | ~6427 | ~9.7 KB |
| `getHaloTexture` | ~25266 | ~718 B |
| `setRoleFilter` | ~26811 | ~711 B |
| `ipToDecimal` | ~3475 | ~133 B |

### Orphaned favicon files (~33 KB)

Only the `-v6` set + `favicon.ico` are referenced in `index.html`. These 18 are not:

```
favicon-180-v3.png  favicon-180-v4.png  favicon-180-v5.png  favicon-180.png
favicon-32-v3.png   favicon-32-v4.png   favicon-32-v5.png   favicon-32.png
favicon-48-v4.png   favicon-48.png      favicon-64-v3.png   favicon-64-v4.png
favicon-64.png      favicon-v2.svg      favicon-v3.svg      favicon-v4.svg
favicon-v5.svg      favicon.svg
```

### Minor / not counted

- Duplicate `_holoShimmer` `<style>` string at ~lines 10155 and 47155 (~110 B).
  May be intentional (two separately-injected panels) — leave unless verified safe.

**Total if all removed: ~506 KB (~0.49 MB).** Line numbers are approximate
(single-file edits will shift them); re-grep by name before acting.
