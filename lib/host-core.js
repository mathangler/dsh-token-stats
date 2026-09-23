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
 * ## Why a live session is observed rather than read
 *
 * The session being written right now is both the largest log on the machine and
 * the only one that changes between two scans, so it decides the cost of a
 * refresh. Reading it through `readSession` hands back a deep copy of the whole
 * event graph (every event is `structuredClone`d) and validating it replays the
 * log — ~4.9s for the 4.9k-event / ~31MB session measured here, on the host's
 * only thread. `observeSession` publishes the same log as a lazy snapshot plus
 * an O(1) last-seq cursor, and the fold only needs to read it, so a refresh now
 * costs tens of milliseconds instead of seconds.
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

/**
 * How long one scan may spend deriving day/model splits from logs.
 *
 * A split is the only part of a session's numbers the platform does not record,
 * and deriving it means reading that session's log. On the corpus this was built
 * against a full cold derivation cost ~20s, which is not something a panel open
 * may wait for — but it is also not needed to report correct totals, because the
 * platform supplies those from its own cache.
 *
 * This is deliberately a fraction of a second rather than a couple of seconds: the
 * budget is what a refresh *spends*, not what it might, and the remaining sessions
 * are picked up by the scan after it. Measured on the corpus this was tuned
 * against, 1s was enough to place every session that had never been placed (the
 * ones the panel shows a placeholder for) while keeping a refresh under 1.5s.
 */
const SPLIT_BUDGET_MS = 1000;

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
 * The buckets this produces are the panel's own per-day/per-model split. They are
 * reconciled against the platform's authoritative total for the same session
 * when one is available (see `options.total`), because the platform's
 * `tokenUsage` projection is the number every other surface reports and the two
 * must not disagree on screen.
 *
 * @param events - the session's events, with any forked prefix already removed.
 * @param options - `dayKey(ms)` override for tests, and `total` — the platform's
 *   four buckets for this session, when the projection cache had them.
 * @returns `{ days, samples, unpriced, total }` where `days[day][modelKey]` is a
 *   four-element bucket array, `samples` is how many usage samples were read, and
 *   `total` is the reconciled session total.
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
  const folded = [0, 0, 0, 0];
  for (const slot of slots.values()) {
    const day = days[slot.day] === undefined ? (days[slot.day] = {}) : days[slot.day];
    const buckets = day[slot.model] === undefined ? (day[slot.model] = [0, 0, 0, 0]) : day[slot.model];
    for (let i = 0; i < 4; i += 1) {
      buckets[i] += slot.buckets[i];
      folded[i] += slot.buckets[i];
    }
  }

  // Reconcile with the platform's own total for this session when it has one.
  //
  // The two folds read the same events but not at the same cut, and they apply
  // the replacement rule with different scopes, so they can disagree on a retry
  // or on a session whose log grew between the cache write and this read. The
  // platform's `tokenUsage` is what every other surface and the model itself
  // reports, so it wins the session total; the difference is then distributed
  // over the days and models folded here in proportion, keeping the shape of the
  // data while making the sums agree with the rest of the harness.
  const authoritative = options.total === undefined || options.total === null ? null : options.total.buckets;
  if (authoritative !== null && slots.size > 0 && folded.some((value) => value > 0)) {
    const target = authoritative.map(toCount);
    const drift = target.map((value, i) => value - folded[i]);
    if (drift.some((delta) => delta !== 0)) {
      for (const day of Object.keys(days)) {
        for (const model of Object.keys(days[day])) {
          const buckets = days[day][model];
          for (let i = 0; i < 4; i += 1) {
            if (drift[i] === 0 || folded[i] === 0) continue;
            buckets[i] = Math.max(0, Math.round((buckets[i] * target[i]) / folded[i]));
          }
        }
      }
      // Rounding leaves a few tokens behind, and a bucket the fold never saw is
      // still short by its whole value. The newest day's busiest model absorbs
      // the residual, so the session total is exact rather than approximately
      // right while every other cell keeps its proportion.
      const newest = Object.keys(days).sort().pop();
      const models = newest === undefined ? undefined : days[newest];
      const anchor = models === undefined ? undefined : busiestModel(models);
      if (anchor !== undefined) {
        const residual = target.map((value, i) => value - totalOf(days)[i]);
        for (let i = 0; i < 4; i += 1) models[anchor][i] = Math.max(0, models[anchor][i] + residual[i]);
      }
    }
  }
  return { days, samples: slots.size, unpriced };
}

