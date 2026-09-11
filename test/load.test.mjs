/**
 * Load-layer tests for the browser half.
 *
 * The bundle is a classic script, so it is evaluated here with a fake
 * `window`/`document`. Every assertion that claims "the code did X" also counts
 * the calls that prove it, because the expensive failure mode this suite exists
 * to catch is a branch that silently early-returns (the reference plugin shipped
 * a broken nav glyph twice while its suite stayed green for exactly that reason).
 *
 * @module dsh-token-stats/test/load
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Minimal element good enough for the bundle's DOM use. */
function makeElement(tag, scans) {
  return {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    attributes: {},
    dataset: {},
    textContent: '',
    isConnected: true,
    parentNode: null,
    firstElementChild: null,
    children: [],
    setAttribute(name, value) { this.attributes[name] = String(value); },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    remove() { this.isConnected = false; },
    querySelectorAll() { scans.subtree += 1; return []; },
  };
}

/** Count rendered elements carrying one exact class name. */
function classCount(node, name) {
  let total = 0;
  const visit = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return;
    if (Array.isArray(current)) { for (const child of current) visit(child); return; }
    const cls = current.props === undefined ? undefined : current.props.className;
    if (typeof cls === 'string' && cls.split(' ').includes(name)) total += 1;
    visit(current.children);
  };
  visit(node);
  return total;
}

/** A settings nav row as the shell renders it: an svg followed by the label. */
function makeNavRow(scans, label) {
  const button = makeElement('button', scans);
  button.firstElementChild = makeElement('svg', scans);
  button.textContent = label;
  return button;
}

/**
 * Evaluate the bundle against a fake page and run `apply`.
 * @param activeLocale - locale id the fake locale service reports.
 * @returns captured module, registrations, style tags and scan counters.
 */
function loadClient(activeLocale = 'zh') {
  const scans = { subtree: 0, doc: 0 };
  const styleTags = [];
  const observers = [];
  let callback = null;
  let captured = null;
  const timers = [];

  const doc = {
    nodeType: 9,
    body: makeElement('body', scans),
    head: { appendChild: (tag) => { styleTags.push(tag); } },
    createElement: (tag) => makeElement(tag, scans),
    querySelectorAll: () => { scans.doc += 1; return []; },
  };

  class FakeObserver {
    constructor(fn) { callback = fn; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }

  const win = { __ModuleLoader__: { load: (m) => { captured = m; } } };
  new Function('window', 'document', 'MutationObserver', 'setTimeout', 'clearTimeout', source)(
    win,
    doc,
    FakeObserver,
    (fn) => { timers.push(fn); return timers.length; },
    () => {},
  );

  const localeRegisters = [];
  const registrations = [];
  const injected = [];
  const effects = [];
  const ctx = {
    effect(fn, label) { const dispose = fn(); effects.push({ label, dispose }); return dispose; },
    slots: {
      inject(name, thunk) { injected.push(name); thunk(); },
      register(registration, component) { registrations.push(Object.assign({}, registration, { component })); return registration; },
    },
    locale: {
      getSnapshot: () => ({ active: activeLocale, locales: [{ id: 'en' }, { id: 'zh' }] }),
      register: (ns, id, dict) => { localeRegisters.push({ ns, id, dict }); return () => {}; },
      bind: () => undefined,
      subscribe: () => () => {},
    },
  };

  const mod = captured.factory((name) => {
    if (name === 'react') {
      return {
        // A descriptor, not an empty object: the render smoke test walks these
        // trees, so the shim has to preserve structure.
        createElement: (type, props, ...children) => ({ type, props: props === null || props === undefined ? {} : props, children }),
        useState: (initial) => [initial, () => {}],
        useRef: (initial) => ({ current: initial === undefined ? null : initial }),
        useEffect: () => {},
      };
    }
    throw new Error('unexpected require: ' + name);
  });
  mod.apply(ctx);

  return { mod, doc, scans, styleTags, observers, timers, fire: (records) => callback(records), registrations, localeRegisters, injected, effects, fake: (label) => makeNavRow(scans, label) };
}

test('the bundle registers itself under the package name', () => {
  const loaded = loadClient();
  assert.equal(loaded.mod.apply !== undefined, true);
  assert.equal(loaded.injected.length, 1);
  assert.deepEqual(loaded.injected, ['settings.section']);
});

test('the client registers one settings section with the agreed contract', () => {
  const loaded = loadClient('zh');
  assert.equal(loaded.registrations.length, 1, 'exactly one settings.section registration');
  const registration = loaded.registrations[0];
  assert.equal(registration.name, 'settings.section');
  assert.equal(registration.id, 'token-stats');
  assert.equal(registration.order, 40);
  assert.equal(typeof registration.label, 'function', 'label must be a thunk so it recomputes on locale change');
  assert.equal(registration.label(), '用量统计');
  assert.equal(typeof registration.component, 'function', 'the panel component must be a function');
});

test('the section label follows the active locale', () => {
  assert.equal(loadClient('en').registrations[0].label(), 'Usage');
  assert.equal(loadClient('en-US').registrations[0].label(), 'Usage');
  assert.equal(loadClient('zh-CN').registrations[0].label(), '用量统计');
});

test('both locale dictionaries register and stay in sync', () => {
  const loaded = loadClient();
  const ids = loaded.localeRegisters.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ['en', 'zh']);
  assert.equal(loaded.localeRegisters[0].ns, 'dsh-token-stats');
  const en = loaded.localeRegisters.find((entry) => entry.id === 'en').dict;
  const zh = loaded.localeRegisters.find((entry) => entry.id === 'zh').dict;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en and zh must cover the same keys');
  assert.equal(en.title, 'Usage');
  assert.equal(zh.title, '用量统计');
});

