// Runtime UI verification for the "UI audit fixes" commit.
// Loads index.html in headless Chromium and asserts each change works live:
//   • SP/RP/OF tab counts are driven by the live data pools (not stale HTML)
//   • OF/IF tables are wrapped in a scrollable .table-wrap
//   • the IF "compare" box points at the populated if-compare-names datalist
//   • _evOrd() renders correct ordinals (1st/2nd/3rd/11th/21st/101st)
//   • the floating AI chat panel opens on <body>, stays on-screen (incl. a
//     stale off-screen saved position), and closes on Escape
//
// Usage:  node verify_ui.mjs
//   Requires Playwright + a Chromium build. If Chromium lives outside the
//   default cache, point to it:  PLAYWRIGHT_BROWSERS_PATH=/path node verify_ui.mjs
//
// The page's CDN libs (Plotly/THREE/3d-force-graph) are stubbed before load so
// the app boots without network — see addInitScript below.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

// Resolve Playwright whether it's a local dep or installed globally.
// Set PLAYWRIGHT_BROWSERS_PATH if your Chromium lives outside the default cache.
const require = createRequire(import.meta.url);
let chromium;
for (const spec of ['playwright', 'playwright-core']) {
  try { ({ chromium } = require(spec)); break; } catch { /* try next */ }
}
if (!chromium) {
  try {
    const gRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = require(path.join(gRoot, 'playwright')));
  } catch { /* fall through */ }
}
if (!chromium) {
  console.error('Could not load Playwright. Install it (npm i -D playwright) and its Chromium binary.');
  process.exit(2);
}

const FILE = pathToFileURL(path.resolve('index.html')).href;
const results = [];
const pageErrors = [];
const consoleErrors = [];

function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// The page pulls Plotly / THREE / 3d-force-graph from CDNs that are
// unreachable in this sandbox. In production they load fine; here we inject
// recursive no-op stubs so the app boots and we can verify the real code.
// (Without this, an unguarded top-level Plotly call halts the main script.)
await page.addInitScript(() => {
  const handler = {
    get: (_t, p) => (p === 'then' || typeof p === 'symbol') ? undefined : new Proxy(function () {}, handler),
    apply: () => new Proxy(function () {}, handler),
    construct: () => new Proxy(function () {}, handler),
  };
  const stub = () => new Proxy(function () {}, handler);
  // Real Plotly attaches an `.on` method to the chart div after newPlot/react;
  // app code relies on `div.on('plotly_click', …)`. Replicate just that so the
  // unguarded top-level chart wiring doesn't throw and halt the main script.
  const attachOn = el => {
    const node = typeof el === 'string' ? document.getElementById(el) : el;
    if (node && typeof node === 'object') node.on = node.on || function () {};
    return Promise.resolve(node);
  };
  const plotly = { newPlot: attachOn, react: attachOn, purge: () => {}, Plots: { resize: () => {} } };
  window.Plotly = new Proxy(plotly, { get: (t, p) => (p in t ? t[p] : () => {}) });
  window.THREE = stub();
  window.ForceGraph3D = stub();
  window.ForceGraph = stub();
  window.gtag = function () {};
});

await page.goto(FILE, { waitUntil: 'load', timeout: 60000 });
// Wait until the app has booted its data pools + run the tab-count wiring.
await page.waitForFunction(
  // The badge is only populated after the tab-count wiring runs, which itself
  // requires ALL & RP_ALL to be initialized — so a numeric badge is proof the
  // pools are ready. (Probing ALL/RP_ALL directly risks a TDZ ReferenceError
  // while the big script is still executing.)
  () => {
    const sp = document.getElementById('sp-tab-count');
    const rp = document.getElementById('rp-tab-count');
    return sp && rp && /^\d+$/.test(sp.textContent.trim()) && /^\d+$/.test(rp.textContent.trim());
  },
  { timeout: 60000 }
);

// ── 1. Tab counts driven by live pools ────────────────────────────────
const counts = await page.evaluate(() => {
  // Global `const` pools live in the global lexical environment, which a
  // Playwright evaluate wrapper can't see as bare identifiers. An *indirect*
  // eval runs in true global scope, where they resolve.
  const gget = name => { try { return (0, eval)(name + '.length'); } catch { return undefined; } };
  return {
    sp: document.getElementById('sp-tab-count')?.textContent.trim(),
    rp: document.getElementById('rp-tab-count')?.textContent.trim(),
    of: document.getElementById('of-tab-count')?.textContent.trim(),
    if: document.getElementById('if-tab-count')?.textContent.trim(),
    ALL: gget('ALL'), RP_ALL: gget('RP_ALL'),
    ALL_OF: gget('ALL_OF'), ALL_IF: gget('ALL_IF'),
  };
});
check('SP tab count == ALL.length', String(counts.sp) === String(counts.ALL), `badge=${counts.sp} pool=${counts.ALL}`);
check('RP tab count == RP_ALL.length', String(counts.rp) === String(counts.RP_ALL), `badge=${counts.rp} pool=${counts.RP_ALL}`);
check('OF tab count == ALL_OF.length', String(counts.of) === String(counts.ALL_OF), `badge=${counts.of} pool=${counts.ALL_OF}`);
check('IF tab count is numeric & present', /^\d+$/.test(counts.if || ''), `badge=${counts.if}`);