/** Sum one day × model table into four buckets. */
function totalOf(days) {
  const total = [0, 0, 0, 0];
  for (const day of Object.keys(days)) {
    for (const model of Object.keys(days[day])) {
      const buckets = days[day][model];
      for (let i = 0; i < 4; i += 1) total[i] += toCount(buckets[i]);
    }
  }
  return total;
}

/**
 * The inherited-prefix length of a stored session, if the handle reports one.
 *
 * A seeded (forked) session's stored log begins with its parent's events; the
 * fold must skip that prefix or the fork is counted twice. The length comes from
 * the handle, and a handle that cannot supply it means the caller's slice is
 * already the session's own.
 *
 * @param persistence - the `sessionPersistence` service.
 * @param id - the session to inspect.
 * @returns the inherited event count, or null when the handle is unavailable.
 */
async function storedInherited(persistence, id) {
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') return null;
  let handle;
  try {
    handle = await persistence.open(id, 'read');
  } catch (e) {
    return null;
  }
  try {
    return toCount(handle.inheritedEventCount);
  } catch (e) {
    return null;
  } finally {
    try {
      await handle.close();
    } catch (e) {
      // A handle that refuses to close must not fail a scan.
    }
  }
}

/**
 * Read one stored log through the persistence handle, without replay validation.
 *
 * `sessionQuery.readSession` returns a *validated* snapshot: it replays the log
 * to prove it is well-formed, which is right for resuming a session and far too
 * much for counting usage. The persistence handle's own `read` returns the stored
 * events as they were written — measured on this machine, the same 14-session
 * corpus that costs 29.9s through `readSession` arrives here in ~3.3s cold and
 * ~1ms warm.
 *
 * @param persistence - the `sessionPersistence` service, if mounted.
 * @param id - the session to read.
 * @returns the stored events, or null when the handle path is unavailable.
 */
async function readStoredEvents(persistence, id) {
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') return null;
  let handle;
  try {
    handle = await persistence.open(id, 'read');
  } catch (e) {
    return null;
  }
  try {
    const stored = await handle.read(0, Number.MAX_SAFE_INTEGER);
    return Array.isArray(stored.events) ? stored.events : null;
  } catch (e) {
    return null;
  } finally {
    try {
      await handle.close();
    } catch (e) {
      // A handle that refuses to close must not fail a scan.
    }
  }
}

/** The model key carrying the most tokens on one day, for residual absorption. */
function busiestModel(models) {
  let best;
  let bestValue = -1;
  for (const key of Object.keys(models)) {
    const buckets = models[key];
    const value = buckets[0] + buckets[1] + buckets[2] + buckets[3];
    if (value > bestValue) {
      bestValue = value;
      best = key;
    }
  }
  return best;
}

/**
 * Fold a session the platform can account for but whose log cannot be read.
 *
 * The projection cache's total carries no date, and the log that would date it is
 * exactly what is missing, so the amount is parked on the day the session was
 * created — the log's own header carries that — under the unknown-model key. The
 * session's *total* is therefore right, which is what a lifetime figure has to
 * be; only its placement on the calendar is a guess, and it is a documented one
 * rather than a silent disappearance.
 *
 * @param buckets - the four cached buckets.
 * @param options - fold options; `createdAt(header)` supplies the parking day.
 * @returns a day × model table holding the whole amount.
 */
function foldCachedOnly(buckets, options) {
  const dayKey = typeof options.dayKey === 'function' ? options.dayKey : localDayKey;
  const created = typeof options.createdAt === 'number' && Number.isFinite(options.createdAt) ? options.createdAt : 0;
  const day = dayKey(created);
  return { [day]: { [UNKNOWN_MODEL_KEY]: buckets.map(toCount) } };
}

/**
 * The lifecycle identity a projection-cache record is bound to.
 *
 * `dsh-session-projection-cache` keys every durable record by the session's
 * lifecycle — format generation, creation time, working directory, and whether
 * the log is a seeded fork — so a recreated id or a swapped store can never
 * seed state folded from an unrelated log. A listed header (from
 * `sessionPersistence.list()` or `sessionQuery.listSessions()`) carries exactly
 * these fields, which is what makes a zero-I/O read possible at all: the
 * identity is checkable without opening, reading, or even stat-ing the log.
 *
 * @param header - one session header.
 * @returns the identity object the cache compares against.
 */