test('the stylesheet is injected and tied to the fiber', () => {
  const loaded = loadClient();
  assert.equal(loaded.styleTags.length, 1);
  assert.equal(loaded.styleTags[0].dataset.plugin, 'dsh-token-stats');
  const css = loaded.styleTags[0].textContent;
  assert.equal(typeof css, 'string');
  assert.ok(css.includes('button[data-dsh-token-stats-nav] > svg{display:none}'), 'nav glyph rule must be present');
  assert.ok(css.includes('mask:url("data:image/svg+xml;utf8,'), 'nav glyph must be a mask so it follows state colours');
  const styleEffect = loaded.effects.find((entry) => entry.label.includes('stylesheet'));
  assert.ok(styleEffect !== undefined, 'the style tag must hang on ctx.effect');
  styleEffect.dispose();
  assert.equal(loaded.styleTags[0].isConnected, false, 'disposing the fiber must remove the style tag');
});

test('the stylesheet uses theme tokens and no literal colours', () => {
  const loaded = loadClient();
  const css = loaded.styleTags[0].textContent;
  // The mask data URI carries stroke='black' on purpose: a mask only reads
  // alpha, and the visible colour comes from background-color:currentColor.
  const withoutDataUris = css.replace(/url\("data:[^"]*"\)/g, 'url(data-uri)');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(withoutDataUris), 'no hex colours outside the mask');
  assert.ok(!/\brgba?\(/.test(withoutDataUris), 'no rgb()/rgba() colours');
  assert.ok(!/[:,]\s*(white|black)\b/i.test(withoutDataUris), 'no named colours');
  assert.ok(withoutDataUris.includes('var(--dsw-alias-'), 'colours must come from alias tokens');
  assert.ok(!/[^-]dsw-alias-[a-z0-9-]+\s*:/.test(withoutDataUris.replace(/var\(--dsw-alias-[a-z0-9-]+\)/g, 'TOKEN')), 'no self-declared token names');
});

test('every class name carries the plugin prefix', () => {
  const loaded = loadClient();
  // The mask data URI embeds xmlns='http://www.w3.org/2000/svg', so it has to be
  // removed before scanning for class selectors.
  const css = loaded.styleTags[0].textContent.replace(/url\("data:[^"]*"\)/g, 'url(data-uri)');
  const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]);
  assert.ok(classes.length > 20, 'the stylesheet should declare the panel classes');
  for (const name of classes) {
    assert.ok(name.startsWith('dts-'), 'unprefixed class in the stylesheet: ' + name);
  }
});

test('the nav row is marked synchronously from the mutation that inserted it', () => {
  const loaded = loadClient();
  assert.equal(loaded.observers.length, 1, 'an observer must actually be created');
  const row = loaded.fake('用量统计');
  const container = makeElement('div', loaded.scans);
  container.querySelectorAll = () => { loaded.scans.subtree += 1; return [row]; };

  const subtreeScansBefore = loaded.scans.subtree;
  const docScansBefore = loaded.scans.doc;
  loaded.fire([{ addedNodes: [container] }]);

  assert.ok(row.hasAttribute('data-dsh-token-stats-nav'), 'the row must be marked by the observer callback');
  assert.equal(loaded.scans.subtree, subtreeScansBefore + 1, 'the callback must scan the inserted subtree');
  assert.equal(loaded.scans.doc, docScansBefore, 'the mount path must not walk the whole document');
});

test('steady state short-circuits without scanning', () => {
  const loaded = loadClient();
  const row = loaded.fake('用量统计');
  const container = makeElement('div', loaded.scans);
  container.querySelectorAll = () => { loaded.scans.subtree += 1; return [row]; };
  loaded.fire([{ addedNodes: [container] }]);

  const subtreeScans = loaded.scans.subtree;
  const docScans = loaded.scans.doc;
  for (let i = 0; i < 50; i += 1) {
    loaded.fire([{ addedNodes: [makeElement('div', loaded.scans)] }]);
  }
  assert.equal(loaded.scans.subtree, subtreeScans, 'a marked row must make the hot path exit immediately');
  assert.equal(loaded.scans.doc, docScans, 'steady state must not scan the document');
});

test('a label inserted as a text node still marks its row', () => {
  const loaded = loadClient();
  const row = makeElement('button', loaded.scans);
  row.firstElementChild = makeElement('svg', loaded.scans);
  row.textContent = '';
  const text = { nodeType: 3, parentNode: row };
  loaded.fire([{ addedNodes: [text] }]);
  assert.ok(!row.hasAttribute('data-dsh-token-stats-nav'), 'an unlabelled row is not ours');

  row.textContent = '用量统计';
  loaded.fire([{ addedNodes: [{ nodeType: 3, parentNode: row }] }]);
  assert.ok(row.hasAttribute('data-dsh-token-stats-nav'), 'a text-node label must resolve to its enclosing button');
});

test('the observer and its backstop timer are disposed with the fiber', () => {
  const loaded = loadClient();
  const navEffect = loaded.effects.find((entry) => entry.label.includes('nav glyph'));
  assert.ok(navEffect !== undefined);
  navEffect.dispose();
  assert.equal(loaded.observers[0].disconnected, true, 'the observer must be disconnected');
});

test('chart series use the categorical static ramp, never a theme-neutral alias', () => {
  const loaded = loadClient();
  const css = loaded.styleTags[0].textContent;
  // Regression: the first version painted data series with
  // --dsw-alias-brand-primary, which the theme resolves to a near-black neutral
  // in the light theme and a near-white one in the dark theme, so every chart
  // rendered as black and white. Series colours must come from the fixed
  // --dsw-static-* ramps instead.
  const seriesRules = css.split('}').filter((rule) => /\.dts-(c\d|lv\d|line|dot(?!-empty)|trend-bar|week-bar|donut-(slice|shadow))/.test(rule));
  assert.ok(seriesRules.length >= 12, 'expected the series/level rules to be present, found ' + seriesRules.length);
  for (const rule of seriesRules) {
    assert.ok(!rule.includes('--dsw-alias-brand-primary'), 'a series colour must not be the brand alias: ' + rule);
    assert.ok(!rule.includes('--dsw-alias-label-'), 'a series colour must not be a text colour: ' + rule);
    assert.ok(!rule.includes('--dsw-alias-state-'), 'a series colour must not be a semantic state colour: ' + rule);
  }
  assert.ok(css.includes('.dts-c0{fill:var(--dsw-static-blue-400);color:var(--dsw-static-blue-400)}'));
  assert.ok(css.includes('.dts-c8{fill:var(--dsw-static-neutral-400)'), 'the folded tail needs its own readable slice');
  assert.ok(/\.dts-cell\[data-future="1"\]\{[^}]*border:1px dashed/.test(css), 'future days must keep a visible slot');
  assert.ok(/\.dts-heat-weekdays span\{[^}]*flex:1 1 0/.test(css), 'weekday labels must share the cell rows\u2019 height');
  assert.ok(!/\.dts-heat-weekdays span\{[^}]*height:12px/.test(css), 'fixed-height weekday labels cannot track square cells');
  // Regression: .dts-swatch had no background at all, so every legend swatch was
  // an invisible 8x8 box.
  assert.ok(/\.dts-swatch\{[^}]*background-color:currentColor/.test(css), 'legend swatches must paint themselves');
  // The ring's separators and depth must be token-painted too, with no literal.
  assert.ok(css.includes('.dts-donut-slice{stroke:var(--dsw-alias-bg-layer-3)'), 'the ring separators must match the card surface');
  assert.ok(css.includes('.dts-donut-shadow-node{flood-color:var(--dsw-static-neutral-1000)'), 'the ring needs a token shadow');
  assert.ok(!/\.dts-(pie-3d|rim-)/.test(css), 'the removed extrusion/rim styling must not linger');
});

test('surfaces match the shell settings cards verbatim', () => {
  const loaded = loadClient();
  const css = loaded.styleTags[0].textContent;
  // Read out of dsh-client-ui-settings-plugins:
  //   .card{border:.5px solid var(--dsw-alias-border-l4);
  //         background:var(--dsw-alias-bg-layer-3);border-radius:16px}
  // Two earlier attempts got this wrong in opposite directions: first a
  // bg-layer-1 surface with a border (the shell's *input* treatment), then a
  // borderless module-platform surface at 12px. Both read as a different design.
  for (const name of ['dts-card', 'dts-section']) {
    const start = css.indexOf('.' + name + '{');
    assert.ok(start >= 0, 'expected a rule for .' + name);
    const text = css.slice(start, css.indexOf('}', start) + 1);
    assert.ok(text.includes('border:.5px solid var(--dsw-alias-border-l4)'), name + ' must use the shell hairline: ' + text);
    assert.ok(text.includes('background:var(--dsw-alias-bg-layer-3)'), name + ' must use the shell surface: ' + text);
    assert.ok(text.includes('border-radius:16px'), name + ' must use the shell radius: ' + text);
  }
  assert.ok(/\.dts-input\{[^}]*height:32px/.test(css), 'inputs follow the shell 32px control height');
});

test('the smoothed line never overshoots its own data', () => {
  const { __test } = loadClient().mod;
  assert.equal(__test.smoothPath([[0, 10], [10, 20]]), 'M 0.00 10.00 L 10.00 20.00', 'two points stay a straight line');
  const flat = __test.smoothPath([[0, 100], [10, 100], [20, 100], [30, 100]]);
  for (const match of flat.matchAll(/C ([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9.]+)/g)) {
    assert.equal(Number(match[2]), 100, 'a flat series must stay flat');
    assert.equal(Number(match[4]), 100, 'a flat series must stay flat');
  }
  // Every control point's y must stay inside the segment it belongs to, which is
  // what keeps a cumulative curve from dipping below a value it never had.
  const points = [[0, 100], [10, 90], [20, 95], [30, 40], [40, 42]];
  const path = __test.smoothPath(points);
  const controls = [...path.matchAll(/C ([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9.]+)/g)];
  assert.equal(controls.length, points.length - 1, 'one cubic segment per gap');
  for (let i = 0; i < controls.length; i += 1) {
    const low = Math.min(points[i][1], points[i + 1][1]);
    const high = Math.max(points[i][1], points[i + 1][1]);
    for (const y of [Number(controls[i][2]), Number(controls[i][4])]) {
      assert.ok(y >= low - 0.01 && y <= high + 0.01, 'control point ' + y + ' escaped [' + low + ', ' + high + ']');
    }
  }
});

/**
 * Every chart body must actually execute.
 *
 * The load layer only ever called `apply`, so a component that referenced a
 * renamed helper, mis-ordered a hook, or divided by an empty array would have
 * kept the whole suite green while the panel rendered nothing.
 */
test('every chart renders a synthetic payload and emits its primitives', () => {
  const { __test } = loadClient().mod;
  const t = (key) => {
    const value = __test.ZH[key];
    return value === undefined ? key : value;
  };
  const payload = {
    generatedAt: 0,
    scope: { sessions: 3, failed: 0, retired: 0, seeded: 0 },
    models: [
      { key: 'p/alpha', provider: 'p', model: 'alpha', name: 'Alpha', buckets: [300, 40, 900, 0] },
      { key: 'p/beta', provider: 'p', model: 'beta', name: 'Beta', buckets: [120, 30, 400, 0] },
      { key: '__other__', provider: '', model: '', name: '', buckets: [5, 5, 5, 0] },
    ],
    days: [
      { d: '2026-09-04', b: [10, 2, 30, 0], m: [[0, 10, 2, 30, 0]] },
      { d: '2026-09-05', b: [400, 60, 1200, 0], m: [[0, 400, 30, 900, 0], [1, 0, 30, 300, 0]] },
      { d: '2026-09-06', b: [15, 13, 75, 0], m: [[1, 10, 8, 70, 0], [2, 5, 5, 5, 0]] },
    ],
    range: { first: '2026-09-04', last: '2026-09-06' },
  };
  const model = __test.prepare(payload);
  assert.equal(model.days.length, 3);

  /** Walk a rendered tree and collect every element/primitive type used. */
  const types = (node, seen = []) => {
    if (node === null || node === undefined || node === false) return seen;
    if (Array.isArray(node)) {
      for (const child of node) types(child, seen);
      return seen;
    }
    if (typeof node !== 'object') return seen;
    seen.push(typeof node.type === 'string' ? node.type : 'Component');
    types(node.children, seen);
    return seen;
  };
  const countOf = (list, name) => list.filter((entry) => entry === name).length;

  const days = __test.eachDay('2026-09-04', '2026-09-06');
  const cases = [
    ['Heatmap', { t, model, metric: 'all' }, ['div']],
    ['WeeklyBars', { t, model, metric: 'all' }, ['svg', 'rect']],
    ['TrendChart', { t, model, metric: 'all', days }, ['svg', 'path', 'rect', 'circle']],
    ['DonutChart', { t, model, metric: 'all', days }, ['svg', 'path', 'text']],
  ];
  for (const [name, props, expected] of cases) {
    const element = __test.components[name](props);
    assert.ok(element !== null && element !== undefined, name + ' returned nothing');
    const seen = types(element);
    for (const primitive of expected) {
      assert.ok(seen.includes(primitive), name + ' did not emit any <' + primitive + '> (saw ' + [...new Set(seen)].join(',') + ')');
    }
  }

  // Content checks: a chart that renders the right tags but no data is still broken.
  const donut = types(__test.components.DonutChart({ t, model, metric: 'all', days }));
  assert.ok(countOf(donut, 'path') >= 2, 'the ring must draw a segment per model');
  const heat = types(__test.components.Heatmap({ t, model, metric: 'all' }));
  // Unmeasured (the shim exposes no ResizeObserver) the grid assumes a typical
  // card. Count real cells, not the structural wrappers around them: the legend
  // adds five cells of its own, and the rest must be whole weeks.
  const heatCells = classCount(__test.components.Heatmap({ t, model, metric: 'all' }), 'dts-cell');
  assert.ok(heatCells >= 12 * 7, 'the heatmap must cover at least 12 weeks of cells, saw ' + heatCells);
  assert.ok(heatCells <= 53 * 7, 'the heatmap window must stay bounded, saw ' + heatCells);
  assert.equal(heatCells % 7, 0, 'the grid must be whole weeks, saw ' + heatCells);
  assert.ok(countOf(heat, 'div') > 0);
  const weekly = types(__test.components.WeeklyBars({ t, model, metric: 'all' }));
  // One bar plus one full-height hover target per week, empty weeks included,
  // and the SAME week count as the daily grid — that is what keeps the two
  // views' time ranges aligned and the bars wide.
  const sharedWeeks = __test.heatmapWeeks(0);
  assert.equal(countOf(weekly, 'rect'), sharedWeeks * 2, 'the weekly view must share the daily window, saw ' + countOf(weekly, 'rect'));
  assert.ok(sharedWeeks < 53, 'the shared window must be narrower than a fixed year, saw ' + sharedWeeks);
  const cumulative = null;
  void cumulative;
  const trend = types(__test.components.TrendChart({ t, model, metric: 'all', days }));
  assert.ok(countOf(trend, 'path') >= 2, 'one polyline per model with data');
  // One baseline plus a tick mark per labelled x (three buckets here).
  assert.ok(countOf(trend, 'line') >= 3, 'the axis must draw tick marks, saw ' + countOf(trend, 'line'));
  assert.ok(trend.filter((entry) => entry === 'circle').length >= 3, 'empty buckets keep a muted marker');
});

test('the panel arranges its sections and keeps the notes outside them', () => {
  const { __test } = loadClient().mod;
  const t = (key) => (__test.ZH[key] === undefined ? key : __test.ZH[key]);
  const payload = {
    generatedAt: 0,
    scope: { sessions: 2, failed: 0, retired: 0, seeded: 0 },
    models: [
      { key: 'p/a', provider: 'p', model: 'a', name: 'Alpha', buckets: [10, 2, 30, 0] },
      { key: 'p/b', provider: 'p', model: 'b', name: 'Beta', buckets: [4, 1, 9, 0] },
    ],
    days: [{ d: '2026-09-05', b: [14, 3, 39, 0], m: [[0, 10, 2, 30, 0], [1, 4, 1, 9, 0]] }],
    range: { first: '2026-09-05', last: '2026-09-05' },
  };
  __test.seedPayload(payload);
  const Panel = __test.createPanel({}, { translate: t, subscribeLocale: () => () => {} });
  const tree = Panel();

  const all = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    all.push(node);
    walk(node.children);
  };
  walk(tree);

  const withClass = (name) => all.filter((node) => {
    const cls = node.props === undefined ? undefined : node.props.className;
    return typeof cls === 'string' && cls.split(' ').includes(name);
  });
  const contains = (node, name) => {
    let found = false;
    const visit = (current) => {
      if (found || current === null || current === undefined || typeof current !== 'object') return;
      if (Array.isArray(current)) { for (const child of current) visit(child); return; }
      const cls = current.props === undefined ? undefined : current.props.className;
      if (typeof cls === 'string' && cls.split(' ').includes(name)) { found = true; return; }
      visit(current.children);
    };
    visit(node);
    return found;
  };
  const textOf = (node) => {
    let out = '';
    const visit = (current) => {
      // A string is not an object, so this has to be tested before the early
      // return or the walker silently collects nothing.
      if (typeof current === 'string') { out += current; return; }
      if (current === null || current === undefined || typeof current !== 'object') return;
      if (Array.isArray(current)) { for (const child of current) visit(child); return; }
      visit(current.children);
    };
    visit(node);
    return out;
  };
  // Sections: the scale block plus the shared model block.
  assert.equal(withClass('dts-section').length, 2, 'expected exactly two cards');
  assert.equal(withClass('dts-subsection').length, 2, 'the model card holds two sub-blocks');
  // Cards are components, so they are counted by type and read from props: a
  // direct call to Panel() returns elements, it does not render them.
  const cards = all.filter((node) => node.type === __test.components.Card);
  assert.equal(cards.length, 6, 'the dashboard carries six figures, saw ' + cards.length);
  const labels = cards.map((node) => node.props.label);
  for (const key of ['statLifetime', 'statPeak', 'statToday', 'statWeek', 'statDailyAvg', 'statCacheShare']) {
    assert.ok(labels.includes(__test.ZH[key]), 'the dashboard is missing ' + key);
  }
  // The corpus itself moved to the footnote, where a skipped session stays
  // visible because it shrinks every total.
  assert.ok(!labels.includes(__test.ZH.statSessions), 'the session count is no longer a headline figure');
  assert.ok(!labels.includes('活跃天数'), 'active days is carried by the daily-average card instead');
  const modelCard = withClass('dts-section').find((node) => contains(node, 'dts-subsection'));
  assert.ok(modelCard !== undefined, 'the model section must contain both sub-blocks');
  assert.ok(contains(modelCard, 'dts-heat') === false, 'the daily grid belongs to the other card');
  // Regression: a misplaced paren silently moved the footnotes inside the model
  // card, which no other test could see.
  assert.ok(!contains(modelCard, 'dts-note'), 'the footnotes must sit outside every card');
  assert.equal(withClass('dts-note').length, 3, 'three footnotes must render');
  const notes = textOf(all.find((node) => node.props && node.props.className === 'dts-root'));
  assert.ok(notes.includes('输入+输出'), 'the renamed metric must appear in the note');
  assert.ok(notes.includes('趋势') && notes.includes('占比'), 'the shortened sub-titles must render');
  assert.ok(notes.includes('分模型用量'), 'the shared section title must render');
  assert.ok(notes.includes('粒度'), 'the active granularity must be reported');
});
test('the trend granularity follows the range', () => {
  const { __test } = loadClient().mod;
  assert.equal(__test.granularityFor(1), 'day');
  assert.equal(__test.granularityFor(31), 'day');
  assert.equal(__test.granularityFor(32), 'week');
  assert.equal(__test.granularityFor(180), 'week');
  assert.equal(__test.granularityFor(181), 'month');
  assert.equal(__test.granularityFor(730), 'month');
  assert.equal(__test.granularityFor(731), 'year');

  const days = __test.eachDay('2026-01-01', '2026-12-31');
  assert.equal(__test.bucketize(days, 'day').length, days.length);
  const weeks = __test.bucketize(days, 'week');
  assert.ok(weeks.length >= 52 && weeks.length <= 54, 'a year is ~53 weeks, got ' + weeks.length);
  assert.ok(weeks.every((bucket) => bucket.keys.length >= 1), 'every bucket keeps its days');
  assert.equal(weeks.reduce((a, bucket) => a + bucket.keys.length, 0), days.length, 'no day may be dropped');
  const months = __test.bucketize(days, 'month');
  assert.equal(months.length, 12);
  assert.deepEqual(months[0], { key: '2026-01', label: '2026-01', keys: __test.eachDay('2026-01-01', '2026-01-31') });
  assert.equal(__test.bucketize(days, 'year').length, 1);
  assert.deepEqual(__test.tickIndices(5, 3), [0, 2, 4]);
  assert.deepEqual(__test.tickIndices(1, 6), [0]);
  assert.deepEqual(__test.tickIndices(0, 6), []);
  assert.ok(__test.tickIndices(53, 6).length <= 6);
});

