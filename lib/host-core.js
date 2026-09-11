/**
 * dsh-token-stats — host core.
 *
 * Transport-free: this module never touches `req`/`res` and never registers a
 * route, so the whole statistics pipeline is unit-testable in plain Node
 * (`lib/index.js` is the only adapter that knows about HTTP).
 *
 * ## Where the numbers come from
 *
 * Token usage is recorded by the harness on exactly one durable event type —
 * `assistant/message`, in `data.usage` — and the provider/model that produced
 * that message sits on the same event at `data.message.source`. That makes one
 * assistant message the only atomic unit which carries BOTH a usage sample and
 * its route, which is why the fold here is message-level rather than turn-level:
 *
 * - the platform's own `deriveTurnTokenUsage()` is turn-level and collapses its
 *   `routes` to a list without per-route numbers, so it cannot answer
 *   "which model spent this?" — and it returns `undefined` for any turn that
 *   contains a compaction. Measured on this machine: it accounts for 294.7M
 *   tokens where the message-level fold accounts for 340.2M, i.e. it silently
 *   loses ~13% of real usage. It is therefore used only as a cross-check in the
 *   test suite, never as the primary source.
 * - On every turn where the deriver *does* produce a value, the fold below
 *   reproduces all four buckets exactly (80/80 turns, verified in
 *   `test/host-core.test.mjs` against the real logs).
 *
 * ## The replacement rule
 *
 * A single billed attempt can emit more than one `assistant/message` sample
 * (a streaming sample and then the final one). The platform's documented rule is
 * that the final sample of the same attempt replaces earlier ones, and that
 * `llm/retry-started` ends that replacement scope so a retry is billed again.
 * The fold keys each sample by `(turn, step, epoch)` where `epoch` advances on
 * `llm/retry-started` and on `assistant/attempt`, and a later sample in the same
 * slot replaces the earlier one. On the logs measured here no two samples ever
 * shared a key, so the rule is a safety net rather than an active correction.
 *
 * ## Forked sessions
 *
 * A seeded (forked) session's durable log *contains* its parent's events as a
 * leading prefix. `inheritedEventCount` is that prefix length, and the fold
 * skips it — otherwise every fork would be counted twice.
 *
 * @module dsh-token-stats/host-core
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Durable rollup layout version; a mismatch discards the file. */
export const CACHE_VERSION = 1;

/**
 * How long a computed aggregate is served without rescanning.
 *
 * The browser half paints the previous answer immediately and revalidates
 * behind it, so this only decides how much CPU a burst of panel opens costs;
 * an explicit refresh always rescans.
 */
export const AGGREGATE_TTL_MS = 60 * 1000;

/** A durable rollup older than this is ignored rather than trusted. */
const DURABLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How long resolved model display names are reused before asking again. */
const NAMES_TTL_MS = 10 * 60 * 1000;

/** Beyond this many models the tail is folded into one "other" slice. */
export const MAX_MODELS = 8;

/** Model key used for messages whose route is missing or not a model route. */
export const UNKNOWN_MODEL_KEY = '__unknown__';

/** Model key for the folded tail beyond {@link MAX_MODELS}. */
export const OTHER_MODEL_KEY = '__other__';

/** Bucket order used by every array in this module and on the wire. */
export const BUCKET_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

/** A business failure the route reports as HTTP 200 with a failure envelope. */
export class StatsError extends Error {
  /**
   * @param code - stable machine-readable code.
   * @param message - human-readable reason.
   */
  constructor(code, message) {
    super(message);
    this.name = 'StatsError';
    this.code = code;
  }
}

/**
 * Yield one macrotask, so work that is already waiting — an HTTP request whose
 * answer is sitting in the aggregate cache — runs between the synchronous parts
 * of a scan instead of after all of them.
 * @returns a promise resolved on the next turn of the event loop.
 */
const yieldToLoop = typeof setImmediate === 'function'
  ? () => new Promise((resolve) => { setImmediate(resolve); })
  : () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Coerce one reported count to a non-negative safe integer.
 * @param value - candidate count from a durable usage sample.
 * @returns the count, or 0 when it is not a usable number.
 */
export function toCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Local calendar day for one event timestamp.
 *
 * Day boundaries follow the machine's local timezone, so "today" in the panel
 * matches the user's own clock; the stored key is the local calendar date.
 * @param ms - Unix epoch milliseconds.
 * @returns `YYYY-MM-DD` in local time.
 */