export function lifecycleIdentity(header) {
  return {
    formatVersion: header.version,
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    isSeeded: header.isSeeded === true,
    inheritedEventCount: 0,
  };
}

/**
 * Read the platform's own token totals for a set of sessions without a log read.
 *
 * This is the fast path that makes a refresh cheap. `dsh-token-meter` registers
 * a `tokenUsage` projection unit; `dsh-session-projection-cache` checkpoints it
 * durably on every turn boundary, so the harness has already folded and stored
 * every session's provider-reported totals. Reading them back is a Map lookup
 * and a schema check per session — measured on this machine: 10 of 14 sessions
 * answered from cache in 2ms, where re-deriving the same numbers from the logs
 * through `sessionQuery.readSession` cost 11.1s.
 *
 * The rows are only a *total*, per session, with no day or model breakdown —
 * the projection's own contract is one whole value — so this complements
 * {@link foldSession} rather than replacing it: the panel keeps its own
 * per-day/per-model fold for everything the platform does not record.
 *
 * @param projectionCache - optional `sessionProjectionCache` service.
 * @param projections - optional `sessionProjections` registry (to view rows).
 * @param heads - session headers to answer for.
 * @returns a map from session id to `{ uncachedInput, output, cacheRead, cacheWrite, asOfSeq }`.
 */
export function readCachedUsage(projectionCache, projections, heads) {
  const usage = new Map();
  if (projectionCache === undefined || projectionCache === null || projections === undefined || projections === null) return usage;
  if (typeof projectionCache.recordFor !== 'function') return usage;
  for (const header of heads) {
    const id = String(header.id);
    const found = cachedTotalsFor(projectionCache, projections, header);
    if (found !== undefined) usage.set(id, found);
  }
  return usage;
}

/**
 * The platform's own token totals for one session, or undefined.
 *
 * The cache binds a record to a session's *lifecycle* — format generation,
 * creation time, working directory, seeded flag. A harness upgrade that migrates
 * stored logs from one format generation to the next rewrites the stored header's
 * `version` while leaving the log's events — and therefore its usage — intact, so
 * an exact-generation lookup suddenly misses every session the upgrade touched.
 * Measured on this machine after a v3→v4 migration: 4 of 25 sessions lost their
 * cached totals that way, and re-deriving them from logs added ~1.7s to every cold
 * start.
 *
 * A row from an *older* generation is therefore still read, because the fold that
 * produced it counts the same usage events: the format generation governs how a log
 * is decoded, not how many tokens it reports. A row from a *newer* generation is
 * not, because this module cannot know what a future fold changed. The caller is
 * told which generation answered so it can decide how much to trust it.
 *
 * @param projectionCache - the `sessionProjectionCache` service.
 * @param projections - the `sessionProjections` registry.
 * @param header - the session header to answer for.
 * @returns `{ buckets, seq, generation }`, or undefined when nothing usable exists.
 */