test('the heatmap column count trades window length for block size', () => {
  const { __test } = loadClient().mod;
  // The whole point: a narrow card shows fewer weeks so each block stays
  // legible, instead of squeezing 53 columns into ~10px blocks.
  assert.ok(__test.heatmapWeeks(1600) === 53, 'a very wide card shows the full year');
  assert.ok(__test.heatmapWeeks(820) >= 30 && __test.heatmapWeeks(820) <= 40, 'a typical card shows ~9 months');
  assert.ok(__test.heatmapWeeks(500) < __test.heatmapWeeks(820), 'narrower cards show fewer weeks');
  assert.equal(__test.heatmapWeeks(120), 12, 'the window floor keeps a narrow card readable');
  assert.equal(__test.heatmapWeeks(0), __test.heatmapWeeks(820), 'an unmeasured grid assumes a typical card');
  // Cell pitch stays in a legible band across every realistic width.
  for (const width of [300, 500, 700, 820, 1000, 1400]) {
    const weeks = __test.heatmapWeeks(width);
    const cell = (width - 16 - (weeks - 1) * 3) / weeks;
    assert.ok(cell >= 8 && cell <= 40, 'cell pitch ' + cell.toFixed(1) + 'px at ' + width + 'px is out of band');
  }
});

/**
 * Both perceived waits this round is about came from the same place: the panel
 * used to restart from zero width and from a stale aggregate on every mount.
 * These two tests pin the width half — the slot reserves a stable height and a
 * remount begins from the last real measurement instead of the 820px fallback.
 */