export function localDayKey(ms) {
  const d = new Date(ms);
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/**
 * Fold one session's own events into a day × model bucket table.
 *
 * @param events - the session's events, with any forked prefix already removed.
 * @param options - `dayKey(ms)` override, for tests.
 * @returns `{ days, samples, unpriced }` where `days[day][modelKey]` is a
 *   four-element bucket array and `samples` is how many usage samples were read.
 */
export function foldSession(events, options = {}) {
  const dayKey = typeof options.dayKey === 'function' ? options.dayKey : localDayKey;
  /** One slot per billed attempt; a later sample in a slot replaces the earlier. */
  const slots = new Map();
  let turn = 0;
  let step = 0;
  let epoch = 0;
  let unpriced = 0;

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const type = event.type;
    if (type === 'turn/start') {
      turn = toCount(event.data === undefined ? 0 : event.data.turn);
      step = 0;
      epoch = 0;
      continue;
    }
    if (type === 'step/start') {
      step = toCount(event.data === undefined ? 0 : event.data.step);
      epoch = 0;
      continue;
    }
    if (type === 'llm/retry-started' || type === 'assistant/attempt') {
      epoch += 1;
      continue;
    }
    if (type !== 'assistant/message') continue;

    const data = event.data === undefined || event.data === null ? {} : event.data;
    const usage = data.usage;
    if (usage === null || typeof usage !== 'object') {
      unpriced += 1;
      continue;
    }
    const source = data.message === undefined || data.message === null ? {} : data.message.source;
    const routed = source !== null
      && typeof source === 'object'
      && source.kind === 'model'
      && typeof source.provider === 'string' && source.provider.length > 0
      && typeof source.model === 'string' && source.model.length > 0;
    // Prefer the message's own turn/step: the durable message carries them, and
    // trusting them keeps the attempt slot stable even when a lifecycle event is
    // missing from the window being folded.
    const atTurn = Number.isSafeInteger(data.turn) && data.turn >= 0 ? data.turn : turn;
    const atStep = Number.isSafeInteger(data.step) && data.step >= 0 ? data.step : step;
    slots.set(atTurn + ':' + atStep + ':' + epoch, {
      day: dayKey(Number.isFinite(event.time) ? event.time : 0),
      model: routed ? source.provider + '/' + source.model : UNKNOWN_MODEL_KEY,
      buckets: [
        toCount(usage.inputTokens),
        toCount(usage.outputTokens),
        toCount(usage.cacheReadTokens),
        toCount(usage.cacheWriteTokens),
      ],
    });
  }

  /** @type {Record<string, Record<string, number[]>>} */
  const days = {};
  for (const slot of slots.values()) {
    const day = days[slot.day] === undefined ? (days[slot.day] = {}) : days[slot.day];
    const buckets = day[slot.model] === undefined ? (day[slot.model] = [0, 0, 0, 0]) : day[slot.model];
    for (let i = 0; i < 4; i += 1) buckets[i] += slot.buckets[i];
  }
  return { days, samples: slots.size, unpriced };
}

/**
 * Cheap change marker for one session's durable log.
 * @param meta - records returned by `sessionQuery.listEvents`.
 * @returns a marker that changes whenever the log grows.
 */
export function markerOf(meta) {
  const list = Array.isArray(meta) ? meta : [];
  let last = -1;
  for (const record of list) {
    const seq = record === null || typeof record !== 'object' ? -1 : Number(record.seq);
    if (Number.isFinite(seq) && seq > last) last = seq;
  }
  return list.length + ':' + last;
}

/**
 * Sum the four buckets of one sample into the metric the panel selected.
 *
 * `all` is the provider's own accounting: over 95 real turns the provider's
 * `data.usage.totalTokens` always equalled these four buckets added together
 * (uncached input + output + cache read + cache write). `total` is the narrower
 * "new tokens" figure, excluding cache reads — on this machine cache reads
 * outnumber new tokens roughly 60:1 and would swamp any trend, so the two are
 * offered side by side rather than blended.
 *
 * @param buckets - four-element bucket array.
 * @param metric - `all` | `total` | `input` | `output` | `cacheRead` | `cacheWrite`.
 * @returns the selected metric's token count.
 */
export function metricValue(buckets, metric) {
  if (metric === 'input') return buckets[0];
  if (metric === 'output') return buckets[1];
  if (metric === 'cacheRead') return buckets[2];
  if (metric === 'cacheWrite') return buckets[3];
  if (metric === 'all') return buckets[0] + buckets[1] + buckets[2] + buckets[3];
  return buckets[0] + buckets[1];
}

