/**
 * dsh-token-stats — browser half.
 *
 * NOT an ES module. A DSH client bundle is a classic script registering one
 * lazy-CJS factory on the page-global facade:
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * `id` must equal the package name. `require` resolves only against the
 * platform module table, this row's `dsh.client.external` suppliers, and other
 * registered bundles — which is why every chart below is hand-drawn inline SVG
 * rather than a charting library.
 *
 * The host half is reached over a plain same-origin POST; each answer is a
 * `{ok:true,value}` / `{ok:false,error}` envelope.
 *
 * @module dsh-token-stats/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-stats',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** Route prefix owned by the host half; must match lib/index.js. */
    const CHANNEL = '/token-stats';

    /** Locale namespace for this panel's dictionary. */
    const NS = 'dsh-token-stats';

    /** Marker attribute this bundle puts on its own settings nav row. */
    const NAV_ATTR = 'data-dsh-token-stats-nav';

    /**
     * Backstop delay for re-checking the whole document for the settings nav row.
     *
     * The row is normally marked synchronously from the very mutation that
     * inserted it (see the observer in `apply`), which is what keeps the shell's
     * gear fallback from being painted at all. This timer only covers a row that
     * somehow arrives outside the subtree a mutation showed us, so it can afford
     * to be slow.
     */
    const NAV_SWEEP_MS = 400;

    /**
     * Bar-chart glyph for the settings nav row, as a percent-encoded SVG mask.
     *
     * Drawn to fill the 16x16 box to roughly the same extent as the shipped
     * outline icons, and painted with `background-color: currentColor` so it
     * follows the nav row's normal, hover and active colours for free.
     */
    const NAV_ICON_SVG =
      "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'"
      + " stroke='black' stroke-width='1.35' stroke-linecap='round' stroke-linejoin='round'%3E"
      + "%3Cpath d='M2 13.4h12'/%3E"
      + "%3Cpath d='M4.7 13.4V9.1'/%3E%3Cpath d='M8 13.4V4.6'/%3E%3Cpath d='M11.3 13.4V7.3'/%3E"
      + "%3C/svg%3E";

    /** Metric identifiers shared with the host payload's bucket order. */
    const METRIC_INDEX = { input: 0, output: 1, cacheRead: 2, cacheWrite: 3 };

    /** Model keys the host reserves for folded slices. */
    const OTHER_KEY = '__other__';
    const UNKNOWN_KEY = '__unknown__';

    /** Everything the panel can say, in both locales. */
    const EN = {
      title: 'Usage',
      loading: 'Reading session logs…',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      updated: 'Updated',
      statLifetime: 'Lifetime tokens',
      statPeak: 'Peak day',
      statSessions: 'Sessions',
      statToday: 'Today',
      statWeek: 'Last 7 days',
      statDailyAvg: 'Daily average',
      statDailyAvgBasis: 'per active day',
      statCacheShare: 'Cache read share',
      statCacheShareBasis: 'of all tokens',
      metric: 'Metric',
      metricAll: 'Total',
      metricTotal: 'Input + output',
      metricInput: 'Input',
      metricOutput: 'Output',
      metricCacheRead: 'Cache read',
      metricCacheWrite: 'Cache write',
      scale: 'Scale',
      viewDaily: 'Daily',
      viewWeekly: 'Weekly',
      modelUsageTitle: 'Usage by model',
      granularityPrefix: 'Granularity',
      granularityDay: 'by day',
      granularityWeek: 'by week',
      granularityMonth: 'by month',
      granularityYear: 'by year',
      heatmapTitle: 'Daily usage',
      weeklyTitle: 'Weekly usage',
      donutTotal: 'Total',
      trendTitle: 'Trend',
      pieTitle: 'Share',
      range: 'Range',
      range7: '7 days',
      range30: '30 days',
      range90: '90 days',
      rangeYear: 'This year',
      rangeAll: 'All time',
      other: 'Other models',
      unknown: 'Unattributed',
      noData: 'No token usage recorded yet.',
      incomplete: 'sessions could not be read and were skipped',
      retained: 'retained after removal',
      metricNote: 'Total = uncached input + output + cache read + cache write, matching the provider\u2019s own totalTokens. Input + output excludes cache reads, which on a warm session dominate by a wide margin.',
      metricNoteNoCacheWrite: 'Total = uncached input + output + cache read, matching the provider\u2019s own totalTokens. Input + output excludes cache reads, which on a warm session dominate by a wide margin. No cache-write usage is reported through this deployment, so that metric stays hidden.',
      dailyNote: 'Daily buckets use this machine\u2019s local timezone. Totals include sessions whose logs are no longer listed, so cleaning up history does not shrink them.',
      weekdays: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
      months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      tokens: 'tokens',
      // Largest-first so the first match wins; 1e3 is a unit here because the
      // request was explicit about 千 / 万 / 亿.
      units: [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']],
    };

    const ZH = {
      title: '用量统计',
      loading: '正在读取会话日志…',
      refresh: '刷新',
      refreshing: '刷新中…',
      updated: '更新于',
      statLifetime: '累计用量',
      statPeak: '单日峰值',
      statSessions: '会话数',
      statToday: '今日用量',
      statWeek: '近 7 天',
      statDailyAvg: '日均用量',
      statDailyAvgBasis: '按活跃天',
      statCacheShare: '缓存读占比',
      statCacheShareBasis: '占总量',
      metric: '计量口径',
      metricAll: '总量（含缓存）',
      metricTotal: '输入+输出',
      metricInput: '输入',
      metricOutput: '输出',
      metricCacheRead: '缓存读',
      metricCacheWrite: '缓存写',
      scale: '粒度',
      viewDaily: '每日',
      viewWeekly: '每周',
      modelUsageTitle: '分模型用量',
      granularityPrefix: '粒度',
      granularityDay: '按天',
      granularityWeek: '按周',
      granularityMonth: '按月',
      granularityYear: '按年',
      heatmapTitle: '每日用量',
      weeklyTitle: '每周用量',
      donutTotal: '合计',
      trendTitle: '趋势',
      pieTitle: '占比',
      range: '范围',
      range7: '近 7 天',
      range30: '近 30 天',
      range90: '近 90 天',
      rangeYear: '今年',
      rangeAll: '全部',
      other: '其他模型',
      unknown: '无归属',
      noData: '暂无用量记录。',
      incomplete: '个会话无法读取，已跳过',
      retained: '个已移除但保留计数',
      metricNote: '「总量（含缓存）」= 未缓存输入 + 输出 + 缓存读 + 缓存写，与提供方上报的 totalTokens 口径一致；「输入+输出」不含缓存读 —— 热会话里缓存读往往是它的几十倍。',
      metricNoteNoCacheWrite: '「总量」= 未缓存输入 + 输出 + 缓存读，与提供方上报的 totalTokens 口径一致；「输入+输出」不含缓存读 —— 热会话里缓存读往往是它的几十倍。本环境没有任何缓存写用量上报，因此该口径不显示。',
      dailyNote: '每日归属按本机本地时区切分。已从列表移除但日志仍在的会话继续计入，所以清理历史不会让累计数字变小。',
      weekdays: ['一', '二', '三', '四', '五', '六', '日'],
      months: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
      tokens: 'tokens',
      units: [[1e12, '万亿'], [1e8, '亿'], [1e4, '万'], [1e3, '千']],
    };

    /**
     * Stylesheet, assembled as an array so a unit test can assert single rules.
     * Every colour is a host alias token; every class carries the `dts-` prefix.
     */
    const CSS = [
      '.dts-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font:inherit}',
      '.dts-head{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:12px;padding:12px 0;background:var(--dsw-alias-bg-layer-2)}',
      '.dts-head-title{font-size:13px;line-height:20px;font-weight:600}',
      '.dts-head-right{margin-left:auto;display:flex;align-items:center;gap:8px}',
      '.dts-updated{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      // A quiet pulse instead of a spinner: the panel keeps showing the last
      // figures while the host rescans, so there is nothing to block on.
      '.dts-refreshing{display:inline-flex;align-items:center;gap:5px}',
      '.dts-refreshing::before{content:"";width:5px;height:5px;border-radius:50%;background-color:var(--dsw-static-blue-400);animation:dts-pulse 1.1s ease-in-out infinite}',
      '@keyframes dts-pulse{0%,100%{opacity:.2}50%{opacity:1}}',
      '.dts-body{display:flex;flex-direction:column;gap:10px;padding-bottom:24px}',
      '.dts-btn{font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 12px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .16s,background .16s}',
      '.dts-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dts-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dts-btn[disabled]{opacity:.4;cursor:default}',
      '.dts-btn[disabled]:hover{background:transparent}',
      '.dts-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px}',
      // Surfaces copied verbatim from the shell's own settings cards:
      // `.card{border:.5px solid var(--dsw-alias-border-l4);
      //        background:var(--dsw-alias-bg-layer-3);border-radius:16px}`
      // read out of dsh-client-ui-settings-plugins. A 12px radius, no outline, or
      // the module-platform surface each read as a different design next to the
      // shipped settings pages.
      '.dts-card{border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3);padding:14px 16px}',
      '.dts-card-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dts-card-value{font-size:20px;line-height:28px;font-variant-numeric:tabular-nums;margin-top:2px}',
      '.dts-card-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
      '.dts-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dts-row-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-right:2px}',
      '.dts-seg{display:inline-flex;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;overflow:hidden}',
      '.dts-seg-btn{font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .16s,color .16s}',
      '.dts-seg-btn:hover{color:var(--dsw-alias-label-secondary)}',
      '.dts-seg-btn[data-on="1"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dts-seg-btn:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dts-input{font:inherit;font-size:13px;line-height:20px;height:32px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);transition:border-color .16s,box-shadow .16s}',
      '.dts-input:focus-visible{outline:none;border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dts-section{border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3);padding:14px 16px;display:flex;flex-direction:column;gap:14px}',
      '.dts-subsection{display:flex;flex-direction:column;gap:10px}',
      // The shell separates settings rows with a border-l2 hairline; the same
      // divider keeps the two model-scoped charts visibly distinct without a
      // second card.
      '.dts-subsection+.dts-subsection{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}',
      '.dts-section-title{font-size:13px;line-height:20px;font-weight:600}',
      '.dts-status{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);padding:8px 0}',
      '.dts-error{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);padding:8px 0}',
      '.dts-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}',
      // The slot holds whichever day-scale view is selected. Its min-height is
      // set inline from viewSlotHeight(), so swapping the two views changes
      // nothing about the space they occupy.
      '.dts-viewslot{position:relative;width:100%}',
      '.dts-chart-wrap{position:relative;width:100%}',
      '.dts-chart{display:block;width:100%;overflow:visible}',
      // An instant tooltip, fixed to the viewport: SVG <title> is a native
      // browser tooltip with a ~1s delay that cannot be styled, and a tooltip
      // positioned inside the scroll container got clipped as soon as it reached
      // the panel edge, so it could not be read near the right border at all.
      '.dts-tip{position:fixed;z-index:40;pointer-events:none;transform:translate(-50%,calc(-100% - 10px));white-space:nowrap;padding:6px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;box-shadow:0 2px 8px var(--dsw-alias-bg-mask-drop)}',
      '.dts-tip-head{color:var(--dsw-alias-label-secondary)}',
      '.dts-tip-row{display:flex;align-items:center;gap:6px}',
      '.dts-tip-value{margin-left:auto;font-variant-numeric:tabular-nums}',
      '.dts-axis{font-size:10px;fill:var(--dsw-alias-label-tertiary)}',
      '.dts-grid{stroke:var(--dsw-alias-border-l1);stroke-width:.5}',
      // A tick per labelled x, so every time-series chart shows the same
      // structure even where no data was recorded.
      '.dts-tick{stroke:var(--dsw-alias-border-l1);stroke-width:.5}',
      '.dts-dot-empty{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:1;opacity:.55}',
      '.dts-trend-bar,.dts-donut-slice,.dts-week-bar,.dts-dot,.dts-cell{transition:opacity .16s}',
      '.dts-trend-bar:hover,.dts-donut-slice:hover,.dts-week-bar:hover{opacity:.75}',
      '.dts-swatch{flex:none;width:8px;height:8px;border-radius:2px;background-color:currentColor}',
      '.dts-legend{display:flex;flex-direction:column;gap:6px;min-width:180px}',
      '.dts-legend-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}',
      '.dts-legend-name{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dts-legend-value{margin-left:auto;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dts-pie-wrap{display:flex;align-items:center;gap:20px;flex-wrap:wrap}',
      '.dts-donut-total{font-size:15px;line-height:20px;font-weight:600;fill:var(--dsw-alias-label-primary)}',
      '.dts-donut-total-label{font-size:10px;line-height:14px;fill:var(--dsw-alias-label-tertiary)}',
      '.dts-donut-slice{stroke:var(--dsw-alias-bg-layer-3);stroke-width:1.5;cursor:default}',
      '.dts-heat{display:flex;flex-direction:column;gap:4px}',
      '.dts-heat-months{display:flex;gap:3px;width:100%;font-size:10px;line-height:12px;color:var(--dsw-alias-label-tertiary)}',
      // The month row mirrors the grid exactly: one gutter column plus one cell
      // per week column, so labels cannot drift away from their columns.
      '.dts-heat-gutter,.dts-heat-weekdays{flex:none;width:16px;margin-right:2px}',
      '.dts-heat-month{flex:1 1 0;min-width:0;overflow:hidden;white-space:nowrap}',
      // Columns share the width evenly so the grid fills the card and the newest
      // day sits flush right; the cell size follows from that, which keeps a
      // 53-week window at roughly GitHub's own cell pitch.
      '.dts-heat-grid{display:flex;gap:3px;width:100%;align-items:stretch}',
      '.dts-heat-col{display:flex;flex-direction:column;gap:3px;flex:1 1 0;min-width:0}',
      // The weekday column divides the same height into the same 7 rows, so a
      // label lines up with its row at any cell size. Fixed-height labels were
      // the reason they drifted once the cells became square.
      '.dts-heat-weekdays{display:flex;flex-direction:column;gap:3px;font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary)}',
      '.dts-heat-weekdays span{flex:1 1 0;min-height:0;display:flex;align-items:center;justify-content:flex-end;padding-right:3px}',
      '.dts-heat-gutter{height:12px}',
      '.dts-cell{width:100%;aspect-ratio:1/1;box-sizing:border-box;border-radius:2px;background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}',
      // Days that have not happened yet keep their slot but are drawn as an
      // outline, so the grid reads as "calendar continues" rather than as
      // missing data.
      '.dts-cell[data-future="1"]{background:transparent;box-shadow:none;border:1px dashed var(--dsw-alias-border-l2);opacity:.75}',
      '.dts-cell:hover{opacity:.72}',
      // One hue, with the depth carried by an inline opacity computed from the
      // value (see intensityOf).
      '.dts-cell-on{background:var(--dsw-static-blue-400);box-shadow:none}',
      // Categorical chart palette. These must NOT be the semantic alias tokens:
      // --dsw-alias-brand-primary resolves to a near-black neutral in the light
      // theme and a near-white one in the dark theme, so a chart built on it
      // reads as black-and-white. The shell also publishes fixed `--dsw-static-*`
      // ramps, which are stable across both themes and are what a data series
      // needs. The 400-level steps are used first because the 500s read as
      // over-saturated against the shell's own muted surfaces.
      '.dts-c0{fill:var(--dsw-static-blue-400);color:var(--dsw-static-blue-400)}',
      '.dts-c1{fill:var(--dsw-static-amber-400);color:var(--dsw-static-amber-400)}',
      '.dts-c2{fill:var(--dsw-static-green-400);color:var(--dsw-static-green-400)}',
      '.dts-c3{fill:var(--dsw-static-red-400);color:var(--dsw-static-red-400)}',
      '.dts-c4{fill:var(--dsw-static-deepseek-450);color:var(--dsw-static-deepseek-450)}',
      '.dts-c5{fill:var(--dsw-static-blue-300);color:var(--dsw-static-blue-300)}',
      '.dts-c6{fill:var(--dsw-static-amber-500);color:var(--dsw-static-amber-500)}',
      '.dts-c7{fill:var(--dsw-static-green-500);color:var(--dsw-static-green-500)}',
      '.dts-c8{fill:var(--dsw-static-neutral-400);color:var(--dsw-static-neutral-400)}',
      '.dts-donut-shadow-node{flood-color:var(--dsw-static-neutral-1000);flood-opacity:.16}',
      '.dts-line{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
      '.dts-dot{stroke:var(--dsw-alias-bg-layer-3);stroke-width:1;fill:currentColor}',
      'button[' + NAV_ATTR + '] > svg{display:none}',
      'button[' + NAV_ATTR + ']::before{content:"";flex:none;width:16px;height:16px;background-color:currentColor;'
        + "-webkit-mask:url(\"data:image/svg+xml;utf8," + NAV_ICON_SVG + "\") center/contain no-repeat;"
        + "mask:url(\"data:image/svg+xml;utf8," + NAV_ICON_SVG + "\") center/contain no-repeat}",
    ].join('');

    /**
     * Mark a settings nav row when it is this plugin's.
     *
     * The `settings.section` registration contract carries only id, order and
     * label — there is no icon field — and the shell picks the glyph from a
     * hardcoded if-chain over section ids whose fallback is the settings gear,
     * so a third-party section can never be handed its own glyph. The rendered
     * row carries no attribute naming its section either, so the only reliable
     * match is the label text, in both spellings so a locale change cannot drop
     * the mark.
     *
     * @param button - candidate element.
     * @returns the button when this call marked it, otherwise null.
     */
    function markNavButton(button) {
      if (button.hasAttribute(NAV_ATTR)) return null;
      const first = button.firstElementChild;
      if (first === null || first === undefined) return null;
      if (String(first.tagName).toLowerCase() !== 'svg') return null;
      const label = String(button.textContent || '').trim();
      if (label !== EN.title && label !== ZH.title) return null;
      button.setAttribute(NAV_ATTR, '');
      return button;
    }

    /**
     * Nearest enclosing `<button>`, for a label written into a mounted row.
     * @param node - the node that was inserted.
     * @returns the owning button, or null.
     */
    function enclosingButton(node) {
      let parent = node.parentNode;
      while (parent !== null && parent !== undefined && parent.nodeType === 1) {
        if (String(parent.tagName).toLowerCase() === 'button') return parent;
        parent = parent.parentNode;
      }
      return null;
    }

    /**
     * Mark this plugin's nav row anywhere inside `root`.
     * @param root - a Document or Element to search.
     * @returns the first button marked by this call, otherwise null.
     */
    function markNavRowIn(root) {
      let first = null;
      if (root.nodeType === 1 && String(root.tagName).toLowerCase() === 'button') {
        first = markNavButton(root);
      }
      if (typeof root.querySelectorAll !== 'function') return first;
      for (const button of root.querySelectorAll('button')) {
        const hit = markNavButton(button);
        if (hit !== null && first === null) first = hit;
      }
      return first;
    }

    /** Two-digit zero padding. */
    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /** `YYYY-MM-DD` for a Date, in local time. */
    function dayKeyOf(date) {
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    /** Local-midnight Date for a `YYYY-MM-DD` key. */
    function parseDay(key) {
      const parts = String(key).split('-');
      return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }

    /** Every `YYYY-MM-DD` from `from` through `to`, inclusive. */
    function eachDay(from, to) {
      const out = [];
      const cursor = parseDay(from);
      const end = parseDay(to);
      // A malformed or inverted range must not spin: bound the walk.
      for (let guard = 0; guard < 4000 && cursor <= end; guard += 1) {
        out.push(dayKeyOf(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      return out;
    }

    /** Monday-based day index (0 = Monday) for a Date. */
    function mondayIndex(date) {
      return (date.getDay() + 6) % 7;
    }

    /** Add days to a Date, returning a new Date at local midnight. */
    function addDays(date, days) {
      const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      next.setDate(next.getDate() + days);
      return next;
    }

    /** Selected metric's token count for a four-bucket array. */
    function metricOf(buckets, metric) {
      if (metric === 'all') return buckets[0] + buckets[1] + buckets[2] + buckets[3];
      if (metric === 'total') return buckets[0] + buckets[1];
      const index = METRIC_INDEX[metric];
      return index === undefined ? buckets[0] + buckets[1] : buckets[index];
    }

    /**
     * Unit-scaled token count in the active locale: 1.23亿 / 4,567万 / 8.9千
     * for Chinese, 1.2B / 3.4M / 5.6K for English.
     *
     * The unit table lives in the dictionary, so a locale that has no unit
     * convention simply falls through to a plain grouped number.
     *
     * @param value - token count.
     * @param t - translate function, whose dictionary carries `units`.
     * @returns the scaled string.
     */
    function formatUnits(value, t) {
      const n = Math.round(Number(value) || 0);
      const table = t('units');
      if (Array.isArray(table)) {
        for (const entry of table) {
          const scale = entry[0];
          if (n >= scale) {
            const scaled = n / scale;
            const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
            return String(Number(scaled.toFixed(digits))) + entry[1];
          }
        }
      }
      return formatFull(n);
    }

    /** Unit form plus the exact count, for tooltips. */
    function formatUnitsExact(value, t) {
      const n = Math.round(Number(value) || 0);
      const units = formatUnits(n, t);
      return units === formatFull(n) ? units : units + '\uff08' + formatFull(n) + '\uff09';
    }

    /** Full token count with thousands separators. */
    function formatFull(value) {
      return Math.round(Number(value) || 0).toLocaleString();
    }

    /** Class name for the colour of one model index. */
    function colorClass(index) {
      return 'dts-c' + Math.max(0, Math.min(8, index));
    }

    /** Localized label for one model slice. */
    function modelLabel(model, t) {
      if (model === undefined || model === null) return t('unknown');
      if (model.key === OTHER_KEY) return t('other');
      if (model.key === UNKNOWN_KEY) return t('unknown');
      return model.name && model.name.length > 0 ? model.name : model.key;
    }

    /**
     * Prepare the payload for rendering: index every day and rank the models.
     * @param payload - the host payload.
     * @returns lookup tables, or null when there is nothing to draw.
     */
    function prepare(payload) {
      const models = Array.isArray(payload.models) ? payload.models : [];
      const days = Array.isArray(payload.days) ? payload.days : [];
      const byDay = new Map();
      for (const day of days) {
        const slots = new Map();
        for (const entry of day.m) slots.set(entry[0], [entry[1], entry[2], entry[3], entry[4]]);
        byDay.set(day.d, { b: day.b, m: slots });
      }
      let lifetime = 0;
      let activeDays = 0;
      for (const day of days) {
        const value = day.b[0] + day.b[1];
        lifetime += value;
        if (value > 0) activeDays += 1;
      }
      return { models, days, byDay, lifetime, activeDays, first: payload.range ? payload.range.first : null, last: payload.range ? payload.range.last : null };
    }

    /** Total for one day entry under the selected metric. */
    function dayValue(entry, metric) {
      return entry === undefined ? 0 : metricOf(entry.b, metric);
    }

    /** Total for one model slice inside one day entry. */
    function dayModelValue(entry, index, metric) {
      if (entry === undefined) return 0;
      const buckets = entry.m.get(index);
      return buckets === undefined ? 0 : metricOf(buckets, metric);
    }

    /** Peak day across all recorded days for the selected metric. */
    function peakDay(model, metric) {
      let best = null;
      for (const day of model.days) {
        const value = dayValue(model.byDay.get(day.d), metric);
        if (best === null || value > best.value) best = { day: day.d, value };
      }
      return best;
    }

    /** Sum one metric across a day list for a model index (-1 = all models). */
    function sumDays(model, dayKeys, metric, index) {
      let total = 0;
      for (const key of dayKeys) {
        const entry = model.byDay.get(key);
        if (entry === undefined) continue;
        total += index === undefined || index < 0 ? dayValue(entry, metric) : dayModelValue(entry, index, metric);
      }
      return total;
    }

    /**
     * How colour depth follows a day's usage.
     *
     * Three candidate mappings, and why this one:
     *
     * - **Linear** (`value / max`) is the most intuitive reading — twice as dark
     *   means twice as much — but it crushes everything below the top: with a
     *   265M peak a 15M day sits at 5.6% of the ramp and a 26M day at 9.8%, so
     *   ordinary days all render as the same faint tint.
     * - **Logarithmic** (`log(v) / log(max)`) was tried and rejected on real
     *   data: 8.9k…265M spans 4.5 decades, so the two busiest days (111M and
     *   265M, a 153M gap) landed 8% apart on the ramp — a 0.07 opacity
     *   difference, invisible. A log scale flattens exactly the region a heavy
     *   user is looking at.
     * - **Power law** (`(value / max) ** 0.45`) sits between them: the top end
     *   keeps real separation (265M vs 111M is ~0.27 of the ramp) while a 15M
     *   day still reads clearly lighter than a 26M day.
     *
     * The anchor is the window maximum, so the ramp always spans the data in
     * view. One consequence is worth naming: a single extreme outlier would push
     * every other day toward the floor, which is inherent to any single scale.
     */
    const INTENSITY_GAMMA = 0.45;

    /** Lowest opacity a day with any usage receives, so it never looks empty. */
    const INTENSITY_FLOOR = 0.15;

    /**
     * Colour opacity for one day's usage.
     * @param value - the day's usage under the selected metric.
     * @param highest - the largest day in view (the ramp's anchor).
     * @returns an opacity in `[0, 1]`; 0 means no usage.
     */
    function intensityOf(value, highest) {
      if (!(value > 0)) return 0;
      if (!(highest > 0)) return 0;
      const ratio = Math.min(1, value / highest);
      return INTENSITY_FLOOR + Math.pow(ratio, INTENSITY_GAMMA) * (1 - INTENSITY_FLOOR);
    }

    /** SVG polyline/area path from a list of `[x, y]` points. */
    function linePath(points) {
      if (points.length === 0) return '';
      let d = 'M ' + points[0][0].toFixed(2) + ' ' + points[0][1].toFixed(2);
      for (let i = 1; i < points.length; i += 1) d += ' L ' + points[i][0].toFixed(2) + ' ' + points[i][1].toFixed(2);
      return d;
    }

    /**
     * Smooth path through `points` (Catmull-Rom control points as cubic beziers).
     *
     * The vertical control offsets are clamped into each segment, so the curve is
     * smooth without overshooting its own data — an unclamped spline can dip
     * below a value it interpolates, which on a monotone cumulative curve would
     * draw usage that never happened.
     *
     * @param points - `[x, y]` pairs in order.
     * @returns an SVG path string.
     */
    function smoothPath(points) {
      if (points.length < 3) return linePath(points);
      const tension = 0.2;
      let d = 'M ' + points[0][0].toFixed(2) + ' ' + points[0][1].toFixed(2);
      for (let i = 0; i < points.length - 1; i += 1) {
        const previous = points[i - 1] === undefined ? points[i] : points[i - 1];
        const from = points[i];
        const to = points[i + 1];
        const next = points[i + 2] === undefined ? to : points[i + 2];
        const low = Math.min(from[1], to[1]);
        const high = Math.max(from[1], to[1]);
        const clamp = (value) => Math.min(Math.max(value, low), high);
        const c1x = from[0] + (to[0] - previous[0]) * tension;
        const c1y = clamp(from[1] + (to[1] - previous[1]) * tension);
        const c2x = to[0] - (next[0] - from[0]) * tension;
        const c2y = clamp(to[1] - (next[1] - from[1]) * tension);
        d += ' C ' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2)
          + ' ' + to[0].toFixed(2) + ' ' + to[1].toFixed(2);
      }
      return d;
    }

    /**
     * Resolve a range preset into concrete day keys.
     *
     * Presets are anchored on today rather than on the last recorded day, so
     * "7 days" means the last seven calendar days even when nothing ran today.
     * @param preset - `7` | `30` | `90` | `year` | `all`.
     * @param model - prepared payload.
     * @returns `{ from, to }` day keys.
     */
    function presetRange(preset, model) {
      const today = new Date();
      const todayKey = dayKeyOf(today);
      if (preset === 'all') {
        return { from: model.first === null ? todayKey : model.first, to: model.last === null ? todayKey : model.last };
      }
      if (preset === 'year') return { from: today.getFullYear() + '-01-01', to: todayKey };
      const days = preset === '7' ? 7 : preset === '90' ? 90 : 30;
      return { from: dayKeyOf(addDays(today, -(days - 1))), to: todayKey };
    }

    /**
     * One segmented control.
     * @param props - `label`, `options` (`{value,label}`), `value`, `onChange`.
     * @returns the control element.
     */
    function Segmented(props) {
      return h('div', { className: 'dts-row' },
        props.label === undefined ? null : h('span', { className: 'dts-row-label' }, props.label),
        h('div', { className: 'dts-seg', role: 'group' },
          props.options.map((option) => h('button', {
            key: option.value,
            type: 'button',
            className: 'dts-seg-btn',
            'data-on': option.value === props.value ? '1' : '0',
            'aria-pressed': option.value === props.value,
            onClick: () => props.onChange(option.value),
          }, option.label))));
    }

    /** One statistic card. */
    function Card(props) {
      return h('div', { className: 'dts-card' },
        h('div', { className: 'dts-card-label' }, props.label),
        h('div', { className: 'dts-card-value', title: props.title }, props.value),
        props.sub === undefined ? null : h('div', { className: 'dts-card-sub' }, props.sub));
    }

    /**
     * Instant hover tooltip state for one chart.
     *
     * SVG `<title>` produces a native tooltip with a browser-imposed delay that
     * cannot be shortened or styled, which is why hovering felt sluggish; this
     * renders an owned element at the cursor's column instead.
     *
     * @returns the wrapper ref, the current tip, and the handlers.
     */
    function useTip() {
      const wrap = React.useRef(null);
      const [tip, setTip] = React.useState(null);
      const show = (event, lines) => {
        const target = event.currentTarget.getBoundingClientRect();
        const viewport = typeof window === 'undefined' ? 1280 : window.innerWidth;
        const margin = 100;
        setTip({
          x: Math.min(Math.max(target.left + target.width / 2, margin), Math.max(margin, viewport - margin)),
          y: target.top,
          below: target.top < 72,
          lines,
        });
      };
      const hide = () => setTip(null);
      return { wrap, tip, show, hide };
    }

    /**
     * The last width any chart wrapper reported.
     *
     * It lives at module scope because the settings dialog unmounts the whole
     * panel on close and remounts it on open. A remount used to start from 0,
     * derive a column count from the 820px fallback, and then re-lay the grid
     * out once the real width arrived — one visible flash per open, and another
     * per switch between the daily and weekly view.
     */
    let lastMeasuredWidth = 0;

    // Measuring in a layout effect means the first painted frame already has the
    // real width, so there is no intermediate layout to see. The test shim
    // exposes no `useLayoutEffect`, hence the fallback.
    const useIsoLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;

    /**
     * Measure a chart wrapper so the daily and weekly views can share one
     * time window: both derive their column count from the same width, which is
     * also what keeps their x positions aligned.
     *
     * @param ref - ref to the wrapper element.
     * @returns the measured width in CSS pixels, or the last known one.
     */
    function useMeasuredWidth(ref) {
      const [width, setWidth] = React.useState(lastMeasuredWidth);
      useIsoLayoutEffect(() => {
        const node = ref.current;
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return undefined;
        const measure = () => {
          const rect = node.getBoundingClientRect();
          const next = rect !== undefined && rect !== null && rect.width > 0 ? rect.width : 0;
          // A hidden node reports 0; it must not throw away a good width.
          if (next <= 0) return;
          lastMeasuredWidth = next;
          // A sub-pixel change is not worth a render: React bails out when the
          // updater returns the value it already holds.
          setWidth((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
        };
        measure();
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure);
          observer.observe(node);
          return () => observer.disconnect();
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measure);
          return () => window.removeEventListener('resize', measure);
        }
        return undefined;
      }, []);
      return width;
    }

    /**
     * Render one tooltip. A plain string is a heading; a `[index, label, value]`
     * triple becomes a swatch row.
     * @param tip - the current tooltip state.
     * @returns the tooltip element, or null.
     */
    function renderTip(tip) {
      if (tip === null) return null;
      return h('div', {
        className: 'dts-tip',
        style: {
          left: tip.x + 'px',
          top: tip.y + 'px',
          // Flip below the cursor when there is no room above it.
          transform: tip.below === true ? 'translate(-50%,10px)' : undefined,
        },
      },
      tip.lines.map((line, i) => (Array.isArray(line)
        ? h('div', { key: i, className: 'dts-tip-row' },
          h('span', { className: 'dts-swatch ' + colorClass(line[0]) }),
          h('span', {}, line[1]),
          h('span', { className: 'dts-tip-value' }, line[2]))
        : h('div', { key: i, className: 'dts-tip-head' }, line))));
    }

    /** Wrap a chart body with its tooltip overlay. */
    function chartShell(tip, body, label) {
      return h('div', { className: 'dts-chart-wrap', ref: tip.wrap, onMouseLeave: tip.hide },
        body,
        renderTip(tip.tip));
    }

    /**
     * Column count for the daily heatmap.
     *
     * The grid always fills its card, so the column count *is* the cell size:
     * a fixed 53-column year squeezed each block down to ~10px on a normal
     * settings card, which read as noise rather than data. Targeting a ~22px
     * pitch and letting the window follow the available width keeps the blocks
     * legible at any card width; the range stays bounded to 12–53 weeks so it is
     * never a handful of days and never longer than a year.
     *
     * @param availableWidth - measured grid width in CSS pixels, 0 when unknown.
     * @returns the number of week columns.
     */
    function heatmapWeeks(availableWidth) {
      const width = availableWidth > 0 ? availableWidth : 820;
      const gutter = 16;
      const pitch = 22;
      return Math.max(12, Math.min(53, Math.round((width - gutter) / pitch)));
    }

    /**
     * Cell edge the daily grid ends up with, derived from the layout the
     * stylesheet declares: a 16px weekday gutter plus a 2px margin, a 3px gap
     * between columns, one column per week, and square cells that share the
     * remaining width evenly.
     *
     * @param availableWidth - measured grid width in CSS pixels.
     * @returns the cell edge in CSS pixels.
     */
    function heatCellSize(availableWidth) {
      const width = availableWidth > 0 ? availableWidth : 820;
      const weeks = heatmapWeeks(width);
      return Math.max(0, (width - 18 - 3 * (weeks - 1)) / weeks);
    }

    /**
     * Height reserved for the day-scale view slot.
     *
     * Without it, switching between the daily grid and the weekly bars moved
     * everything below the slot, because the two are not the same height: the
     * grid is 12px of month labels, a 4px gap, seven cell rows and six 3px row
     * gaps, while the weekly chart is a fixed 170px. Reserving the taller of the
     * two makes the swap invisible. The weekly chart is therefore the floor.
     *
     * @param availableWidth - measured slot width in CSS pixels.
     * @returns the reserved height in CSS pixels.
     */
    function viewSlotHeight(availableWidth) {
      return Math.max(170, Math.round(heatCellSize(availableWidth) * 7 + 34));
    }

    /**
     * Daily view: a GitHub-style contribution heatmap.
     *
     * The window length follows the measured card width (see
     * {@link heatmapWeeks}) and always ends today, so the newest block sits
     * flush right and the grid fills the card without empty cells.
     */
    function Heatmap(props) {
      const t = props.t;
      const model = props.model;
      const metric = props.metric;
      const tip = useTip();
      // The panel measures the shared view slot once and hands the width down,
      // so both views work off exactly one measurement and one column grid.
      const availableWidth = typeof props.width === 'number' ? props.width : 0;

      const today = new Date();
      const todayKey = dayKeyOf(today);
      const weeks = heatmapWeeks(availableWidth);
      const thisMonday = addDays(today, -mondayIndex(today));
      const gridStart = addDays(thisMonday, -7 * (weeks - 1));
      const columns = [];
      let cursor = gridStart;
      while (cursor <= today) {
        const column = [];
        for (let i = 0; i < 7; i += 1) {
          const key = dayKeyOf(cursor);
          column.push({ key, future: cursor > today });
          cursor = addDays(cursor, 1);
        }
        columns.push(column);
      }
      const values = [];
      for (const column of columns) {
        for (const cell of column) {
          if (cell.future) continue;
          const value = dayValue(model.byDay.get(cell.key), metric);
          if (value > 0) values.push(value);
        }
      }
      // The ramp is anchored on the busiest day in view, so the whole colour
      // range is used whatever the absolute magnitude happens to be.
      const highest = values.length === 0 ? 0 : Math.max.apply(null, values);
      // One label cell per grid column, so the month row shares the columns'
      // exact layout. A span-sized label drifted left by one gap per boundary
      // because it covered `span` columns but only one gap.
      const monthCells = [];
      let lastMonth = -1;
      for (let c = 0; c < columns.length; c += 1) {
        const month = parseDay(columns[c][0].key).getMonth();
        monthCells.push(month === lastMonth ? '' : t('months')[month]);
        lastMonth = month;
      }
      const monthRow = monthCells.map((label, i) => h('span', { key: i, className: 'dts-heat-month' }, label));
      const weekdayLabels = t('weekdays').map((label, i) => h('span', { key: i }, label));
      return chartShell(tip, h('div', { className: 'dts-heat' },
        h('div', { className: 'dts-heat-months' },
          h('span', { className: 'dts-heat-gutter' }),
          monthRow),
        h('div', { className: 'dts-heat-grid' },
          h('div', { className: 'dts-heat-weekdays' }, weekdayLabels),
          columns.map((column, ci) => h('div', { key: ci, className: 'dts-heat-col' },
            column.map((cell) => {
              const value = cell.future ? 0 : dayValue(model.byDay.get(cell.key), metric);
              const depth = cell.future ? 0 : intensityOf(value, highest);
              return h('div', {
                key: cell.key,
                className: 'dts-cell' + (depth > 0 ? ' dts-cell-on' : ''),
                'data-future': cell.future ? '1' : '0',
                // Depth is continuous, so a day several times busier reads as a
                // visibly darker block instead of landing in the same step.
                style: depth > 0 ? { opacity: depth.toFixed(3) } : undefined,
                onMouseEnter: cell.future
                  ? undefined
                  : (event) => tip.show(event, [cell.key, [0, t('tokens'), formatUnits(value, t)]]),
              });
            }))))), t('heatmapTitle'));
    }

    /** Weekly view: one bar per week, adaptive window capped at 53 weeks. */
    function WeeklyBars(props) {
      const t = props.t;
      const model = props.model;
      const metric = props.metric;
      const tip = useTip();
      // The SAME window and the same column pitch as the daily grid: the week
      // count comes from the same measurement, and the viewBox is expressed in
      // CSS pixels so week i sits directly under heatmap column i. The previous
      // version hard-coded 53 weeks while the grid was adaptive, which both
      // misaligned the two views and squeezed every bar to ~10px.
      const measured = typeof props.width === 'number' ? props.width : 0;
      const cardWidth = Math.max(360, Math.round(measured > 0 ? measured : 820));
      const weekCount = heatmapWeeks(measured);
      const today = new Date();
      const thisMonday = addDays(today, -mondayIndex(today));
      const weeks = [];
      for (let w = weekCount - 1; w >= 0; w -= 1) {
        const start = addDays(thisMonday, -7 * w);
        const keys = [];
        for (let i = 0; i < 7; i += 1) {
          const day = addDays(start, i);
          if (day <= today) keys.push(dayKeyOf(day));
        }
        weeks.push({ start, keys, value: sumDays(model, keys, metric) });
      }
      const max = weeks.reduce((a, w) => Math.max(a, w.value), 0);
      const width = cardWidth;
      const height = 170;
      // Left inset matches the heatmap's weekday gutter (+ its margin), so the
      // first week lines up with the first grid column; the right edge is flush.
      const padLeft = 18;
      const top = 16;
      const bottom = height - 20;
      const plotHeight = bottom - top;
      const slot = (width - padLeft) / Math.max(1, weeks.length);
      const barWidth = Math.max(3, slot - 4);
      const barX = (i) => padLeft + i * slot + (slot - barWidth) / 2;
      const y = (value) => bottom - (max === 0 ? 0 : (value / max) * plotHeight);
      return chartShell(tip, h('svg', { className: 'dts-chart', viewBox: '0 0 ' + width + ' ' + height, role: 'img' },
        h('line', { className: 'dts-grid', x1: padLeft, y1: bottom, x2: width, y2: bottom }),
        // The scale reference sits above the plot rather than in a left gutter,
        // because a left gutter would break the alignment with the daily grid.
        h('text', { className: 'dts-axis', x: padLeft, y: 10 }, formatUnits(max, t)),
        // Every week gets a full-height hit target as well as its bar, so a week
        // with no usage is still hoverable and reports an explicit zero instead
        // of being an unclickable gap.
        weeks.map((week, i) => {
          const rectY = y(week.value);
          return h('g', { key: i },
            h('rect', {
              className: 'dts-week-bar dts-c0',
              x: barX(i),
              y: rectY,
              width: barWidth,
              height: Math.max(week.value > 0 ? 1 : 0, bottom - rectY),
              rx: 2,
            }),
            h('rect', {
              x: padLeft + i * slot,
              y: top,
              width: Math.max(slot, 1),
              height: plotHeight,
              fill: 'transparent',
              onMouseEnter: (event) => tip.show(event, [
                dayKeyOf(week.start) + ' \u2192 ' + dayKeyOf(addDays(week.start, 6)),
                [0, t('tokens'), formatUnits(week.value, t)],
              ]),
            }));
        }),
        axisTicks({
          indices: tickIndices(weeks.length, 5),
          xOf: (i) => padLeft + i * slot + slot / 2,
          top,
          bottom,
          labelY: height - 4,
          width,
          label: (i) => dayKeyOf(weeks[i].start).slice(5),
        })), t('weeklyTitle'));
    }

    /**
     * Bucketing granularity a range deserves.
     *
     * A wide range at daily resolution is an unreadable picket fence, and a
     * narrow range at monthly resolution is three points; the axes therefore
     * follow the range instead of a fixed rule.
     *
     * @param dayCount - number of calendar days in the range.
     * @returns `day` | `week` | `month` | `year`.
     */
    function granularityFor(dayCount) {
      if (dayCount <= 31) return 'day';
      if (dayCount <= 180) return 'week';
      if (dayCount <= 730) return 'month';
      return 'year';
    }

    /**
     * Group day keys into display buckets at the given granularity.
     *
     * Every calendar day of the range is represented, so an empty stretch still
     * occupies its real width on the axis rather than collapsing.
     *
     * @param days - every day key in the range, ascending.
     * @param granularity - `day` | `week` | `month` | `year`.
     * @returns `[{ key, label, keys }]`.
     */
    function bucketize(days, granularity) {
      if (granularity === 'day') return days.map((key) => ({ key, label: key, keys: [key] }));
      const buckets = new Map();
      for (const key of days) {
        let bucketKey;
        if (granularity === 'week') {
          const date = parseDay(key);
          bucketKey = dayKeyOf(addDays(date, -mondayIndex(date)));
        } else if (granularity === 'month') {
          bucketKey = key.slice(0, 7);
        } else {
          bucketKey = key.slice(0, 4);
        }
        const entry = buckets.get(bucketKey) === undefined ? { key: bucketKey, label: bucketKey, keys: [] } : buckets.get(bucketKey);
        entry.keys.push(key);
        buckets.set(bucketKey, entry);
      }
      return [...buckets.values()];
    }

    /**
     * Evenly spaced axis tick positions over `length` slots.
     * @param length - number of slots.
     * @param count - desired tick count.
     * @returns ascending slot indices, always including both ends.
     */
    function tickIndices(length, count) {
      if (length <= 0) return [];
      const wanted = Math.max(2, Math.min(count, length));
      const out = [];
      for (let i = 0; i < wanted; i += 1) out.push(Math.round((i / (wanted - 1)) * (length - 1)));
      return [...new Set(out)];
    }

    /** Axis label for one bucket at the active granularity. */
    function bucketLabel(label, granularity) {
      if (granularity === 'day') return label.slice(5);
      if (granularity === 'week') return label.slice(5);
      if (granularity === 'month') return label.slice(2);
      return label;
    }

    /** Axis tick marks plus labels, shared by every time-series chart. */
    function axisTicks(props) {
      return props.indices.map((index, i) => {
        const x = props.xOf(index);
        return h('g', { key: 'tick' + i },
          h('line', { className: 'dts-tick', x1: x, y1: props.top, x2: x, y2: props.bottom }),
          h('text', {
            className: 'dts-axis',
            x: Math.min(props.width - 4, Math.max(4, x)),
            y: props.labelY,
            textAnchor: i === 0 ? 'start' : i === props.indices.length - 1 ? 'end' : 'middle',
          }, props.label(index)));
      });
    }

    /**
     * Trend view: one smooth line per model.
     *
     * Lines only — comparing models across time is what this chart is for, and a
     * shape toggle asked the reader to choose a question before answering it.
     * The granularity follows the range, and empty buckets still carry a muted
     * marker so the axis reads as continuous instead of skipping gaps.
     */
    function TrendChart(props) {
      const t = props.t;
      const model = props.model;
      const metric = props.metric;
      const days = props.days;
      const tip = useTip();
      const indices = model.models.map((m, i) => i);
      const width = 720;
      const height = 210;
      const padLeft = 44;
      const padBottom = 22;
      const plotWidth = width - padLeft - 4;
      const plotHeight = height - padBottom - 22;
      const baseline = 4 + plotHeight;

      const granularity = granularityFor(days.length);
      const buckets = bucketize(days, granularity).map((bucket) => {
        const parts = indices.map((index) => sumDays(model, bucket.keys, metric, index));
        return { key: bucket.key, label: bucket.label, parts, total: parts.reduce((a, b) => a + b, 0) };
      });
      if (buckets.length === 0) return h('div', { className: 'dts-status' }, t('noData'));
      const max = buckets.reduce((a, b) => Math.max(a, b.total === 0 ? 0 : Math.max.apply(null, b.parts)), 0);
      const scale = (value) => (max === 0 ? 0 : (value / max) * plotHeight);
      const step = plotWidth / Math.max(1, buckets.length);
      const xOfSlot = (i) => padLeft + i * step;
      const centreOf = (i) => xOfSlot(i) + step / 2;
      const seriesTotal = indices.map((index) => sumDays(model, days, metric, index));

      // One hover target per x, listing every series: naming only one model would
      // be strictly less useful than the chart itself.
      const tooltipFor = (bucket) => {
        const out = [bucket.label + ' · ' + formatUnits(bucket.total, t) + ' ' + t('tokens')];
        for (let s = 0; s < indices.length; s += 1) {
          if (bucket.parts[s] > 0) out.push([indices[s], modelLabel(model.models[indices[s]], t), formatUnits(bucket.parts[s], t)]);
        }
        return out;
      };

      const shapes = [];
      for (let s = 0; s < indices.length; s += 1) {
        if (seriesTotal[s] <= 0) continue;
        const points = buckets.map((bucket, i) => [centreOf(i), baseline - scale(bucket.parts[s])]);
        shapes.push(h('path', { key: 'line' + s, className: 'dts-line ' + colorClass(indices[s]), d: smoothPath(points) }));
        if (points.length <= 62 && points.length > 1) {
          for (let i = 0; i < points.length; i += 1) {
            const empty = buckets[i].parts[s] <= 0;
            // An empty bucket keeps a hollow, muted marker: the point is still
            // there on the axis, it just is not emphasised.
            shapes.push(h('circle', {
              key: 'dot' + s + ':' + i,
              className: empty ? 'dts-dot-empty' : 'dts-dot ' + colorClass(indices[s]),
              cx: points[i][0],
              cy: points[i][1],
              r: empty ? 1.7 : 2.3,
            }));
          }
        }
      }
      for (let i = 0; i < buckets.length; i += 1) {
        shapes.push(h('rect', {
          key: 'hit' + i,
          x: xOfSlot(i),
          y: 4,
          width: Math.max(step, 1),
          height: plotHeight,
          fill: 'transparent',
          onMouseEnter: (event) => tip.show(event, tooltipFor(buckets[i])),
        }));
      }

      const ticks = axisTicks({
        indices: tickIndices(buckets.length, 6),
        xOf: centreOf,
        top: 4,
        bottom: baseline,
        labelY: height - 6,
        width,
        label: (i) => bucketLabel(buckets[i].label, granularity),
      });
      return chartShell(tip, h('svg', { className: 'dts-chart', viewBox: '0 0 ' + width + ' ' + height, role: 'img' },
        h('line', { className: 'dts-grid', x1: padLeft, y1: baseline, x2: width - 4, y2: baseline }),
        h('text', { className: 'dts-axis', x: 0, y: 10 }, formatUnits(max, t)),
        h('text', { className: 'dts-axis', x: 0, y: baseline }, '0'),
        shapes,
        ticks), t('trendTitle'));
    }

    /**
     * Ring path between two angles: outer arc out, inner arc back.
     * @param cx - centre x.
     * @param cy - centre y.
     * @param outer - outer radius.
     * @param inner - inner radius.
     * @param start - start angle in radians.
     * @param end - end angle in radians.
     * @returns the path, or null when the span is a full circle.
     */
    function ringPath(cx, cy, outer, inner, start, end) {
      if (end - start >= Math.PI * 2 - 1e-6) return null;
      const large = end - start > Math.PI ? 1 : 0;
      const x1 = cx + outer * Math.cos(start);
      const y1 = cy + outer * Math.sin(start);
      const x2 = cx + outer * Math.cos(end);
      const y2 = cy + outer * Math.sin(end);
      const x3 = cx + inner * Math.cos(end);
      const y3 = cy + inner * Math.sin(end);
      const x4 = cx + inner * Math.cos(start);
      const y4 = cy + inner * Math.sin(start);
      return 'M ' + x1.toFixed(2) + ' ' + y1.toFixed(2)
        + ' A ' + outer + ' ' + outer + ' 0 ' + large + ' 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2)
        + ' L ' + x3.toFixed(2) + ' ' + y3.toFixed(2)
        + ' A ' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + x4.toFixed(2) + ' ' + y4.toFixed(2)
        + ' Z';
    }

    /**
     * Share view: a ring chart plus a legend that names every slice.
     *
     * A ring rather than a solid pie: the hole gives the total a place to live,
     * keeps the eye on the arcs instead of a centroid, and survives narrow
     * slices (a 1% sliver of a pie is an unreadable spike at the centre).
     */
    function DonutChart(props) {
      const t = props.t;
      const model = props.model;
      const metric = props.metric;
      const days = props.days;
      const tip = useTip();
      const totals = model.models.map((entry, index) => ({ index, entry, value: sumDays(model, days, metric, index) }))
        .filter((slice) => slice.value > 0)
        .sort((a, b) => b.value - a.value);
      const sum = totals.reduce((a, slice) => a + slice.value, 0);
      if (sum <= 0) return h('div', { className: 'dts-status' }, t('noData'));
      const size = 196;
      const outer = 80;
      const inner = 52;
      const center = size / 2;
      const [hovered, setHovered] = React.useState(-1);
      // A small angular gap on both sides of every boundary. The previous
      // version instead displaced every slice along its mid-angle at rest, which
      // is what made the ring look randomly misaligned.
      const gap = 0.016;
      let angle = -Math.PI / 2;
      const slices = totals.map((slice) => {
        const sweep = (slice.value / sum) * Math.PI * 2;
        const start = angle;
        angle += sweep;
        const inset = Math.min(gap, sweep * 0.18);
        return {
          slice,
          share: slice.value / sum,
          path: ringPath(center, center, outer, inner, start + inset, angle - inset),
          mid: start + sweep / 2,
        };
      });
      const lines = (entry) => [
        modelLabel(entry.slice.entry, t) + ' · ' + (entry.share * 100).toFixed(1) + '%',
        [entry.slice.index, t('tokens'), formatUnits(entry.slice.value, t)],
      ];
      const hover = (event, entry) => {
        setHovered(entry.slice.index);
        tip.show(event, lines(entry));
      };
      return h('div', { className: 'dts-pie-wrap' },
        h('div', {
          className: 'dts-chart-wrap',
          ref: tip.wrap,
          style: { width: size + 'px', flex: 'none' },
          onMouseLeave: () => { setHovered(-1); tip.hide(); },
        },
          h('svg', {
            className: 'dts-chart',
            viewBox: '0 0 ' + size + ' ' + size,
            style: { width: size + 'px' },
            role: 'img',
          },
            h('defs', {},
              h('filter', { id: 'dts-donut-shadow', x: '-25%', y: '-25%', width: '150%', height: '150%' },
                h('feDropShadow', { dx: 0, dy: 2, stdDeviation: 3, className: 'dts-donut-shadow-node' }))),
            h('g', { filter: 'url(#dts-donut-shadow)' },
              slices.map((entry) => (entry.path === null
                ? h('circle', {
                  key: entry.slice.index,
                  className: 'dts-donut-slice ' + colorClass(entry.slice.index),
                  cx: center,
                  cy: center,
                  r: (outer + inner) / 2,
                  fill: 'none',
                  strokeWidth: outer - inner,
                  onMouseEnter: (event) => hover(event, entry),
                })
                : h('path', {
                  key: entry.slice.index,
                  className: 'dts-donut-slice ' + colorClass(entry.slice.index),
                  d: entry.path,
                  // Only the hovered slice lifts away from the centre, so the
                  // resting ring stays perfectly concentric.
                  style: { transition: 'transform .16s' },
                  transform: hovered === entry.slice.index
                    ? 'translate(' + (Math.cos(entry.mid) * 3).toFixed(2) + ' ' + (Math.sin(entry.mid) * 3).toFixed(2) + ')'
                    : undefined,
                  onMouseEnter: (event) => hover(event, entry),
                })))),
            h('text', { className: 'dts-donut-total', x: center, y: center, textAnchor: 'middle', dominantBaseline: 'middle' }, formatUnits(sum, t)),
            h('text', { className: 'dts-donut-total-label', x: center, y: center + 16, textAnchor: 'middle' }, t('donutTotal'))),
          renderTip(tip.tip)),
        h('div', { className: 'dts-legend' },
          slices.map((entry) => h('div', { key: entry.slice.index, className: 'dts-legend-row' },
            h('span', { className: 'dts-swatch ' + colorClass(entry.slice.index) }),
            h('span', { className: 'dts-legend-name', title: modelLabel(entry.slice.entry, t) }, modelLabel(entry.slice.entry, t)),
            h('span', { className: 'dts-legend-value', title: formatFull(entry.slice.value) },
              formatUnits(entry.slice.value, t) + ' · ' + (entry.share * 100).toFixed(1) + '%')))));
    }

    /**
     * Last payload successfully fetched in this page session.
     *
     * The settings dialog unmounts its section when the user leaves Settings, so
     * without this every re-entry showed a full-panel "reading session logs…"
     * state even though the numbers had just been computed. Holding the last
     * answer at module scope lets a remount paint immediately and revalidate
     * behind it, which is what removes the perceived wait.
     */
    let panelCache = null;

    /**
     * Base delay between the follow-ups queued for one stale answer.
     *
     * The wait grows linearly (`STALE_RETRY_MS * (tries + 1)`), because the
     * rescan behind a stale answer is not always the 1–2s cold scan: a forced
     * refresh measured 9.3s on the machine this was built against when the live
     * session's log had grown. A retry that arrives while the scan is still
     * running joins it and is answered immediately, so covering 10s costs one
     * small request every second or two rather than a poll.
     */
    const STALE_RETRY_MS = 700;

    /**
     * Follow-ups queued for one stale answer. The last one lands at
     * 0.7 + 1.4 + 2.1 + 2.8 + 3.5 = 10.5s, which covers the slowest rescan
     * measured here; the explicit refresh button remains for the pathological
     * case, and a bounded count is what keeps this from becoming a poll.
     */
    const STALE_MAX_TRIES = 5;

    /**
     * Decide whether one host answer still needs a follow-up.
     *
     * The host tags an answer that it served from its cache while it rescans
     * behind the response; the retries are bounded so a host that keeps failing
     * to rescan cannot turn this into an endless poll.
     *
     * @param value - the value the host returned, or a failure envelope.
     * @param tries - how many follow-ups have already been queued.
     * @returns true when another request is due.
     */
    function staleFollowUp(value, tries) {
      return value !== null && typeof value === 'object' && value.stale === true && tries < STALE_MAX_TRIES;
    }

    /**
     * Build the panel component.
     * @param ctx - client Cordis context.
     * @param seams - `translate`, `subscribeLocale`.
     * @returns the component registered into `settings.section`.
     */
    function createPanel(ctx, seams) {
      const t = seams.translate;

      return function Panel() {
        const [state, setState] = React.useState(panelCache === null
          ? { phase: 'loading', payload: null, error: '' }
          : { phase: 'ready', payload: panelCache, error: '' });
        const [busy, setBusy] = React.useState(false);
        const [refreshing, setRefreshing] = React.useState(false);
        const [metric, setMetric] = React.useState('all');
        const [view, setView] = React.useState('daily');
        const [preset, setPreset] = React.useState('30');
        const [, setTick] = React.useState(0);
        const viewSlot = React.useRef(null);
        const viewWidth = useMeasuredWidth(viewSlot);
        const alive = React.useRef(true);
        const timer = React.useRef(null);

        React.useEffect(() => {
          const off = seams.subscribeLocale(() => setTick((n) => n + 1));
          return () => { if (typeof off === 'function') off(); };
        }, []);

        // A background revalidation must not outlive the panel: the settings
        // dialog unmounts it on close, and a late answer would set state on a
        // gone component.
        React.useEffect(() => () => {
          alive.current = false;
          if (timer.current !== null && typeof clearTimeout === 'function') clearTimeout(timer.current);
        }, []);

        /**
         * Ask the host for one aggregate.
         *
         * The host answers a stale aggregate immediately and rescans behind the
         * response — a cold scan reads the live session's whole log, which took
         * 1–2s — so a `stale: true` answer is followed up a few times until the
         * numbers are current. The already-painted figures stay on screen while
         * that happens; only the first ever load shows the loading state.
         *
         * @param force - bypass the host's TTL and its stale answer.
         * @param attempt - how many follow-ups this load has already queued.
         */
        const load = (force, attempt) => {
          const tries = typeof attempt === 'number' ? attempt : 0;
          if (force) setBusy(true);
          return hostCall(force ? 'refresh' : 'summary', {}).then((result) => {
            if (alive.current === false) return;
            if (force) setBusy(false);
            if (result && result.ok === false) {
              setRefreshing(false);
              setState((prev) => ({ phase: prev.payload === null ? 'error' : 'ready', payload: prev.payload, error: result.error }));
              return;
            }
            if (result && Array.isArray(result.days)) {
              panelCache = result;
              setState({ phase: 'ready', payload: result, error: '' });
              if (staleFollowUp(result, tries)) {
                setRefreshing(true);
                timer.current = setTimeout(() => load(false, tries + 1), STALE_RETRY_MS * (tries + 1));
                return;
              }
              setRefreshing(false);
              return;
            }
            setRefreshing(false);
            setState((prev) => ({ phase: prev.payload === null ? 'error' : 'ready', payload: prev.payload, error: 'unexpected payload' }));
          });
        };

        React.useEffect(() => { load(false); }, []);

        const payload = state.payload;
        const model = payload === null ? null : prepare(payload);
        // Cache writes are a real part of the platform's TokenUsage contract, but
        // a provider that does not bill them simply never reports the bucket — on
        // this deployment every sample has cacheWriteTokens absent, i.e. zero. An
        // always-zero choice is noise, so it appears only once some usage exists.
        const cacheWriteUsed = payload !== null && Array.isArray(payload.days)
          && payload.days.some((day) => Array.isArray(day.b) && day.b[3] > 0);

        React.useEffect(() => {
          if (!cacheWriteUsed && metric === 'cacheWrite') setMetric('all');
        }, [cacheWriteUsed]);

        const metricOptions = [
          { value: 'all', label: t('metricAll') },
          { value: 'total', label: t('metricTotal') },
          { value: 'input', label: t('metricInput') },
          { value: 'output', label: t('metricOutput') },
          { value: 'cacheRead', label: t('metricCacheRead') },
        ];
        if (cacheWriteUsed) metricOptions.push({ value: 'cacheWrite', label: t('metricCacheWrite') });
        const viewOptions = [
          { value: 'daily', label: t('viewDaily') },
          { value: 'weekly', label: t('viewWeekly') },
        ];
        const rangeOptions = [
          { value: '7', label: t('range7') },
          { value: '30', label: t('range30') },
          { value: '90', label: t('range90') },
          { value: 'year', label: t('rangeYear') },
          { value: 'all', label: t('rangeAll') },
        ];

        let body = null;
        if (model !== null) {
          const peak = peakDay(model, metric);
          let lifetime = 0;
          for (const day of model.days) lifetime += dayValue(model.byDay.get(day.d), metric);
          const range = presetRange(preset, model);
          const rangeDays = eachDay(range.from, range.to);
          const rangeTotal = sumDays(model, rangeDays, metric);
          // Four more figures that are cheap to derive and actually answer
          // questions the first four do not: where today stands, how the current
          // week is going, the typical day, and how much of the total is served
          // from cache. Cost estimates were deliberately left out — the platform
          // exposes no token pricing, so any number here would be invented.
          const today = dayKeyOf(new Date());
          const todayValue = dayValue(model.byDay.get(today), metric);
          const weekDays = eachDay(dayKeyOf(addDays(new Date(), -6)), today);
          const weekValue = sumDays(model, weekDays, metric);
          const dailyAverage = model.activeDays > 0 ? lifetime / model.activeDays : 0;
          let allTokens = 0;
          let cacheReadTokens = 0;
          for (const day of model.days) {
            allTokens += day.b[0] + day.b[1] + day.b[2] + day.b[3];
            cacheReadTokens += day.b[2];
          }
          const cacheShare = allTokens > 0 ? (cacheReadTokens / allTokens) * 100 : 0;
          const granularityLabel = {
            day: t('granularityDay'), week: t('granularityWeek'), month: t('granularityMonth'), year: t('granularityYear'),
          }[granularityFor(rangeDays.length)];
          const failed = payload.scope && Array.isArray(payload.scope.failedSessions) ? payload.scope.failedSessions : [];

          body = h('div', { className: 'dts-body' },
            state.error === '' ? null : h('div', { className: 'dts-error' }, state.error),
            h('div', { className: 'dts-cards' },
              h(Card, { label: t('statLifetime'), value: formatUnits(lifetime, t), title: formatFull(lifetime) + ' ' + t('tokens') }),
              h(Card, {
                label: t('statPeak'),
                value: peak === null ? '0' : formatUnits(peak.value, t),
                title: peak === null ? '' : formatFull(peak.value) + ' ' + t('tokens'),
                sub: peak === null ? undefined : peak.day,
              }),
              h(Card, {
                label: t('statToday'),
                value: formatUnits(todayValue, t),
                title: formatFull(todayValue) + ' ' + t('tokens'),
                sub: today,
              }),
              h(Card, {
                label: t('statWeek'),
                value: formatUnits(weekValue, t),
                title: formatFull(weekValue) + ' ' + t('tokens'),
                sub: weekDays[0] + ' \u2192 ' + today,
              }),
              h(Card, {
                label: t('statDailyAvg'),
                value: formatUnits(dailyAverage, t),
                title: formatFull(Math.round(dailyAverage)) + ' ' + t('tokens'),
                sub: t('statDailyAvgBasis') + ' · ' + formatFull(model.activeDays),
              }),
              h(Card, {
                label: t('statCacheShare'),
                value: cacheShare.toFixed(1) + '%',
                title: formatUnits(cacheReadTokens, t),
                sub: t('statCacheShareBasis'),
              })),
            h('div', { className: 'dts-row' }, h(Segmented, { label: t('metric'), options: metricOptions, value: metric, onChange: setMetric })),
            h('div', { className: 'dts-section' },
              h('div', { className: 'dts-row' },
                h('span', { className: 'dts-section-title' }, view === 'daily' ? t('heatmapTitle') : t('weeklyTitle')),
                h('div', { style: { marginLeft: 'auto' } }, h(Segmented, { label: t('scale'), options: viewOptions, value: view, onChange: setView }))),
              // One slot for both day-scale views: it carries the single
              // measurement they share and reserves the taller view's height, so
              // switching cannot re-measure from zero or move what is below it.
              h('div', {
                className: 'dts-viewslot',
                ref: viewSlot,
                style: { minHeight: viewSlotHeight(viewWidth) + 'px' },
              },
              view === 'daily'
                ? h(Heatmap, { t, model, metric, width: viewWidth })
                : h(WeeklyBars, { t, model, metric, width: viewWidth }))),
            // One section for everything model-scoped. The range control used to
            // sit inside the trend block while also driving the ring below it,
            // which made it ambiguous what it applied to; the shared header now
            // states the scope once.
            h('div', { className: 'dts-section' },
              h('div', { className: 'dts-row' },
                h('span', { className: 'dts-section-title' }, t('modelUsageTitle')),
                h('div', { style: { marginLeft: 'auto' } },
                  h(Segmented, { label: t('range'), options: rangeOptions, value: preset, onChange: setPreset }))),
              h('div', { className: 'dts-row' },
                h('span', { className: 'dts-updated' },
                  range.from + ' \u2192 ' + range.to + ' · ' + formatUnitsExact(rangeTotal, t) + ' ' + t('tokens')),
                h('span', { className: 'dts-updated', style: { marginLeft: 'auto' } },
                  t('granularityPrefix') + ': ' + granularityLabel)),
              h('div', { className: 'dts-subsection' },
                h('div', { className: 'dts-section-title' }, t('trendTitle')),
                h(TrendChart, { t, model, metric, days: rangeDays }),
                h('div', { className: 'dts-legend', style: { flexDirection: 'row', flexWrap: 'wrap' } },
                  model.models.map((entry, index) => (sumDays(model, rangeDays, metric, index) > 0
                    ? h('div', { key: entry.key, className: 'dts-legend-row' },
                      h('span', { className: 'dts-swatch ' + colorClass(index) }),
                      h('span', { className: 'dts-legend-name' }, modelLabel(entry, t)),
                      h('span', { className: 'dts-legend-value', title: formatFull(sumDays(model, rangeDays, metric, index)) },
                        formatUnits(sumDays(model, rangeDays, metric, index), t)))
                    : null)))),
              h('div', { className: 'dts-subsection' },
                h('div', { className: 'dts-section-title' }, t('pieTitle')),
                h(DonutChart, { t, model, metric, days: rangeDays }))),
            h('p', { className: 'dts-note' }, t(cacheWriteUsed ? 'metricNote' : 'metricNoteNoCacheWrite')),
            // The corpus itself, kept as a footnote rather than a headline: it
            // describes the data set, not the usage, and it is where a skipped
            // session has to stay visible because it shrinks every total.
            h('p', {
              className: 'dts-note',
              title: failed.length > 0
                ? failed.map((entry) => String(entry && entry.id) + ': ' + String(entry && entry.error)).join('\n')
                : undefined,
            }, [
              formatFull(payload.scope ? payload.scope.sessions : 0) + ' ' + t('statSessions'),
              failed.length > 0 ? String(failed.length) + ' ' + t('incomplete') : null,
              payload.scope && payload.scope.retired > 0 ? String(payload.scope.retired) + ' ' + t('retained') : null,
            ].filter(Boolean).join(' · ')),
            h('p', { className: 'dts-note' }, t('dailyNote')));
        } else {
          body = h('div', { className: 'dts-body' },
            state.phase === 'error'
              ? h('div', { className: 'dts-error' }, state.error === '' ? 'failed to load usage' : state.error)
              : h('div', { className: 'dts-status' }, t('loading')));
        }

        return h('div', { className: 'dts-root' },
          h('div', { className: 'dts-head' },
            h('div', { className: 'dts-head-title' }, t('title')),
            h('div', { className: 'dts-head-right' },
              payload === null ? null : h('span', { className: 'dts-updated' },
                t('updated') + ' ' + new Date(payload.generatedAt).toLocaleTimeString()),
              // Shown only while the host is rescanning behind an answer that is
              // already on screen; there is no loading state to look at, so this
              // is the whole indication that the numbers are catching up.
              refreshing ? h('span', { className: 'dts-updated dts-refreshing' }, t('refreshing')) : null,
              h('button', {
                type: 'button',
                className: 'dts-btn',
                disabled: busy,
                onClick: () => load(true),
              }, busy ? t('refreshing') : t('refresh')))),
          body);
      };
    }

    /** Required client services: the slot registry and the locale. */
    const inject = ['slots', 'locale'];

    /**
     * Client plugin body.
     * @param ctx - Client Cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-token-stats';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'dsh-token-stats: panel stylesheet');

      // The settings dialog mounts when the user opens it and unmounts on
      // close, so the nav row has to be marked whenever it appears rather than
      // once at load.
      //
      // The mark has to land before the browser paints the freshly mounted
      // dialog, or the shell's gear fallback is on screen for a moment and then
      // swaps to the bar chart. A MutationObserver callback already runs as a
      // microtask at the end of React's commit — after the nodes are in the
      // DOM, before the frame is painted — so the scan happens right there,
      // with no timer in between. The cost of being that hot is bounded two
      // ways: the callback inspects only the nodes just added, and it returns
      // immediately while our marker is still mounted, which is the state a
      // streaming conversation mutates through.
      ctx.effect(() => {
        let row = markNavRowIn(document);
        if (typeof MutationObserver !== 'function' || !document.body) return () => {};

        const isMarked = () => row !== null && row.isConnected && row.hasAttribute(NAV_ATTR);

        let sweep = 0;
        const backstop = () => {
          if (sweep !== 0) return;
          sweep = setTimeout(() => {
            sweep = 0;
            if (isMarked()) return;
            row = markNavRowIn(document) || row;
          }, NAV_SWEEP_MS);
        };

        const observer = new MutationObserver((records) => {
          if (isMarked()) return;
          for (const record of records) {
            for (const node of record.addedNodes) {
              // A label written into an already-mounted row arrives as a text
              // node, so resolve the enclosing button before giving up on it.
              if (node.nodeType === 3) {
                const owner = enclosingButton(node);
                if (owner !== null && markNavButton(owner) !== null) { row = owner; return; }
                continue;
              }
              if (node.nodeType !== 1) continue;
              const hit = markNavRowIn(node);
              if (hit !== null) { row = hit; return; }
            }
          }
          backstop();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
          if (sweep !== 0) clearTimeout(sweep);
        };
      }, 'dsh-token-stats: settings nav glyph');

      const locale = ctx.locale;
      const pickDict = (id) => (/^zh/i.test(String(id || '')) ? ZH : EN);
      const activeId = () => {
        try {
          const snapshot = locale.getSnapshot();
          return String((snapshot && snapshot.active) || '');
        } catch (e) { return ''; }
      };

      let bound = null;
      try {
        let ids = [];
        try {
          const snapshot = locale.getSnapshot();
          ids = Array.isArray(snapshot && snapshot.locales) ? snapshot.locales.map((d) => String(d.id)) : [];
        } catch (e) { /* fall back to the known pair */ }
        if (ids.length === 0) ids = ['en', 'zh'];
        for (const id of ids) {
          const off = locale.register(NS, id, pickDict(id));
          // The dictionary registration outlives the row, so tie it to the fiber.
          if (typeof off === 'function') ctx.effect(() => off);
        }
        bound = typeof locale.bind === 'function' ? locale.bind(NS) : null;
      } catch (e) { bound = null; }

      const translate = (key) => {
        if (bound !== null) {
          try {
            const value = bound(key);
            if (typeof value === 'string' && value !== key && value.length > 0) return value;
          } catch (e) { /* fall through to the literal dictionary */ }
        }
        const dict = pickDict(activeId());
        return dict[key] || EN[key] || key;
      };

      // The panel owns this subscription: the effect that creates it also
      // disposes it, so a remount cannot accumulate listeners.
      const subscribeLocale = (fn) => {
        try {
          return locale.subscribe(fn);
        } catch (e) { return undefined; }
      };

      const Panel = createPanel(ctx, { translate, subscribeLocale });
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'token-stats', order: 40, label: () => translate('title') },
        Panel,
      ));
    }

    /**
     * One call into the host route.
     *
     * The route answers a JSON envelope and is same-origin, so the browser
     * attaches the platform's login cookie automatically. Transport faults and
     * failure envelopes are folded into the single `{ok:…}` shape the panel
     * speaks, so no caller has to tell them apart.
     *
     * @param method - endpoint name, matching a host-core method.
     * @param args - JSON payload.
     * @returns `{ok: true, …}` or `{ok: false, error}`.
     */
    function hostCall(method, args) {
      let pending;
      try {
        pending = fetch(CHANNEL + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args || {}),
        });
      } catch (e) {
        return Promise.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      return Promise.resolve(pending).then(
        (res) =>
          res.json().then(
            (envelope) => {
              if (envelope && envelope.ok) return envelope.value;
              const message = envelope && envelope.error
                ? (envelope.error.message || envelope.error.code || 'host call failed')
                : 'HTTP ' + res.status;
              return { ok: false, error: String(message) };
            },
            () => ({ ok: false, error: 'HTTP ' + res.status + ' with a non-JSON body' }),
          ),
        (e) => ({ ok: false, error: String(e && e.message ? e.message : e) }),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = {
      CSS,
      EN,
      ZH,
      NS,
      NAV_ATTR,
      CHANNEL,
      markNavButton,
      markNavRowIn,
      enclosingButton,
      formatFull,
      formatUnits,
      formatUnitsExact,
      metricOf,
      dayKeyOf,
      parseDay,
      eachDay,
      prepare,
      presetRange,
      intensityOf,
      ringPath,
      smoothPath,
      granularityFor,
      bucketize,
      tickIndices,
      heatmapWeeks,
      heatCellSize,
      viewSlotHeight,
      staleFollowUp,
      STALE_MAX_TRIES,
      modelLabel,
      colorClass,
      components: { Segmented, Card, Heatmap, WeeklyBars, TrendChart, DonutChart },
      createPanel,
      seedPayload: (value) => { panelCache = value; },
      // The shim never runs effects, so a measured width cannot be produced by
      // rendering. Seeding it is how a test proves a remount starts from the
      // last real width instead of from zero.
      seedMeasuredWidth: (value) => { lastMeasuredWidth = typeof value === 'number' ? value : 0; },
      measuredWidth: () => lastMeasuredWidth,
    };
    return module.exports;
  },
});