test('the day-scale views share one measured slot that reserves their height', () => {
  const { __test } = loadClient().mod;
  const t = (key) => (__test.ZH[key] === undefined ? key : __test.ZH[key]);
  const payload = {
    generatedAt: 0,
    scope: { sessions: 1, failed: 0, retired: 0, seeded: 0 },
    models: [{ key: 'p/a', provider: 'p', model: 'a', name: 'Alpha', buckets: [10, 2, 30, 0] }],
    days: [{ d: '2026-09-05', b: [10, 2, 30, 0], m: [[0, 10, 2, 30, 0]] }],
    range: { first: '2026-09-05', last: '2026-09-05' },
  };
  __test.seedPayload(payload);
  // What a second mount of the panel sees: the width the last one measured.
  __test.seedMeasuredWidth(560);
  const Panel = __test.createPanel({}, { translate: t, subscribeLocale: () => () => {} });
  const tree = Panel();

  const all = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    all.push(node);
    walk(node.children);
  };
  walk(tree);

  const slot = all.filter((node) => node.props && node.props.className === 'dts-viewslot');
  assert.equal(slot.length, 1, 'both day-scale views must share exactly one slot');
  assert.equal(slot[0].props.style.minHeight, __test.viewSlotHeight(560) + 'px', 'the slot height must follow the remembered width');
  assert.equal(__test.measuredWidth(), 560, 'rendering must not reset the remembered width');
  const daily = all.filter((node) => node.type === __test.components.Heatmap);
  assert.equal(daily.length, 1, 'the daily grid is the default view');
  assert.equal(daily[0].props.width, 560, 'the view must be handed the slot\u2019s shared measurement');

  // The reserved height always covers the weekly chart, whose SVG is 170px
  // tall, so swapping views cannot move the sections below the slot.
  for (const width of [0, 300, 560, 820, 1184, 1600]) {
    assert.ok(__test.viewSlotHeight(width) >= 170, 'the slot is shorter than the weekly chart at ' + width + 'px');
  }
  // A typical settings card: both views measure ~170px, so the reservation is
  // the truthful height rather than slack.
  assert.equal(__test.viewSlotHeight(0), 170);
  assert.equal(__test.viewSlotHeight(820), 170);
  assert.ok(__test.viewSlotHeight(1600) > 170, 'a very wide card grows the square cells and must reserve for them');
});

