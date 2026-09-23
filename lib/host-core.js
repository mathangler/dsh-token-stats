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

/** Durable rollup layout version; an unknown version is discarded. */
export const CACHE_VERSION = 2;

/**
 * Rollup versions this module can still read.
 *
 * Version 1 is read because discarding it is not free: it holds the per-day and
 * per-model contribution of every session the user has ever had, including the
 * ones whose logs are already deleted. Those contributions are the "lifetime"
 * figure, and they cannot be re-derived from anything — the logs are gone. A
 * version bump that simply threw the file away would therefore make the lifetime
 * total *shrink*, which is the one thing this module must never do. Reading v1
 * costs nothing: it needs no field this loader does not already accept.
 */
const DURABLE_VERSIONS_READ = new Set([1, 2]);

/**
 * How long a computed aggregate is served without rescanning.
 *
 * The browser half paints the previous answer immediately and revalidates
 * behind it, so this only decides how much CPU a burst of panel opens costs;
 * an explicit refresh always rescans.
 */
export const AGGREGATE_TTL_MS = 60 * 1000;

/** How long resolved model display names are reused before asking again. */
const NAMES_TTL_MS = 10 * 60 * 1000;

/** Beyond this many models the tail is folded into one "other" slice. */
export const MAX_MODELS = 8;

/**
 * How long one scan may spend deriving day/model splits from logs.
 *
 * A split is the only part of a session's numbers the platform does not record,
 * and deriving it means *decoding* that session's log. Measured on the corpus this
 * was tuned against: `persistence.open()` (the zstd decode) costs 1062ms for a 14MB
 * log and 435–715ms for 4–5MB ones, while reading the events out of a decoded log
 * costs 11–16ms and folding 18151 of them costs 10ms. So the entire cost of this
 * module's log work is the decode, and this budget is what bounds how many decodes
 * one scan may pay for.
 *
 * It is deliberately about a second: the panel must never wait on this work (it is
 * answered from maintained state), and the sessions not reached are picked up by
 * the scan after it.
 */
const SPLIT_BUDGET_MS = 1000;

/**
 * How many log decodes one scan may pay for, regardless of the time budget.
 *
 * The time budget alone is not a bound: it is checked *before* a decode, so a
 * single cold decode of a 14MB log (1062ms) blows straight through a 1s budget and
 * a scan that reads four sessions can cost 7.4s — which is exactly what was
 * measured in production. Counting decodes bounds the worst case directly.
 */
const MAX_DECODES_PER_SCAN = 2;

/**
 * How long one scan may run before it stops taking on new work.
 *
 * The per-decode budget cannot help if a service call never returns, and the only
 * call in a scan that can hang is `listSessions`. This is the cooperative ceiling:
 * the scan stops and publishes what it has rather than holding the host.
 */
const SCAN_DEADLINE_MS = 20 * 1000;

/**
 * How long to wait for one `listSessions` before giving up on that round.
 *
 * A hang guard, not a performance budget: a listing costs 70–112ms when this process
 * gets the CPU, and the only realistic way to exceed a minute is for the host to be
 * starved or genuinely stuck. Exceeding it skips the round rather than failing the
 * scan — the numbers this module reports are held in memory and stay valid either
 * way (see the degraded path in `collect`).
 */
const LIST_TIMEOUT_MS = 60 * 1000;

/**
 * How long to wait before retrying a round that could not list its sessions.
 *
 * Long enough that a starved host is not hammered, short enough that a momentary
 * stall does not leave the panel showing numbers it can no longer re-verify.
 */
const DEGRADED_RETRY_MS = 3000;

/**
 * How long a failed scan suppresses the next attempt.
 *
 * A scan that throws used to leave `stale` true forever, so the panel polled for
 * two minutes and then gave up — reported as "the refresh fails". The fix is to
 * report the failure and stop claiming the numbers are pending, but that would let
 * every follow-up request start another doomed scan. The cooldown stops the retry
 * storm while still recovering on its own.
 */
const FAILED_SCAN_COOLDOWN_MS = 15 * 1000;