/**
 * Change marker for one session, using the cheapest source that is still exact.
 *
 * `listEvents` parses and validates the whole log, which is far too expensive to
 * run for every session on every panel open. The persistence backend can answer
 * the same question from file metadata alone (`sizeBytes` + `eventCount`, or an
 * opaque `revision`), and logs are append-only, so either signal changes exactly
 * when the log does. Live sessions still go through `listEvents`, because their
 * newest events may not have been flushed to disk yet.
 *
 * @param query - the session query service.
 * @param persistence - optional `sessionPersistence` service.
 * @param record - one `SessionRecord`.
 * @returns a marker string that changes whenever the session's usage may have.
 */
async function markerFor(query, persistence, record) {
  const id = String(record.header.id);
  if (record.live !== true && persistence !== undefined && persistence !== null && typeof persistence.stat === 'function') {
    const snapshot = await persistence.stat(id);
    if (snapshot !== undefined && snapshot !== null) {
      if (typeof snapshot.sizeBytes === 'number' && typeof snapshot.eventCount === 'number') {
        return 'stat:' + snapshot.sizeBytes + ':' + snapshot.eventCount;
      }
      if (typeof snapshot.revision === 'string' && snapshot.revision.length > 0) {
        return 'rev:' + snapshot.revision;
      }
    }
  }
  return markerOf(await query.listEvents(id));
}

/** Default durable rollup location: the system temp directory, never DSH home. */
export function defaultCachePath() {
  return join(tmpdir(), 'dsh-token-stats', 'rollup-v1.json');
}

/** Read the durable rollup, if it exists and is fresh enough to trust. */
async function loadDurable(state, options) {
  if (state.loaded) return;
  state.loaded = true;
  const path = options.cachePath === undefined ? defaultCachePath() : options.cachePath;
  state.cachePath = path;
  if (path === null) return;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return;
    if (parsed.version !== CACHE_VERSION) return;
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > DURABLE_MAX_AGE_MS) return;
    const sessions = parsed.sessions;
    if (sessions === null || typeof sessions !== 'object') return;
    for (const id of Object.keys(sessions)) {
      const entry = sessions[id];
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.marker !== 'string') continue;
      if (entry.days === null || typeof entry.days !== 'object') continue;
      state.cache.set(id, {
        version: CACHE_VERSION,
        marker: entry.marker,
        days: entry.days,
        error: typeof entry.error === 'string' ? entry.error : undefined,
      });
    }
    // The last aggregate is restored as well, so a freshly booted host can
    // answer a panel open immediately instead of blocking on a full rescan.
    const aggregate = parsed.aggregate;
    if (aggregate !== null && typeof aggregate === 'object' && Array.isArray(aggregate.days) && typeof parsed.aggregateAt === 'number') {
      state.aggregate = aggregate;
      state.aggregateAt = parsed.aggregateAt;
    }
  } catch (e) {
    // A missing, unreadable, or corrupt rollup only costs one full rescan.
  }
}

/** Persist the rollup. Best effort: a failure here must never fail a request. */
async function saveDurable(state, options) {
  if (state.cachePath === null || state.cachePath === undefined) return;
  const sessions = {};
  for (const [id, entry] of state.cache) {
    sessions[id] = entry.error === undefined
      ? { marker: entry.marker, days: entry.days }
      : { marker: entry.marker, days: {}, error: entry.error };
  }
  const body = JSON.stringify({
    version: CACHE_VERSION,
    savedAt: Date.now(),
    sessions,
    aggregate: state.aggregate,
    aggregateAt: state.aggregateAt,
  });
  const temporary = state.cachePath + '.' + process.pid + '.tmp';
  try {
    await mkdir(dirname(state.cachePath), { recursive: true });
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, state.cachePath);
  } catch (e) {
    // Ignored on purpose: the cache is an optimisation, not a source of truth.
  }
}

/**
 * Short, safe description of a per-session read failure.
 *
 * A skipped session silently shrinks a "lifetime" total, so the reason is
 * carried to the panel instead of being logged and forgotten.
 * @param error - whatever the read path threw.
 * @returns a one-line reason.
 */
function describeError(error) {
  if (error === null || error === undefined) return 'unknown error';
  const name = typeof error.name === 'string' && error.name.length > 0 ? error.name + ': ' : '';
  const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : String(error);
  return (name + message).slice(0, 300);
}