test('the two day-scale views derive one window from a passed width', () => {
  const { __test } = loadClient().mod;
  const t = (key) => (__test.ZH[key] === undefined ? key : __test.ZH[key]);
  const model = __test.prepare({ generatedAt: 0, scope: {}, models: [], days: [], range: { first: null, last: null } });
  const countOf = (node, name, seen = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return seen;
    if (Array.isArray(node)) { for (const child of node) countOf(child, name, seen); return seen; }
    if (node.type === name) seen.push(node);
    countOf(node.children, name, seen);
    return seen;
  };
  for (const width of [420, 560, 900]) {
    const weeks = __test.heatmapWeeks(width);
    const cells = countOf(__test.components.Heatmap({ t, model, metric: 'all', width }), 'div').filter((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('dts-cell'));
    const bars = countOf(__test.components.WeeklyBars({ t, model, metric: 'all', width }), 'rect');
    assert.equal(cells.length, weeks * 7, 'the daily grid must use the passed width at ' + width + 'px');
    assert.equal(bars.length, weeks * 2, 'the weekly view must use the same window at ' + width + 'px');
  }
});

/**
 * The other half of the perceived wait: the host answers a cached aggregate at
 * once and rescans behind the response, so the panel has to follow up. These
 * pin the follow-up decision, including its bound.
 */
test('a stale answer is followed up a bounded number of times', () => {
  const { __test } = loadClient().mod;
  const last = __test.STALE_MAX_TRIES;
  assert.ok(last >= 3, 'the follow-ups must cover a multi-second rescan, saw ' + last);
  assert.equal(__test.staleFollowUp({ stale: true, days: [] }, 0), true, 'a stale answer needs another request');
  assert.equal(__test.staleFollowUp({ stale: true, days: [] }, last - 1), true, 'the retries are not cut short');
  assert.equal(__test.staleFollowUp({ stale: true, days: [] }, last), false, 'the follow-ups must stop');
  assert.equal(__test.staleFollowUp({ stale: false, days: [] }, 0), false, 'a fresh answer is final');
  assert.equal(__test.staleFollowUp({ ok: false, error: 'boom' }, 0), false, 'a failure is not retried into a poll');
  assert.equal(__test.staleFollowUp(null, 0), false, 'a missing value must not schedule anything');
});

test('the ring path closes an annulus', () => {
  const { __test } = loadClient().mod;
  assert.equal(__test.ringPath(50, 50, 40, 24, 0, Math.PI * 2), null, 'a full circle is drawn as a stroked circle instead');
  const path = __test.ringPath(50, 50, 40, 24, 0, Math.PI / 2);
  assert.equal(typeof path, 'string');
  assert.ok(path.startsWith('M '));
  assert.ok(path.includes('A 40 40') && path.includes('A 24 24'), 'both the outer and inner arcs must be present');
  assert.ok(path.trim().endsWith('Z'), 'the ring segment must be closed');
});

test('unit-scaled formatting follows the active locale', () => {
  const { __test } = loadClient().mod;
  const zh = (key) => ({ units: [[1e12, '万亿'], [1e8, '亿'], [1e4, '万'], [1e3, '千']] })[key];
  const en = (key) => ({ units: [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] })[key];
  assert.equal(__test.formatUnits(999, zh), '999');
  assert.equal(__test.formatUnits(1500, zh), '1.5千');
  assert.equal(__test.formatUnits(45670, zh), '4.57万');
  assert.equal(__test.formatUnits(123456789, zh), '1.23亿');
  assert.equal(__test.formatUnits(1234567890123, zh), '1.23万亿', 'larger magnitudes must not fall back to raw digits');
  assert.equal(__test.formatUnits(1500, en), '1.5K');
  assert.equal(__test.formatUnits(45670000, en), '45.7M');
  assert.equal(__test.formatUnits(1234567890, en), '1.23B');
  assert.equal(__test.formatUnitsExact(45670, zh), '4.57万\uff08' + __test.formatFull(45670) + '\uff09');
  assert.equal(__test.formatUnitsExact(999, zh), '999', 'below the first unit the exact number is already shown');
  assert.equal(__test.formatUnits(1234, () => undefined), __test.formatFull(1234), 'a locale with no unit table falls back to grouping');
});

test('the all-inclusive metric matches the provider accumulator', () => {
  const { __test } = loadClient().mod;
  assert.equal(__test.metricOf([10, 2, 5, 1], 'all'), 18);
  assert.equal(__test.metricOf([10, 2, 5, 1], 'total'), 12);
  assert.equal(__test.metricOf([10, 2, 5, 1], 'cacheWrite'), 1);
});

test('pure helpers behave as the charts rely on them', () => {
  const { __test } = loadClient().mod;
  assert.equal(__test.NS, pkg.name);
  assert.equal(__test.CHANNEL, '/token-stats');
  assert.equal(__test.formatFull(1234567).replace(/\u00a0|,|\s/g, ''), '1234567');
  assert.equal(__test.dayKeyOf(new Date(2026, 8, 10)), '2026-09-10');
  assert.deepEqual(__test.eachDay('2026-01-30', '2026-02-02'), ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  assert.deepEqual(__test.eachDay('2026-03-01', '2026-02-01'), [], 'an inverted range yields nothing');
  assert.equal(__test.parseDay('2026-09-10').getMonth(), 8);
  assert.equal(__test.metricOf([10, 2, 5, 1], 'total'), 12);
  assert.equal(__test.metricOf([10, 2, 5, 1], 'cacheRead'), 5);
  assert.equal(__test.colorClass(0), 'dts-c0');
  assert.equal(__test.colorClass(99), 'dts-c8', 'the palette must clamp rather than invent classes');
  const max = 264790000;
  assert.equal(__test.intensityOf(0, max), 0, 'no usage draws nothing');
  assert.equal(__test.intensityOf(max, max), 1, 'the busiest day is fully saturated');
  assert.equal(__test.intensityOf(max * 2, max), 1, 'above the anchor clamps to full');
  assert.equal(__test.intensityOf(1, 0), 0, 'nothing to scale against means nothing painted');
  assert.equal(__test.intensityOf(100, max), __test.intensityOf(100, max), 'the mapping is deterministic');
  for (const pair of [[1000, 100000], [100000, 10000000], [10000000, 200000000]]) {
    assert.ok(__test.intensityOf(pair[1], max) > __test.intensityOf(pair[0], max), 'intensity must increase with usage');
  }
  // The regression that killed the logarithmic scale: on real data the two
  // busiest days were 111M and 265M — a 153M gap — and log put them 0.07 apart,
  // which is invisible. A power law keeps that separation.
  const second = __test.intensityOf(111570000, max);
  assert.ok(1 - second > 0.2, 'a day 2.4x smaller than the peak must be clearly lighter, saw ' + (1 - second).toFixed(3));
  // ...while ordinary days still differ from each other, which pure linear
  // scaling cannot do (15M vs 26M would be 0.04 apart).
  const ordinaryLow = __test.intensityOf(14960000, max);
  const ordinaryHigh = __test.intensityOf(25890000, max);
  assert.ok(ordinaryHigh - ordinaryLow > 0.05, 'ordinary days must stay distinguishable, saw ' + (ordinaryHigh - ordinaryLow).toFixed(3));
  assert.ok(ordinaryLow > 0.15, 'a day with usage must never look empty');
});

test('prepare indexes the payload the way the charts read it', () => {
  const { __test } = loadClient().mod;
  const payload = {
    generatedAt: 0,
    scope: { sessions: 2, failed: 0 },
    models: [{ key: 'p/a', provider: 'p', model: 'a', name: 'A', buckets: [3, 4, 5, 6] }],
    days: [
      { d: '2026-09-09', b: [1, 2, 3, 4], m: [[0, 1, 2, 3, 4]] },
      { d: '2026-09-10', b: [2, 2, 2, 2], m: [[0, 2, 2, 2, 2]] },
    ],
    range: { first: '2026-09-09', last: '2026-09-10' },
  };
  const model = __test.prepare(payload);
  assert.equal(model.days.length, 2);
  assert.equal(model.activeDays, 2);
  assert.equal(model.first, '2026-09-09');
  assert.equal(model.byDay.get('2026-09-10').b[0], 2);
  assert.deepEqual(model.byDay.get('2026-09-10').m.get(0), [2, 2, 2, 2]);

  const label = (key) => __test.modelLabel({ key, name: key }, (k) => k);
  assert.equal(label('p/a'), 'p/a');
  assert.equal(__test.modelLabel({ key: '__other__' }, (k) => (k === 'other' ? 'other' : k)), 'other');
  assert.equal(__test.modelLabel({ key: '__unknown__' }, (k) => (k === 'unknown' ? 'unknown' : k)), 'unknown');
});

test('range presets are anchored on today, not on the last recorded day', () => {
  const { __test } = loadClient().mod;
  const today = new Date();
  const todayKey = __test.dayKeyOf(today);
  const week = __test.presetRange('7', { first: '2020-01-01', last: '2020-01-02' });
  assert.equal(week.to, todayKey);
  assert.equal(__test.eachDay(week.from, week.to).length, 7);
  const month = __test.presetRange('30', { first: null, last: null });
  assert.equal(__test.eachDay(month.from, month.to).length, 30);
  const year = __test.presetRange('year', { first: null, last: null });
  assert.equal(year.from, today.getFullYear() + '-01-01');
  const all = __test.presetRange('all', { first: '2026-01-01', last: '2026-02-01' });
  assert.deepEqual(all, { from: '2026-01-01', to: '2026-02-01' });
});