/**
 * How long a scan waits before starting the round that finishes what it could not.
 *
 * The gap is only there to keep the host's single thread responsive: each round is
 * bounded, and the panel is answered from maintained state throughout, so this is
 * purely about not sitting in back-to-back decodes.
 */
const CATCHUP_DELAY_MS = 150;

/**
 * How many catch-up rounds one run of unfinished work may chain.
 *
 * A guard, not a target: a round only chains while the previous one still reports
 * unfinished sessions, so a corpus that can be placed finishes in a few rounds. The
 * cap only matters if some session can never be placed at all.
 */
const CATCHUP_MAX_ROUNDS = 40;

/**
 * How long a completed scan stays authoritative for an explicit Refresh press.
 *
 * Pressing Refresh repeatedly is normal — the numbers are being watched — and
 * without this each press redid the whole pass, because a scan is never free: it
 * starts with `listSessions` and then visits every session. Reusing the scan that
 * just finished turns a burst of presses into one scan.
 *
 * Small on purpose. It is a floor on re-scanning, not a cache of results, and it
 * sits far below the aggregate TTL so a press still cannot hide a change for
 * longer than this window. The plugin sets it; a direct caller of this module gets
 * 0 unless it asks, so a test or a caller that wants a guaranteed fresh scan still
 * gets one.
 */
export const DEFAULT_REFRESH_FLOOR_MS = 600;

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
 * Read one stored log through the persistence handle, without replay validation.
 *
 * `sessionQuery.readSession` returns a *validated* snapshot: it replays the log
 * to prove it is well-formed, which is right for resuming a session and far too
 * much for counting usage. Measured on this machine, the 13.5MB session costs
 * **11293ms** through `readSession` and **1355ms** through the handle.
 *
 * The events and the inherited cut come back together because they both need the
 * same handle, and opening one costs a full zstd decode (1062ms for a 14MB log):
 * asking twice would pay it twice, and the second open is only cheap because the
 * backend memoizes the decoded log, which is exactly the memo an idle period
 * evicts.
 *
 * @param persistence - the `sessionPersistence` service, if mounted.
 * @param id - the session to read.
 * @returns `{ events, inheritedEventCount }`, or null when the path is unavailable.
 */