/**
 * Resolve human-readable model names for the routes present in the data.
 *
 * The `llm` service is optional: when it is absent, or a route is no longer
 * mounted, the raw id is used instead. Names are advisory decoration only, and
 * resolving them can be slow — an adapter may interrogate its provider — so the
 * answer is cached rather than recomputed for every scan.
 *
 * @param ctx - host context.
 * @param keys - model keys (`provider/model`) to name.
 * @param state - handler state carrying the name cache.
 * @param options - resolved options.
 * @returns a map from model key to display name.
 */
async function resolveModelNames(ctx, keys, state, options) {
  const ttl = typeof options.namesTtlMs === 'number' ? options.namesTtlMs : NAMES_TTL_MS;
  if (state.names !== null && Date.now() - state.namesAt < ttl) return state.names;
  const names = new Map();
  const llm = ctx === undefined || ctx === null ? undefined : ctx.get('llm');
  if (llm === undefined || llm === null || typeof llm.listModels !== 'function') {
    state.names = names;
    state.namesAt = Date.now();
    return names;
  }
  const providers = new Set();
  for (const key of keys) {
    const slash = key.indexOf('/');
    if (slash > 0) providers.add(key.slice(0, slash));
  }
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider);
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (model === null || typeof model !== 'object') continue;
        if (typeof model.id !== 'string' || model.id.length === 0) continue;
        const label = typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id;
        names.set(provider + '/' + model.id, label);
      }
    } catch (e) {
      // An unmounted or failing provider leaves its routes on their raw ids.
    }
  }
  state.names = names;
  state.namesAt = Date.now();
  return names;
}

/**
 * Turn the per-session rollups into the wire payload.
 *
 * Ranking uses the default metric (uncached input + output) so that the model
 * slices stay stable while the user switches metrics; the tail beyond
 * {@link MAX_MODELS} is merged into one slice rather than dropped.
 *
 * @param cache - session id to `{ marker, days }`.
 * @param names - model key to display name.
 * @param maxModels - how many models keep their own slice.
 * @returns the payload value.
 */
export function buildPayload(cache, names, maxModels) {
  const perModel = new Map();
  for (const entry of cache.values()) {
    for (const day of Object.keys(entry.days)) {
      const models = entry.days[day];
      for (const key of Object.keys(models)) {
        const buckets = models[key];
        const running = perModel.get(key) === undefined ? [0, 0, 0, 0] : perModel.get(key);
        for (let i = 0; i < 4; i += 1) running[i] += toCount(buckets[i]);
        perModel.set(key, running);
      }
    }
  }

  const ranked = [...perModel.keys()].sort((a, b) => {
    const left = perModel.get(a);
    const right = perModel.get(b);
    const byMetric = (right[0] + right[1]) - (left[0] + left[1]);
    return byMetric !== 0 ? byMetric : a.localeCompare(b);
  });
  const kept = ranked.slice(0, Math.max(1, maxModels));
  const overflow = ranked.length > kept.length;
  const index = new Map();
  kept.forEach((key, i) => index.set(key, i));
  const otherIndex = kept.length;

  const models = kept.map((key) => {
    const slash = key.indexOf('/');
    const provider = key === UNKNOWN_MODEL_KEY ? '' : key.slice(0, slash);
    const model = key === UNKNOWN_MODEL_KEY ? '' : key.slice(slash + 1);
    return {
      key,
      provider,
      model,
      name: names.get(key) === undefined ? model : names.get(key),
      buckets: perModel.get(key),
    };
  });
  if (overflow) {
    models.push({ key: OTHER_MODEL_KEY, provider: '', model: '', name: '', buckets: [0, 0, 0, 0] });
  }

  /** @type {Map<string, { b: number[], m: Map<number, number[]> }>} */
  const days = new Map();
  for (const entry of cache.values()) {
    for (const day of Object.keys(entry.days)) {
      const bucket = days.get(day) === undefined ? { b: [0, 0, 0, 0], m: new Map() } : days.get(day);
      const modelsForDay = entry.days[day];
      for (const key of Object.keys(modelsForDay)) {
        const source = modelsForDay[key];
        const target = index.has(key) ? index.get(key) : otherIndex;
        const slot = bucket.m.get(target) === undefined ? [0, 0, 0, 0] : bucket.m.get(target);
        for (let i = 0; i < 4; i += 1) {
          const value = toCount(source[i]);
          slot[i] += value;
          bucket.b[i] += value;
        }
        bucket.m.set(target, slot);
        if (target === otherIndex && overflow) {
          for (let i = 0; i < 4; i += 1) models[otherIndex].buckets[i] += toCount(source[i]);
        }
      }
      days.set(day, bucket);
    }
  }

  const ordered = [...days.keys()].sort();
  return {
    models,
    days: ordered.map((day) => ({
      d: day,
      b: days.get(day).b,
      m: [...days.get(day).m.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([target, buckets]) => [target, buckets[0], buckets[1], buckets[2], buckets[3]]),
    })),
    range: { first: ordered.length === 0 ? null : ordered[0], last: ordered.length === 0 ? null : ordered[ordered.length - 1] },
  };
}