function cachedTotalsFor(projectionCache, projections, header) {
  const id = String(header.id);
  const attempts = [header.version];
  // One step back covers a migration that just ran; anything older is not worth
  // guessing about, and `readSession` handles it anyway.
  if (typeof header.version === 'number' && header.version > 0) attempts.push(header.version - 1);

  for (const generation of attempts) {
    const identity = { ...lifecycleIdentity(header), formatVersion: generation };
    let record;
    try {
      record = projectionCache.recordFor(id, identity);
    } catch (e) {
      continue;
    }
    if (record === undefined || record === null || record.rows === undefined || record.rows === null) continue;
    let viewed;
    try {
      viewed = projections.viewCheckpoint(record.rows, ['tokenUsage']);
    } catch (e) {
      continue;
    }
    const totals = viewed === undefined || viewed === null ? undefined : viewed.tokenUsage;
    if (totals === undefined || totals === null) continue;
    return {
      buckets: [
        toCount(totals.uncachedInputTokens),
        toCount(totals.outputTokens),
        toCount(totals.cacheReadTokens),
        toCount(totals.cacheWriteTokens),
      ],
      // The row's watermark: the last seq it folded through. Kept so a caller
      // can tell how stale the cached total is.
      seq: typeof record.rows.tokenUsage?.seq === 'number' ? record.rows.tokenUsage.seq : -1,
      // Which format generation the row was folded under, so a caller can treat a
      // migrated row as a total to reconcile rather than as ground truth about
      // placement.
      generation: typeof record.identity?.formatVersion === 'number' ? record.identity.formatVersion : generation,
      migrated: generation !== header.version,
    };
  }
  return undefined;
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

/** `Symbol.dispose` on this runtime (Node >= 20), used to release an observation. */
const DISPOSE = typeof Symbol.dispose === 'symbol' ? Symbol.dispose : undefined;

/**
 * The part of one session's log the fold must count.
 *
 * A forked session's log carries its parent's events as a leading prefix; that
 * prefix is `inheritedEventCount` long and is skipped here, or every fork would
 * be counted twice.
 *
 * @param source - `{ events, inheritedEventCount }` from a query read.
 * @returns the session's own events.
 */
function ownEvents(source) {
  // Read the property once: on a live observation `events` is a getter that
  // publishes the log snapshot on first access.
  const published = source.events;
  const events = Array.isArray(published) ? published : [];
  const inherited = toCount(source.inheritedEventCount);
  if (inherited <= 0) return events;
  return inherited >= events.length ? [] : events.slice(inherited);
}

/**
 * Release one point observation.
 *
 * An observation holds a lease on an exact cut of a log: for a cold session that
 * lease pins the restored log in the query service's bounded cache, so leaving
 * it open would evict somebody else's entry for good. The events this module
 * keeps are its own slice, so they stay valid after the release, and a lease
 * that refuses disposal must never fail a scan.
 *
 * @param observation - the observation returned by {@link inspectSession}, if any.
 */
function releaseObservation(observation) {
  if (observation === undefined || observation === null || DISPOSE === undefined) return;
  const dispose = observation[DISPOSE];
  if (typeof dispose !== 'function') return;
  try {
    dispose.call(observation);
  } catch (e) {
    // Only cost: one cache slot in the query service until the next read.
  }
}

/**
 * Decide whether one session's cached buckets are still valid, as cheaply as
 * the query service allows.
 *
 * Two sources, in increasing cost:
 *
 * - A persisted session that is not live answers from stored metadata alone.
 *   The load-bearing field is `eventCount` — a finished log is append-only, so
 *   its event count changes exactly when its content does. `sizeBytes` is only
 *   consulted when there is no count, because the byte size also moves when the
 *   store re-compresses an unchanged log, and keying on it made every refresh
 *   re-read every large session for nothing.
 * - A live session has no trustworthy durable size — its newest events may not
 *   have reached disk — so it is *observed*. `query.observeSession` answers a
 *   live session's last seq in O(1) and publishes its events as a lazy snapshot
 *   that copies nothing until it is read.
 *
 * A composition whose `sessionQuery` predates `observeSession` keeps the old
 * path, so the panel still works against an older harness.
 *
 * @param query - the session query service.
 * @param persistence - optional `sessionPersistence` service.
 * @param record - one `SessionRecord`.
 * @returns `{ marker, observation }`; `observation` is present only when one was
 *   taken, and its holder must fold it and then release it.
 */
async function inspectSession(query, persistence, record) {
  const id = String(record.header.id);
  if (record.live !== true) {
    if (persistence !== undefined && persistence !== null && typeof persistence.stat === 'function') {
      let snapshot;
      try {
        snapshot = await persistence.stat(id);
      } catch (e) {
        snapshot = undefined;
      }
      if (snapshot !== undefined && snapshot !== null) {
        if (typeof snapshot.eventCount === 'number') {
          return { marker: 'ev:' + snapshot.eventCount };
        }
        if (typeof snapshot.sizeBytes === 'number') {
          return { marker: 'sz:' + snapshot.sizeBytes };
        }
        if (typeof snapshot.revision === 'string' && snapshot.revision.length > 0) {
          return { marker: 'rev:' + snapshot.revision };
        }
      }
    }
    return { marker: markerOf(await query.listEvents(id)) };
  }
  if (typeof query.observeSession === 'function') {
    const observation = await query.observeSession(id, { projectionMode: 'none' });
    // `cursor` is the log's last seq, so it advances on every append; the
    // inherited prefix length identifies which cut the marker describes.
    const cursor = typeof observation.cursor === 'number' && Number.isFinite(observation.cursor) ? observation.cursor : -1;
    return { marker: 'obs:' + cursor + ':' + toCount(observation.inheritedEventCount), observation };
  }
  return { marker: markerOf(await query.listEvents(id)) };
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
        cachedBuckets: Array.isArray(entry.cachedBuckets) && entry.cachedBuckets.length === 4 ? entry.cachedBuckets : undefined,
        cachedSeq: typeof entry.cachedSeq === 'number' ? entry.cachedSeq : undefined,
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
    if (typeof entry.error === 'string') {
      sessions[id] = { marker: entry.marker, days: {}, error: entry.error };
      continue;
    }
    const row = { marker: entry.marker, days: entry.days };
    // The platform total this split was reconciled against travels with it, so a
    // restarted host can take the same cheap exit instead of recomputing a marker
    // for every session (see the cheap exit in `collect`).
    if (Array.isArray(entry.cachedBuckets) && typeof entry.cachedSeq === 'number') {
      row.cachedBuckets = entry.cachedBuckets;
      row.cachedSeq = entry.cachedSeq;
    }
    sessions[id] = row;
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
  // Optional, and the reason a refresh is cheap: the platform's own token totals
  // for every session, already folded and checkpointed by token-meter and the
  // projection cache. See {@link readCachedUsage}.
  const projectionCache = options.sessionProjectionCache !== undefined ? options.sessionProjectionCache : ctx.get('sessionProjectionCache');
  const projections = options.sessionProjections !== undefined ? options.sessionProjections : ctx.get('sessionProjections');

  const startedAt = Date.now();
  const timings = {};
  await loadDurable(state, options);

  const listStarted = Date.now();
  const records = await query.listSessions();
  timings.list = Date.now() - listStarted;
  const scope = { sessions: records.length, read: 0, reused: 0, failed: 0, seeded: 0, failedSessions: [], cached: 0, deferred: 0 };
  const live = new Set();

  // The platform's totals come from the cache in one pass, before any log is
  // touched. On the corpus measured here this answers most sessions outright.
  const cacheStarted = Date.now();
  const heads = [];
  for (const record of records) {
    const header = record === null || typeof record !== 'object' ? null : record.header;
    if (header !== null && header !== undefined) heads.push(header);
  }
  const cachedUsage = readCachedUsage(projectionCache, projections, heads);
  timings.cached = Date.now() - cacheStarted;

  // Which sessions still need a log read to place their usage on the calendar.
  //
  // A session needs one only when its day/model split is unknown or stale. When
  // the platform's own total is cached AND this scan already published a split
  // reconciled against that same platform row, the split is proven current
  // without touching the log. Everything else — a session the cache has never
  // seen, a fork, a log that grew — needs the read, and the read is what a cold
  // start pays for.
  const needsSplit = new Set();
  /** Sessions whose day/model split was never derived, so the panel is showing a placeholder for them. */
  const unplaced = new Set();
  for (const record of records) {
    const header = record === null || typeof record !== 'object' ? null : record.header;
    if (header === null || header === undefined) continue;
    const id = String(header.id);
    const known = cachedUsage.get(id);
    const previous = state.cache.get(id);
    const carry = known !== undefined
      && previous !== undefined
      && previous.version === CACHE_VERSION
      && Array.isArray(previous.cachedBuckets)
      && previous.cachedSeq === known.seq
      && typeof previous.error !== 'string'
      && header.isSeeded !== true;
    if (known !== undefined && carry) {
      scope.cached += 1;
      scope.reused += 1;
      live.add(id);
      continue;
    }
    needsSplit.add(id);
    // A session that still has to be read and has never had a split derived is
    // the one whose panel entry is a placeholder, so it goes first: the budget is
    // small, and spending it on a session that already has a real split while a
    // placeholder waits would keep the panel's least exact number on screen.
    if (previous === undefined || previous.version !== CACHE_VERSION || !Array.isArray(previous.cachedBuckets)) {
      unplaced.add(id);
    }
  }

  // Every session whose split is already known is now answered; only the rest are
  // read. `splitBudgetMs` bounds how long a single scan may spend deriving splits:
  // a cold start on a large corpus can want tens of seconds of log reading, and
  // holding a refresh for all of it is exactly the slowness this module exists to
  // avoid. Whatever is left over keeps the previous split (or the platform total
  // alone) and is picked up by the scan that follows.
  const budget = typeof options.splitBudgetMs === 'number' ? options.splitBudgetMs : SPLIT_BUDGET_MS;
  const splitStarted = Date.now();
  const deferred = [];
  /** Deferred sessions with no platform total either; these cannot be reported at all. */
  const deferred_no_total = [];

  // Work the sessions whose panel entry is still a placeholder before those that
  // merely need confirmation, and among each group the smallest logs first: the
  // budget is time-based, so reaching more sessions for the same seconds means
  // fewer placeholders on screen after one refresh.
  const queue = records
    .filter((record) => {
      const header = record === null || typeof record !== 'object' ? null : record.header;
      return header !== null && header !== undefined && needsSplit.has(String(header.id));
    })
    .map((record) => {
      const header = record.header;
      const id = String(header.id);
      const known = cachedUsage.get(id);
      return { record, id, unplaced: unplaced.has(id) ? 0 : 1, size: known === undefined ? 0 : known.seq };
    })
    .sort((left, right) => (left.unplaced - right.unplaced) || (left.size - right.size));

  for (const item of queue) {
    // Parsing and folding a changed session runs synchronously on the host's
    // only thread, and the live session's log is tens of megabytes, so a scan
    // used to hold the loop for its whole duration: a panel request arriving
    // mid-scan waited 0.5–3.9s behind it even though its answer was already in
    // the cache. One macrotask per session lets that answer out between them.
    await yieldToLoop();
    const record = item.record;
    const header = record === null || typeof record !== 'object' ? null : record.header;
    if (header === null || header === undefined) continue;
    const id = item.id;
    live.add(id);
    if (header.isSeeded === true) scope.seeded += 1;

    // The platform's authoritative total for this session, when the projection
    // cache had one. It both reconciles the fold below and lets a session whose
    // log cannot be read at all still be counted.
    const known = cachedUsage.get(id);

    // Second cheap exit: a session parked on its platform total by an earlier
    // scan. The placement recorded then was reconciled against exactly this
    // platform row, so it is still right and needs no read — and testing it here,
    // before the budget, is what stops a starved scan from re-parking the same
    // sessions forever when the budget is small.
    const previous = state.cache.get(id);
    if (
      known !== undefined
      && previous !== undefined
      && previous.version === CACHE_VERSION
      && Array.isArray(previous.cachedBuckets)
      && previous.cachedSeq === known.seq
      && typeof previous.error !== 'string'
    ) {
      state.cache.set(id, { ...previous, marker: previous.marker, savedAt: Date.now() });
      scope.cached += 1;
      scope.reused += 1;
      continue;
    }

    if (Date.now() - splitStarted > budget) {
      deferred.push(record);
      continue;
    }
    if (known !== undefined) scope.cached += 1;

    let seen;
    try {
      seen = await inspectSession(query, persistence, record);
    } catch (e) {
      // No marker at all: even the session's metadata is unreachable. A cached
      // total is still a real fact about this session, so it is kept rather than
      // dropped — a "lifetime" figure that quietly loses a session the platform
      // can still account for would be the worse failure.
      if (known !== undefined) {
        const rescued = foldCachedOnly(known.buckets, { ...options, createdAt: header.createdAt });
        state.cache.set(id, {
          version: CACHE_VERSION,
          marker: 'cache:' + known.seq,
          days: rescued,
          cachedBuckets: known.buckets,
          cachedSeq: known.seq,
          savedAt: Date.now(),
        });
        scope.read += 1;
        continue;
      }
      scope.failed += 1;
      scope.failedSessions.push({ id, error: describeError(e) });
      state.cache.delete(id);
      continue;
    }
    const hit = state.cache.get(id);
    if (hit !== undefined && hit.version === CACHE_VERSION && hit.marker === seen.marker) {
      // A failing session is remembered together with the marker it failed at,
      // so it is retried only once its log actually changes. Without this, every
      // scan re-read and re-rejected the same unreadable logs at full cost.
      releaseObservation(seen.observation);
      if (typeof hit.error === 'string') {
        scope.failed += 1;
        scope.failedSessions.push({ id, error: hit.error });
        continue;
      }
      scope.reused += 1;
      continue;
    }

    // The log needs re-reading, or the split was never derived. When the platform
    // HAS a total for this session and its row has not moved since the last split
    // was derived, the split that was derived then is still correct: the log's
    // usage content is exactly what produced that platform total. Adopting the
    // previous split under the new marker is what turns a cold start from a
    // full-corpus re-read into a marker pass.
    if (
      known !== undefined
      && hit !== undefined
      && hit.version === CACHE_VERSION
      && Array.isArray(hit.cachedBuckets)
      && hit.cachedSeq === known.seq
      && typeof hit.error !== 'string'
    ) {
      releaseObservation(seen.observation);
      state.cache.set(id, {
        version: CACHE_VERSION,
        marker: seen.marker,
        days: hit.days,
        cachedBuckets: known.buckets,
        cachedSeq: known.seq,
        savedAt: Date.now(),
      });
      scope.reused += 1;
      continue;
    }

    let own;
    if (seen.observation === undefined) {
      // A closed session is read through the persistence handle first. The query
      // service's `readSession` is a *validated* read: it replays the whole log to
      // prove it is well-formed, which is right before resuming a session and far
      // too much for counting usage. Measured on this machine over the same
      // 14-session corpus: `readSession` 29.9s against the handle path's ~3.3s,
      // with identical totals. The query read stays as the fallback for a
      // composition whose persistence service is not mounted.
      own = await readStoredEvents(persistence, id);
      if (own === null) {
        try {
          own = ownEvents(await query.readSession(id));
        } catch (e) {
          // The log is unreadable by every path this composition offers. A cached
          // platform total is still a real fact about the session, so it is kept
          // whole rather than dropped: a "lifetime" figure that quietly loses a
          // session the rest of the harness can account for would be the worse
          // failure. Only the placement on the calendar is a guess.
          if (known !== undefined) {
            const rescued = foldCachedOnly(known.buckets, { ...options, createdAt: header.createdAt });
            state.cache.set(id, { version: CACHE_VERSION, marker: 'cache:' + known.seq, days: rescued, savedAt: Date.now() });
            scope.read += 1;
            continue;
          }
          const error = describeError(e);
          scope.failed += 1;
          scope.failedSessions.push({ id, error });
          state.cache.set(id, { version: CACHE_VERSION, marker: seen.marker, error, days: {} });
          continue;
        }
      } else {
        const stored = await storedInherited(persistence, id);
        own = stored === null ? own : own.slice(stored);
      }
    } else {
      // A live session is folded from the very observation its marker came from,
      // so its log is read once per scan and never copied.
      own = ownEvents(seen.observation);
    }
    releaseObservation(seen.observation);
    const folded = foldSession(own, { ...options, total: known });
    // `cachedBuckets`/`cachedSeq` record which platform total this split was
    // reconciled against, so the next scan can skip the marker entirely when the
    // platform's row has not moved (see the cheap exit above).
    state.cache.set(id, {
      version: CACHE_VERSION,
      marker: seen.marker,
      days: folded.days,
      cachedBuckets: known === undefined ? undefined : known.buckets,
      cachedSeq: known === undefined ? undefined : known.seq,
      savedAt: Date.now(),
    });
    scope.read += 1;
  }

  // Sessions whose split the budget did not reach.
  //
  // They are not dropped and their numbers are not lost: the platform's total for
  // each one is exact, so it is reported now under the unknown-model key on the
  // session's creation day, and the split replaced it on the scan that reads the
  // log. What the panel shows is therefore always the platform's own total for
  // every session — only the calendar placement of a not-yet-divided session is a
  // placeholder, and the next scan fixes it.
  for (const record of deferred) {
    const header = record === null || typeof record !== 'object' ? null : record.header;
    if (header === null || header === undefined) continue;
    const id = String(header.id);
    live.add(id);
    const known = cachedUsage.get(id);
    const previous = state.cache.get(id);
    if (known === undefined) {
      // Nothing to report for it yet; the next scan reads its log.
      deferred_no_total.push(id);
      continue;
    }
    scope.cached += 1;
    const days = previous !== undefined && previous.version === CACHE_VERSION && typeof previous.error !== 'string'
      ? previous.days
      : foldCachedOnly(known.buckets, { ...options, createdAt: header.createdAt });
    // `cachedBuckets`/`cachedSeq` record the platform row this placement was
    // reconciled against — and a placement built from the platform total IS
    // reconciled against it, so the pair is simply that row's. Recording
    // `undefined` here (because the entry being replaced had none) is what made a
    // deferred session re-enter the queue on every scan: it could never satisfy the
    // carry-over test, so it was re-read forever, which is 5 of 25 sessions and
    // most of a 3s refresh on the corpus this was measured against.
    state.cache.set(id, {
      version: CACHE_VERSION,
      marker: previous === undefined ? 'cache:' + known.seq : previous.marker,
      days,
      cachedBuckets: known.buckets,
      cachedSeq: known.seq,
      savedAt: Date.now(),
    });
    scope.deferred += 1;
  }
  scope.pending = deferred_no_total.length;
  if (deferred_no_total.length > 0) {
    // A session with neither a split nor a platform total is the one case where a
    // skipped session would silently shrink every total, so it is reported the way
    // an unreadable one is.
    for (const id of deferred_no_total) {
      scope.failed += 1;
      scope.failedSessions.push({ id, error: 'not read yet: the scan budget ended before this session was reached' });
    }
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
 * @param options - test seams and overrides: `sessionQuery`,
 *   `sessionPersistence`, `sessionProjections`, `sessionProjectionCache`,
 *   `retainSessions`, `cachePath`, `maxModels`, `aggregateTtlMs`, `dayKey`.
 * @returns `{ summary, refresh }` — both answering the same payload.
 */
export function createHandlers(ctx, options = {}) {
  const resolved = {
    sessionQuery: options.sessionQuery,
    sessionPersistence: options.sessionPersistence,
    sessionProjections: options.sessionProjections,
    sessionProjectionCache: options.sessionProjectionCache,
    retainSessions: options.retainSessions,
    cachePath: options.cachePath,
    maxModels: typeof options.maxModels === 'number' ? options.maxModels : MAX_MODELS,
    aggregateTtlMs: typeof options.aggregateTtlMs === 'number' ? options.aggregateTtlMs : AGGREGATE_TTL_MS,
    splitBudgetMs: typeof options.splitBudgetMs === 'number' ? options.splitBudgetMs : undefined,
    dayKey: options.dayKey,
  };
  const state = { cache: new Map(), loaded: false, cachePath: undefined, aggregate: null, aggregateAt: 0, scanStartedAt: 0, inFlight: null, names: null, namesAt: 0 };

  /**
   * Run one scan, coalescing concurrent callers onto a single pass.
   * @returns the fresh payload value.
   */
  async function refresh() {
    if (state.inFlight !== null) return state.inFlight;
    state.scanStartedAt = Date.now();
    const pending = collect(ctx, state, resolved);
    state.inFlight = pending;
    const settle = () => { if (state.inFlight === pending) state.inFlight = null; };
    pending.then(settle, settle);
    return pending;
  }

  /**
   * Tag one answer with its own freshness.
   *
   * `stale` means "this is not the output of the latest completed scan", so the
   * panel keeps asking until it is false. `scanning` means a scan is running
   * right now — the panel uses it to wait longer between follow-ups and to keep
   * its one visible "refreshing" marker up for as long as the work really lasts.
   *
   * @param value - payload to answer with.
   * @param stale - whether a newer scan result is still pending.
   * @param scanning - whether a scan is in flight.
   * @returns the payload plus both flags.
   */
  const answer = (value, stale, scanning) => Object.assign({}, value, { stale, scanning });

  /**
   * Serve one aggregate, never waiting on a scan that is already explainable.
   *
   * Once any aggregate exists it is answered immediately and the rescan happens
   * behind the response — including for an explicit refresh, which used to run
   * the scan inside the request. A scan is not a fixed cost (the first one after
   * a boot reads every session log, and a single live session alone used to cost
   * ~4.9s), so a request that waited for one held the panel's spinner for the
   * whole duration without being able to say why. The answer carries `stale` and
   * `scanning` so the panel can tell "your numbers are current" from "a scan is
   * running and they will change".
   *
   * The one request that still waits is the first ever, when there is no answer
   * at all to hand out.
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
    if (state.aggregate !== null) {
      const expired = Date.now() - state.aggregateAt >= resolved.aggregateTtlMs;
      // Behind the response; a failure leaves the stale answer in place and the
      // next request tries again, which is also why a failed scan does not keep
      // the panel waiting: once it settles, `scanning` goes false again.
      if (force || expired) refresh().catch(() => {});
      const scanning = state.inFlight !== null;
      // An aggregate published before the running scan started describes numbers
      // that are about to change, so it is stale even while it is still inside
      // its TTL: that is what makes a client keep asking until the scan lands.
      const superseded = scanning && state.scanStartedAt > state.aggregateAt;
      return answer(state.aggregate, force || expired || superseded, scanning);
    }
    const value = await refresh();
    const scanning = state.inFlight !== null;
    return answer(value, scanning, scanning);
  }

  return {
    summary,
    refresh: (args) => summary(Object.assign({}, args === null || typeof args !== 'object' ? {} : args, { force: true })),
  };
}