// ── 2. OF/IF tables wrapped in .table-wrap ────────────────────────────
const wraps = await page.evaluate(() => ({
  of: document.getElementById('of-table')?.parentElement?.classList.contains('table-wrap'),
  if: document.getElementById('if-table')?.parentElement?.classList.contains('table-wrap'),
  ofOverflowX: getComputedStyle(document.getElementById('of-table').parentElement).overflowX,
}));
check('OF table wrapped in .table-wrap', wraps.of);
check('IF table wrapped in .table-wrap', wraps.if);
check('.table-wrap has overflow-x scroll/auto', ['auto', 'scroll'].includes(wraps.ofOverflowX), `overflow-x=${wraps.ofOverflowX}`);

// ── 3. if-compare points at the populated IF datalist ─────────────────
const cmp = await page.evaluate(() => {
  const inp = document.getElementById('if-compare');
  const dl = document.getElementById('if-compare-names');
  return {
    list: inp?.getAttribute('list'),
    opts: dl ? dl.options.length : -1,
    sample: dl && dl.options.length ? dl.options[0].value : null,
  };
});
check('if-compare list == "if-compare-names"', cmp.list === 'if-compare-names', `list=${cmp.list}`);
check('if-compare-names datalist is populated', cmp.opts > 0, `${cmp.opts} options (e.g. ${cmp.sample})`);

// ── 4. _evOrd ordinal correctness ─────────────────────────────────────
const ord = await page.evaluate(() => {
  let f = window._evOrd;
  if (typeof f !== 'function') { try { f = (0, eval)('_evOrd'); } catch {} }
  if (typeof f !== 'function') return { ok: false, bad: ['_evOrd not reachable'] };
  const cases = { 1:'1st', 2:'2nd', 3:'3rd', 4:'4th', 11:'11th', 12:'12th', 13:'13th',
                  21:'21st', 22:'22nd', 23:'23rd', 50:'50th', 100:'100th', 101:'101st', 111:'111th' };
  const bad = [];
  for (const [n, exp] of Object.entries(cases)) if (f(Number(n)) !== exp) bad.push(`${n}->${f(Number(n))} (want ${exp})`);
  return { ok: bad.length === 0, bad };
});
check('_evOrd produces correct ordinals', ord.ok, ord.ok ? '1st/2nd/3rd/11th/21st/101st all correct' : ord.bad?.join(', '));

// ── 5. AI panel: normal open is fully on-screen & child of <body> ──────
const aiNormal = await page.evaluate(async () => {
  if (!window.MLB_AI) return { exists: false, noApi: true };
  localStorage.removeItem('mlb_ai_panelpos');
  document.getElementById('holo-ai-chat')?.remove();
  window.MLB_AI.render('settings');
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const p = document.getElementById('holo-ai-chat');
  if (!p) return { exists: false };
  const r = p.getBoundingClientRect();
  return {
    exists: true,
    parentIsBody: p.parentElement === document.body,
    onScreen: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.right > r.left + 100,
    rect: { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }, vw: window.innerWidth,
  };
});
check('AI panel opens', aiNormal.exists);
check('AI panel is a child of <body>', aiNormal.parentIsBody);
check('AI panel fully on-screen (not clipped to left edge)', aiNormal.onScreen,
  `rect=${JSON.stringify(aiNormal.rect)} vw=${aiNormal.vw}`);

// ── 6. AI panel: stale off-screen saved position gets clamped back ────
const aiClamp = await page.evaluate(async () => {
  if (!window.MLB_AI) return { onScreen: false, noApi: true };
  document.getElementById('holo-ai-chat')?.remove();
  localStorage.setItem('mlb_ai_panelpos', JSON.stringify({ left: 99999, top: 99999 }));
  window.MLB_AI.render('settings');
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const p = document.getElementById('holo-ai-chat');
  const r = p.getBoundingClientRect();
  return {
    onScreen: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
    rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right) },
    vw: window.innerWidth, vh: window.innerHeight,
  };
});
check('Stale off-screen AI position is clamped into viewport', aiClamp.onScreen,
  `rect=${JSON.stringify(aiClamp.rect)} vw=${aiClamp.vw} vh=${aiClamp.vh}`);

// ── 7. Escape closes the AI panel ─────────────────────────────────────
await page.keyboard.press('Escape');
const closed = await page.evaluate(() => !document.getElementById('holo-ai-chat'));
check('Escape closes the AI panel', closed);

// ── Console / page errors ─────────────────────────────────────────────
check('No uncaught page exceptions', pageErrors.length === 0,
  pageErrors.length ? pageErrors.slice(0, 5).join(' | ') : 'clean');

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${'='.repeat(60)}\n${results.length - failed.length}/${results.length} checks passed.`);
if (consoleErrors.length) {
  console.log(`\nNote: ${consoleErrors.length} console.error message(s) during load (often expected from blocked external API calls under file://):`);
  console.log('  ' + [...new Set(consoleErrors)].slice(0, 6).join('\n  '));
}
process.exit(failed.length ? 1 : 0);