/**
 * Resolve the session query service, or explain why this composition cannot
 * work at all.
 *
 * Checked before any cache is consulted: a host with no sessionQuery can neither
 * scan nor refresh, so serving whatever a previous, working host left in the
 * durable rollup would show numbers the panel can never update or explain.
 *
 * @param ctx - host context.
 * @param options - resolved options.
 * @returns the session query service.
 * @throws {StatsError} when the service is not mounted or does not fit the shape.
 */
function requireQuery(ctx, options) {
  const query = options.sessionQuery !== undefined ? options.sessionQuery : ctx.get('sessionQuery');
  if (query === undefined || query === null) {
    throw new StatsError(
      'token-stats/no-session-query',
      'the sessionQuery service is not mounted in this composition, so session logs cannot be read',
    );
  }
  if (typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
    throw new StatsError('token-stats/no-session-query', 'the sessionQuery service is missing listSessions/readSession');
  }
  return query;
}

/**
 * Scan every session, reusing the rollup for logs that have not grown.
 *
 * @param ctx - host context.
 * @param state - handler state.
 * @param options - resolved options.
 * @returns the wire payload value.
 * @throws {StatsError} when the session query service is not mounted.
 */
async function collect(ctx, state, options) {
  const query = requireQuery(ctx, options);
  // Optional fast path for change detection; without it every scan falls back
  // to parsing each log through listEvents.
  const persistence = options.sessionPersistence !== undefined ? options.sessionPersistence : ctx.get('sessionPersistence');

  const startedAt = Date.now();
  const timings = {};
  await loadDurable(state, options);

  const listStarted = Date.now();
  const records = await query.listSessions();
  timings.list = Date.now() - listStarted;
  const scope = { sessions: records.length, read: 0, reused: 0, failed: 0, seeded: 0, failedSessions: [] };
  const live = new Set();

  for (const record of records) {
    // Parsing and folding a changed session runs synchronously on the host's
    // only thread, and the live session's log is tens of megabytes, so a scan
    // used to hold the loop for its whole duration: a panel request arriving
    // mid-scan waited 0.5–3.9s behind it even though its answer was already in
    // the cache. One macrotask per session lets that answer out between them.
    await yieldToLoop();
    const header = record === null || typeof record !== 'object' ? null : record.header;
    if (header === null || header === undefined) continue;
    const id = String(header.id);
    live.add(id);
    if (header.isSeeded === true) scope.seeded += 1;

    let marker;
    try {
      marker = await markerFor(query, persistence, record);
    } catch (e) {
      scope.failed += 1;
      scope.failedSessions.push({ id, error: describeError(e) });
      state.cache.delete(id);
      continue;
    }
    const hit = state.cache.get(id);
    if (hit !== undefined && hit.version === CACHE_VERSION && hit.marker === marker) {
      // A failing session is remembered together with the marker it failed at,
      // so it is retried only once its log actually changes. Without this, every
      // scan re-read and re-rejected the same unreadable logs at full cost.
      if (typeof hit.error === 'string') {
        scope.failed += 1;
        scope.failedSessions.push({ id, error: hit.error });
        continue;
      }
      scope.reused += 1;
      continue;
    }

    let snapshot;
    try {
      snapshot = await query.readSession(id);
    } catch (e) {
      const error = describeError(e);
      scope.failed += 1;
      scope.failedSessions.push({ id, error });
      state.cache.set(id, { version: CACHE_VERSION, marker, error, days: {} });
      continue;
    }
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    const inherited = toCount(snapshot.inheritedEventCount);
    const own = inherited <= 0 ? events : inherited >= events.length ? [] : events.slice(inherited);
    const folded = foldSession(own, options);
    state.cache.set(id, { version: CACHE_VERSION, marker, days: folded.days, savedAt: Date.now() });
    scope.read += 1;
  }

  // Sessions that no longer appear in the listing keep their last known buckets
  // instead of being dropped: a "lifetime" figure that shrinks whenever an old
  // session is archived or removed would be worse than useless. Set
  // `retainSessions: false` to make the totals reflect only live logs.
  let retired = 0;
  for (const id of [...state.cache.keys()]) {
    const entry = state.cache.get(id);
    if (live.has(id)) {
      entry.retired = false;
      continue;
    }
    if (options.retainSessions === false) {
      state.cache.delete(id);
      continue;
    }
    entry.retired = true;
    retired += 1;
  }
  scope.retired = retired;

  const namesStarted = Date.now();
  const names = await resolveModelNames(ctx, modelKeys(state.cache), state, options);
  timings.names = Date.now() - namesStarted;
  const payload = buildPayload(state.cache, names, options.maxModels);

  const value = {
    generatedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    timings,
    scope,
    models: payload.models,
    days: payload.days,
    range: payload.range,
  };
  // Publish before persisting, so the durable copy carries this aggregate rather
  // than the previous one.
  state.aggregate = value;
  state.aggregateAt = Date.now();
  const saveStarted = Date.now();
  await saveDurable(state, options);
  timings.save = Date.now() - saveStarted;

  return value;
}