async function readStoredSession(persistence, id) {
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') return null;
  let handle;
  try {
    handle = await persistence.open(id, 'read');
  } catch (e) {
    return null;
  }
  try {
    const inherited = toCount(handle.inheritedEventCount);
    const stored = await handle.read(0, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(stored.events)) return null;
    return { events: stored.events, inheritedEventCount: inherited };
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
    let totals;
    try {
      const viewed = projections.viewCheckpoint(record.rows, ['tokenUsage']);
      totals = viewed === undefined || viewed === null ? undefined : viewed.tokenUsage;
    } catch (e) {
      totals = undefined;
    }
    // `viewCheckpoint` serves only units that declare a `wire` view, and the
    // `tokenUsage` unit declares none — so it yields nothing for this key even though
    // the row is stored and current. (Its own `cachedSnapshot`, the public listing read,
    // is built on the same call and therefore misses it too.) The row is still a
    // documented `ProjectionCheckpointRow` — `{ ver, seq, val }`, `val` being the unit's
    // own state — so the totals are read from it directly, shape-checked rather than
    // version-checked so a unit bump cannot silently turn this into zeros.
    //
    // This is what lets a session whose log cannot be read still be counted at its
    // platform total; without it the panel silently drops a session the platform can
    // still account for, which is the one failure a "lifetime" figure must not have.
    if (totals === undefined || totals === null) {
      const val = record.rows.tokenUsage?.val;
      const inside = val !== null && typeof val === 'object' ? val.totals : undefined;
      if (inside !== null && typeof inside === 'object' && typeof inside.uncachedInputTokens === 'number') {
        totals = inside;
      }
    }
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
    // A version this module does not know is discarded — but only because it cannot
    // be interpreted, never because it is old. See `DURABLE_VERSION_READ`.
    if (typeof parsed.version !== 'number' || !DURABLE_VERSIONS_READ.has(parsed.version)) return;
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
        // Whether the days are a real split or a placeholder parked on the total.
        // Written explicitly by this version; for an older rollup it is inferred,
        // because 0.1.12 parked sessions on their platform total without recording
        // that it had done so. Such an entry looks placed, so it would never be
        // revisited and the heatmap would stay permanently short of the days and
        // models it never got to derive. A parked placement puts everything under
        // the unattributed key — see `foldCachedOnly` — which is what makes it
        // recognisable after the fact.
        placed: entry.placed === false ? false
          : (entry.placed === true ? true : !onlyUnattributed(entry.days)),
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
    // A missing, unreadable, or corrupt rollup only costs a re-derivation.
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
    // Whether the days are a real split or a placeholder parked on the total. Only
    // written when false, so the common row stays as small as it was.
    if (entry.placed === false) row.placed = false;
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
 * Whether a day map holds nothing but unattributed usage.
 *
 * `foldCachedOnly` parks a session's platform total under `UNKNOWN_MODEL_KEY` on a
 * guessed day, so a map that has no model key other than that one is a placeholder
 * rather than a derived split — the only way to tell the two apart for a rollup
 * written before the `placed` flag existed.
 *
 * @param days - one session's day map.
 * @returns true when every entry is unattributed (or the map is empty).
 */
function onlyUnattributed(days) {
  if (days === null || days === undefined) return true;
  for (const day of Object.keys(days)) {
    const models = days[day];
    if (models === null || models === undefined) continue;
    for (const key of Object.keys(models)) {
      if (key !== UNKNOWN_MODEL_KEY) return false;
    }
  }
  return true;
}

/**
 * Every day map that contributes to the payload.
 *
 * A pre-merged archive of deleted sessions was tried and removed: a merged total
 * cannot be un-merged, so a session that reappeared after being archived would be
 * counted twice — proven by a test, and a "lifetime" figure that double-counts is
 * worse than the bookkeeping it saved. Keeping the per-session entry is what makes
 * a return exact, and the entry costs nothing per scan: it is data, not work.
 *
 * @param cache - session id to `{ days }`.
 * @returns an iterable of day maps.
 */
function* dayMaps(cache) {
  for (const entry of cache.values()) yield entry.days;
}


/**
 * Await a promise but give up after `ms`, reported as a failure rather than hung.
 *
 * The underlying work is not cancellable — no service in this composition accepts
 * an AbortSignal — so this bounds only how long the caller waits. For the one call
 * that uses it (`listSessions`) that is the difference between a scan that fails
 * and is reported and one that never returns at all.
 *
 * @param promise - the work to bound.
 * @param ms - how long to wait.
 * @param message - the failure's message if the deadline passes.
 * @returns the promise's value.
 * @throws {StatsError} when the deadline passes first.
 */
function withTimeout(promise, ms, message) {
  let timer;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new StatsError('token-stats/timeout', message)), ms);
    // A pending timer alone must not hold the process open.
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Short description of a per-session read failure.
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
  const maps = [...dayMaps(cache)];
  const perModel = new Map();
  for (const dayMap of maps) {
    for (const day of Object.keys(dayMap)) {
      const models = dayMap[day];
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
  for (const dayMap of maps) {
    for (const day of Object.keys(dayMap)) {
      const bucket = days.get(day) === undefined ? { b: [0, 0, 0, 0], m: new Map() } : days.get(day);
      const modelsForDay = dayMap[day];
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
  const deadline = startedAt + (typeof options.scanDeadlineMs === 'number' ? options.scanDeadlineMs : SCAN_DEADLINE_MS);
  const timings = {};
  await loadDurable(state, options);

  const listStarted = Date.now();
  // The one call in a scan that can hang, so it is bounded — but a listing that is
  // merely *slow* must not become a visible failure.
  //
  // Everything this module reports comes from state it already holds, so a listing
  // that fails or times out says nothing about the numbers: it only means this round
  // cannot check which sessions changed. Treating that as a failed scan is what
  // turned a busy host into a red "listing sessions timed out" error while the
  // numbers were perfectly fine — the process was simply starved of CPU (measured
  // event-loop lag on a loaded host: 1850ms, against a listing that costs 70–112ms
  // when it gets the CPU). It is now a *skipped round*: the held numbers are
  // re-published with a note, and the round is retried on its own.
  const listTimeoutMs = typeof options.listTimeoutMs === 'number' ? options.listTimeoutMs : LIST_TIMEOUT_MS;
  let degraded = '';
  let records = [];
  try {
    const listed = await withTimeout(
      query.listSessions(),
      listTimeoutMs,
      'listing sessions timed out after ' + listTimeoutMs + 'ms',
    );
    if (!Array.isArray(listed)) {
      throw new StatsError('token-stats/list-failed', 'the session query returned no session list');
    }
    records = listed;
  } catch (e) {
    degraded = describeError(e);
  }
  timings.list = Date.now() - listStarted;
  const scope = {
    sessions: degraded === '' ? records.length : state.cache.size,
    read: 0, reused: 0, failed: 0, seeded: 0, failedSessions: [], cached: 0, deferred: 0, retired: 0,
    // Sessions folded without regard to the decode budget, because this host had never
    // seen them. See the `exempt` rule below.
    eager: 0,
    // A non-empty `warning` means the numbers below are the previous round's, not
    // wrong — just not re-verified this time. `failed`/`failedSessions` stay for
    // sessions that could not be accounted for at all.
    warning: degraded,
  };
  // Whether this scan started from nothing. Read before the loop, because the loop
  // itself populates the cache.
  //
  // The set of sessions in this process's FIRST listing is what separates "backlog"
  // from "new": a session in it already existed when this host started looking, so it
  // is work the budget may spread out, while one that appears later is genuinely new
  // and is folded at once. Keying this on an empty cache instead would be wrong — a
  // round that placed nothing (a small budget, or every log deferred) leaves the cache
  // empty and would make every following round look like a cold start.
  if (degraded === '' && state.firstListing === null) {
    state.firstListing = new Set(records.map((record) => String(record.header.id)));
  }
  const coldStart = state.firstListing === null;
  const live = new Set();
  // How many log decodes this scan has paid for. The time budget cannot bound this
  // (it is checked before a decode, and one cold decode is longer than the budget),
  // so it is counted explicitly — see MAX_DECODES_PER_SCAN.
  let decodes = 0;
  const maxDecodes = typeof options.maxDecodesPerScan === 'number' ? options.maxDecodesPerScan : MAX_DECODES_PER_SCAN;

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
      // A session parked on its platform total has an entry, but a *placeholder*
      // one: its usage sits under the unattributed key on a guessed day. Treating
      // that as a finished split is what made a cold start permanent — the heatmap
      // kept only the few days it happened to fold, and no later scan ever revisited
      // them, because every scan reported them as reused.
      && previous.placed !== false
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
      && previous.placed !== false
      && Array.isArray(previous.cachedBuckets)
      && previous.cachedSeq === known.seq
      && typeof previous.error !== 'string'
    ) {
      state.cache.set(id, { ...previous, marker: previous.marker, savedAt: Date.now() });
      scope.cached += 1;
      scope.reused += 1;
      continue;
    }

    // A session this host has never seen is folded whatever the budget says.
    //
    // The day dimension is the one thing that cannot be recovered later: once a
    // session's log is gone, nothing can tell us which days its tokens were spent on.
    // A budget that parks a *newly appeared* session therefore risks losing that
    // session's days for good if it is deleted before the next round reaches it — and
    // a newly appeared session is exactly the cheap case to fold, because its log is
    // still tiny. On the first scan of a cold process every session is "new", so the
    // budget applies there as usual; after that, anything unseen is genuinely new work
    // rather than a backlog. The deadline still bounds the round either way.
    const neverSeen = previous === undefined;
    const exempt = neverSeen && !coldStart && !state.firstListing.has(id);
    if (exempt) scope.eager += 1;

    const overBudget = Date.now() - splitStarted > budget || decodes >= maxDecodes;
    if (Date.now() > deadline || (overBudget && !exempt)) {
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
    if (hit !== undefined && hit.version === CACHE_VERSION && hit.marker === seen.marker && hit.placed !== false) {
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
    //
    // `placed` gates this too: adopting a *placeholder* would both keep the wrong
    // days and clear the flag that marks it as unfinished, so the split could never
    // be derived at all. That is the bug this guard fixes.
    if (
      known !== undefined
      && hit !== undefined
      && hit.version === CACHE_VERSION
      && hit.placed !== false
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
        placed: true,
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
      // too much for counting usage. Measured on this machine: 11293ms through
      // `readSession` against 1355ms through the handle for the same 13.5MB log,
      // with identical totals. The query read stays as the fallback for a
      // composition whose persistence service is not mounted.
      //
      // One open yields both the events and the inherited cut, so a forked session's
      // prefix can be skipped without paying for a second decode. This is the decode
      // the scan's budget is really about, so it is counted.
      decodes += 1;
      const stored = await readStoredSession(persistence, id);
      if (stored === null) {
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
            state.cache.set(id, {
              version: CACHE_VERSION, marker: 'cache:' + known.seq, days: rescued, savedAt: Date.now(),
              cachedBuckets: known.buckets, cachedSeq: known.seq,
              // Both read paths refused this log, so the total is the best this
              // session can get and retrying it every scan would only cost decodes.
              placed: true,
            });
            scope.read += 1;
            continue;
          }
          const error = describeError(e);
          scope.failed += 1;
          scope.failedSessions.push({ id, error });
          // Keep whatever this session was last known to have contributed.
          //
          // A failed re-read says nothing about the session's usage — the log is still
          // there and the numbers were already folded once. Blanking the entry here
          // made the lifetime figure *shrink* every time a re-read failed, which is the
          // one thing this module must never do. The failure is recorded alongside the
          // last good days instead, and the entry keeps its marker so the next scan
          // retries only when the log actually moves.
          const lastKnown = state.cache.get(id);
          const keptDays = lastKnown !== undefined && lastKnown.version === CACHE_VERSION && typeof lastKnown.days === 'object'
            ? lastKnown.days
            : {};
          state.cache.set(id, { version: CACHE_VERSION, marker: seen.marker, error, days: keptDays });
          continue;
        }
      } else {
        const inherited = stored.inheritedEventCount;
        own = inherited > 0 && inherited < stored.events.length ? stored.events.slice(inherited) : stored.events;
      }
    } else {
      // A live session is folded from the very observation its marker came from —
      // an in-memory snapshot, so no decoding at all. That is the whole point: the
      // live session is the one that changes constantly, and it is the only one
      // whose split has to be re-derived regularly.
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
      // The split is real: its days and models came from the log itself.
      placed: true,
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
      // Parked, not placed: the total is exact but the day/model placement is a
      // placeholder, so a later scan must come back for it (see the carry test).
      placed: previous !== undefined && previous.placed === true,
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

  // Sessions the listing no longer mentions.
  //
  // Skipped entirely on a degraded round: with no listing there is no way to tell a
  // deleted session from an unlisted one, and guessing would retire (or, with
  // `retainSessions: false`, delete) every session at once.
  //
  // Dropping a session that really is gone would shrink a "lifetime" figure, so its
  // contribution is kept and it is simply not re-examined. It is NOT folded into one
  // merged total: a merged total cannot be un-merged, so a session that came back
  // would be counted twice — proven by a test — and the bookkeeping saved is
  // negligible (the entries are data, not work: nothing opens a log for a session
  // that is not in the listing). Set `retainSessions: false` to make the totals
  // reflect only live logs.
  if (degraded === '') {
    for (const id of [...state.cache.keys()]) {
      const entry = state.cache.get(id);
      if (live.has(id)) continue;
      if (options.retainSessions === false) {
        state.cache.delete(id);
        continue;
      }
      scope.retired += 1;
    }
  }

  const namesStarted = Date.now();
  const names = await resolveModelNames(ctx, modelKeys(state.cache), state, options);
  timings.names = Date.now() - namesStarted;
  const payload = buildPayload(state.cache, names, options.maxModels);

  const value = {
    generatedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    timings,
    scope,
    // Carried at the top level too, so a client can show it without reaching into
    // `scope`. Empty on a normal round.
    warning: degraded,
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
  for (const dayMap of dayMaps(cache)) {
    for (const day of Object.keys(dayMap)) {
      for (const key of Object.keys(dayMap[day])) keys.add(key);
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
 *   `retainSessions`, `cachePath`, `maxModels`, `aggregateTtlMs`, `dayKey`,
 *   `splitBudgetMs`, `maxDecodesPerScan`, `listTimeoutMs`, `scanDeadlineMs`,
 *   `refreshFloorMs`.
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
    maxDecodesPerScan: typeof options.maxDecodesPerScan === 'number' ? options.maxDecodesPerScan : undefined,
    listTimeoutMs: typeof options.listTimeoutMs === 'number' ? options.listTimeoutMs : undefined,
    scanDeadlineMs: typeof options.scanDeadlineMs === 'number' ? options.scanDeadlineMs : undefined,
    refreshFloorMs: typeof options.refreshFloorMs === 'number'
      ? options.refreshFloorMs
      : (options.pluginDefaults === true ? DEFAULT_REFRESH_FLOOR_MS : 0),
    dayKey: options.dayKey,
  };
  const state = {
    cache: new Map(),
    loaded: false,
    cachePath: undefined,
    aggregate: null,
    aggregateAt: 0,
    scanStartedAt: 0,
    inFlight: null,
    names: null,
    namesAt: 0,
    // When the last completed scan finished, and whether anything has happened
    // since that could have changed a number. A press landing inside
    // `REFRESH_FLOOR_MS` of that moment is answered from the scan that just ran.
    scanEndedAt: 0,
    // Why the most recent scan attempt failed, and when. Reported instead of a
    // permanent `stale`, so the panel stops polling and says what went wrong.
    scanError: '',
    scanFailedAt: 0,
    // The background chain that finishes sessions a scan had to leave behind.
    catchUpTimer: null,
    catchUpRounds: 0,
    // The session ids present in this process's first listing. A session outside it
    // appeared after this host started looking, and is folded at once so its days can
    // never be lost to a deletion. Per-process on purpose: it describes what this
    // process has already had a chance to examine.
    firstListing: null,
  };

  /**
   * Run one scan, coalescing concurrent callers onto a single pass.
   *
   * A rejection clears the in-flight slot (through `settle`) and is recorded rather
   * than discarded: a swallowed failure is what left `stale` true forever and made
   * the panel poll for two minutes over a scan that had already died.
   *
   * @returns the fresh payload value.
   */
  async function refresh() {
    if (state.inFlight !== null) return state.inFlight;
    state.scanStartedAt = Date.now();
    const pending = collect(ctx, state, resolved).then(
      (value) => {
        state.scanEndedAt = Date.now();
        state.scanError = '';
        scheduleCatchUp(value);
        return value;
      },
      (error) => {
        state.scanError = describeError(error);
        state.scanFailedAt = Date.now();
        // A failed scan must not keep its catch-up chain alive: whatever broke is
        // not going to fix itself within the next few hundred milliseconds.
        state.catchUpRounds = 0;
        throw error;
      },
    );
    state.inFlight = pending;
    const settle = () => { if (state.inFlight === pending) state.inFlight = null; };
    pending.then(settle, settle);
    return pending;
  }

  /**
   * Keep working through sessions a scan had to leave unfinished.
   *
   * One scan deliberately bounds how many logs it decodes, because one cold decode
   * is ~1s and a scan that paid for all of them is the slowness this module exists to
   * remove. But bounding alone is not enough: the residue would then only advance
   * when something asked for a scan, and nothing does while the panel sits open and
   * its aggregate is inside its TTL — measured, a cold start stayed at 8 of 15 days
   * and 1 of 9 models indefinitely. So a scan that left work behind queues the next
   * one itself, on a short timer, until the corpus is fully placed.
   *
   * Each round is still bounded, nothing here touches a request, and the chain stops
   * on its own: a round only continues while the previous one reports unfinished
   * sessions, and `CATCHUP_MAX_ROUNDS` caps it in case a session can never be placed.
   *
   * @param value - the value the scan just produced.
   */
  function scheduleCatchUp(value) {
    const scope = value === null || typeof value !== 'object' ? null : value.scope;
    const warning = value === null || typeof value !== 'object' ? '' : value.warning;
    const unfinished = scope === null || scope === undefined
      ? 0
      : toCount(scope.deferred) + toCount(scope.pending);
    // A skipped round is not finished work — it is work not yet attempted. It has no
    // residue to report (no session was examined), so it retries on its own, more
    // slowly than a catch-up round because whatever starved it needs time to clear.
    const skipped = typeof warning === 'string' && warning !== '';
    if (unfinished === 0 && !skipped) {
      state.catchUpRounds = 0;
      return;
    }
    if (state.catchUpRounds >= (typeof resolved.catchUpMaxRounds === 'number' ? resolved.catchUpMaxRounds : CATCHUP_MAX_ROUNDS)) return;
    if (state.catchUpTimer !== null) return;
    state.catchUpRounds += 1;
    const delay = skipped
      ? (typeof resolved.degradedRetryMs === 'number' ? resolved.degradedRetryMs : DEGRADED_RETRY_MS)
      : (typeof resolved.catchUpDelayMs === 'number' ? resolved.catchUpDelayMs : CATCHUP_DELAY_MS);
    state.catchUpTimer = setTimeout(() => {
      state.catchUpTimer = null;
      refreshBehind();
    }, delay);
    if (typeof state.catchUpTimer.unref === 'function') state.catchUpTimer.unref();
  }

  /** Stop any queued catch-up round. */
  function stop() {
    if (state.catchUpTimer !== null) {
      clearTimeout(state.catchUpTimer);
      state.catchUpTimer = null;
    }
    state.catchUpRounds = 0;
  }

  /**
   * Start a scan without waiting for it, discarding only the rejection.
   *
   * The failure is already recorded by {@link refresh}, so swallowing it here is how
   * a background scan reports itself. Every caller that cannot wait uses this.
   */
  function refreshBehind() {
    refresh().catch(() => {});
  }

  /**
   * Whether the last scan attempt failed and is still in its retry cooldown.
   * @returns true when a new attempt should be suppressed.
   */
  function coolingDown() {
    return state.scanError !== ''
      && state.inFlight === null
      && Date.now() - state.scanFailedAt < FAILED_SCAN_COOLDOWN_MS;
  }

  /**
   * Whether a press should reuse the scan that just finished.
   *
   * Pressing Refresh twice in a row is a normal thing to do while watching the
   * numbers, and the second press was doing the entire scan again: on the corpus
   * this was measured against that is a `listSessions` (112–229ms) plus a pass over
   * every session, for an answer that provably cannot have changed — nothing has
   * queried the harness in between, and no scan has been requested by anything
   * else. Reusing the finished scan makes a burst of presses cost one scan.
   *
   * This is a floor, not a cache: outside the window a press scans as before, and
   * `REFRESH_FLOOR_MS` is deliberately far below the aggregate TTL so an explicit
   * press still feels immediate without ever being able to hide a real change for
   * long. A session log can only have grown if something wrote one, and a write
   * that matters is followed by the harness recording it, so this can only miss a
   * change made by another process within the same few hundred milliseconds.
   *
   * @returns true when the previous scan is still authoritative.
   */
  function freshEnough() {
    if (resolved.refreshFloorMs <= 0) return false;
    return state.aggregate !== null
      && state.inFlight === null
      && state.scanEndedAt > 0
      && Date.now() - state.scanEndedAt < resolved.refreshFloorMs;
  }

  /**
   * Tag one answer with its own freshness.
   *
   * `stale` means "this is not the output of the latest completed scan", so the
   * panel keeps asking until it is false. `scanning` means a scan is running right
   * now — the panel uses it to wait longer between follow-ups and to keep its one
   * visible "refreshing" marker up for as long as the work really lasts. `error` is
   * non-empty only when the most recent attempt failed, and it comes with
   * `stale: false` so the panel reports it instead of polling for a scan that has
   * already died.
   *
   * @param value - payload to answer with.
   * @param stale - whether a newer scan result is still pending.
   * @param scanning - whether a scan is in flight.
   * @param error - why the last attempt failed, if it did.
   * @returns the payload plus these flags.
   */
  const answer = (value, stale, scanning, error = '') => Object.assign(
    {},
    value,
    { stale, scanning, error: typeof error === 'string' ? error : '' },
  );

  /**
   * The answer for a host that has nothing to serve yet.
   *
   * It has the full payload shape with no data, so the panel can render it, and it
   * is flagged stale so the client keeps asking until the first scan lands. The
   * alternative — waiting for the scan — blocked the request for seconds.
   *
   * @returns an empty payload value.
   */
  const warmingPayload = (state) => ({
    generatedAt: Date.now(),
    durationMs: 0,
    warming: true,
    timings: {},
    scope: {
      sessions: state.cache.size, read: 0, reused: 0, failed: 0, seeded: 0,
      failedSessions: [], cached: 0, deferred: 0, retired: 0, pending: 0,
    },
    models: [],
    days: [],
    range: { first: '', last: '' },
  });

  /**
   * Serve one aggregate, never waiting on a scan.
   *
   * Every answer comes from maintained state. A scan is not a fixed cost — one cold
   * log decode alone is 1062ms for a 14MB log, and the first scan after a boot used
   * to cost 7.4s — so a request that waited for one held the panel's spinner for the
   * whole duration without being able to say why. The answer carries `stale` and
   * `scanning` so the panel can tell "your numbers are current" from "a scan is
   * running and they will change".
   *
   * There is no longer any request that waits for a scan, not even the first one: a
   * host with nothing to serve yet answers "warming up" at once and lets the panel
   * poll. Making the first request wait was measured at 4014ms with a 4s listing and
   * 9014ms with a 9s one, and that path is reached exactly when the durable copy is
   * missing or unreadable — the moment a user is most likely to be staring at it.
   *
   * @param args - `{ force?: boolean }`.
   * @returns the payload value.
   */
  async function summary(args) {
    const force = args !== null && typeof args !== 'object' ? false : args.force === true;
    // Before any cache: a composition that cannot scan must say so, not serve
    // numbers from a durable rollup it can never refresh.
    requireQuery(ctx, resolved);
    // Load before deciding: the durable copy carries the last aggregate, which is
    // what lets a freshly booted host answer a panel open without scanning.
    // Cheap after the first call.
    await loadDurable(state, resolved);
    if (state.aggregate === null) {
      // Nothing to serve yet. Start the scan and answer at once rather than blocking
      // the request for its whole duration.
      if (!coolingDown()) refreshBehind();
      return answer(warmingPayload(state), true, state.inFlight !== null, state.scanError);
    }
    const expired = Date.now() - state.aggregateAt >= resolved.aggregateTtlMs;
    // A press arriving just after a scan finished is answered from that scan,
    // and — crucially — is *not* reported stale: nothing is running and the
    // numbers are the ones a scan just produced, so telling the panel to keep
    // asking would make it poll for an answer that is already final and leave
    // its "Refreshing…" marker up over a scan that never happened.
    if (force && freshEnough()) return answer(state.aggregate, false, false);
    const cooling = coolingDown();
    if (!cooling && (force || expired)) refreshBehind();
    const scanning = state.inFlight !== null;
    // An aggregate published before the running scan started describes numbers
    // that are about to change, so it is stale even while it is still inside
    // its TTL: that is what makes a client keep asking until the scan lands.
    const superseded = scanning && state.scanStartedAt > state.aggregateAt;
    // A failed attempt is reported, not hidden behind a `stale` that would keep the
    // panel polling for an answer that is never coming. `stale` is false so the
    // client stops; `error` says why, and the cooldown retries on its own.
    const stale = cooling ? false : (force || expired || superseded);
    return answer(state.aggregate, stale, scanning, cooling ? state.scanError : '');
  }

  return {
    summary,
    refresh: (args) => summary(Object.assign({}, args === null || typeof args !== 'object' ? {} : args, { force: true })),
    stop,
  };
}