/** Every model key present in the rollup. */
function modelKeys(cache) {
  const keys = new Set();
  for (const entry of cache.values()) {
    for (const day of Object.keys(entry.days)) {
      for (const key of Object.keys(entry.days[day])) keys.add(key);
    }
  }
  return keys;
}

/**
 * Build the handler map the host route dispatches on.
 *
 * @param ctx - host Cordis context.
 * @param options - test seams: `sessionQuery`, `sessionPersistence`,
 *   `retainSessions`, `cachePath`, `maxModels`, `aggregateTtlMs`, `dayKey`.
 * @returns `{ summary, refresh }` — both answering the same payload.
 */
export function createHandlers(ctx, options = {}) {
  const resolved = {
    sessionQuery: options.sessionQuery,
    sessionPersistence: options.sessionPersistence,
    retainSessions: options.retainSessions,
    cachePath: options.cachePath,
    maxModels: typeof options.maxModels === 'number' ? options.maxModels : MAX_MODELS,
    aggregateTtlMs: typeof options.aggregateTtlMs === 'number' ? options.aggregateTtlMs : AGGREGATE_TTL_MS,
    dayKey: options.dayKey,
  };
  const state = { cache: new Map(), loaded: false, cachePath: undefined, aggregate: null, aggregateAt: 0, inFlight: null, names: null, namesAt: 0 };

  /**
   * Run one scan, coalescing concurrent callers onto a single pass.
   * @returns the fresh payload value.
   */
  async function refresh() {
    if (state.inFlight !== null) return state.inFlight;
    const pending = collect(ctx, state, resolved);
    state.inFlight = pending;
    const settle = () => { if (state.inFlight === pending) state.inFlight = null; };
    pending.then(settle, settle);
    return pending;
  }

  /** Tag one answer so the client knows whether a refresh is still coming. */
  const answer = (value, stale) => Object.assign({}, value, { stale });

  /**
   * Serve one aggregate.
   *
   * Once any aggregate exists it is answered immediately, even past its TTL, and
   * the rescan happens behind the response. A rescan has to read the live
   * session's entire log (~27MB decompressed on the machine this was built
   * against), which took 1–2s, and every panel open used to wait for it. The
   * answer carries `stale: true` so the client can ask again shortly.
   *
   * @param args - `{ force?: boolean }`.
   * @returns the payload value.
   */
  async function summary(args) {
    const force = args !== null && typeof args === 'object' && args.force === true;
    // Before any cache: a composition that cannot scan must say so, not serve
    // numbers from a durable rollup it can never refresh.
    requireQuery(ctx, resolved);
    // Load before deciding: the durable copy carries the last aggregate, which is
    // what lets a freshly booted host answer a panel open without scanning.
    // Cheap after the first call.
    await loadDurable(state, resolved);
    if (!force) {
      const fresh = state.aggregate !== null && Date.now() - state.aggregateAt < resolved.aggregateTtlMs;
      if (fresh) return answer(state.aggregate, false);
      if (state.aggregate !== null) {
        // Behind the response; a failure leaves the stale answer in place and the
        // next request tries again.
        refresh().catch(() => {});
        return answer(state.aggregate, true);
      }
    }
    return answer(await refresh(), false);
  }

  return {
    summary,
    refresh: (args) => summary(Object.assign({}, args === null || typeof args !== 'object' ? {} : args, { force: true })),
  };
}
