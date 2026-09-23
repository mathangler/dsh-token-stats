/**
 * Core-layer tests: the token fold, the payload builder, the incremental scan,
 * and a cross-check of the whole thing against the platform's own deriver on
 * whatever real session logs this machine happens to have.
 *
 * @module dsh-token-stats/test/host-core
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createHandlers,
  foldSession,
  buildPayload,
  metricValue,
  markerOf,
  localDayKey,
  readCachedUsage,
  lifecycleIdentity,
  toCount,
  OTHER_MODEL_KEY,
  UNKNOWN_MODEL_KEY,
} from '../lib/host-core.js';
import { decodeSessionLog, turnsOf } from './decode-session.mjs';

const usage = (input, output, cacheRead, cacheWrite) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

/** One durable assistant message carrying usage plus its route. */
const assistant = (time, turn, step, provider, model, buckets) => ({
  type: 'assistant/message',
  time,
  data: {
    turn,
    step,
    usage: buckets,
    message: { source: { kind: 'model', provider, model } },
  },
});

/** A fixed local-time day for a UTC millisecond stamp, so tests are timezone-proof. */
const DAY = '2026-09-10';

test('one assistant message becomes one day × model bucket set', () => {
  const folded = foldSession([
    { type: 'turn/start', time: 1789000000000, data: { turn: 1 } },
    { type: 'step/start', time: 1789000000000, data: { step: 1 } },
    assistant(1789000000000, 1, 1, 'prov', 'mod', usage(10, 4, 1, 0)),
    { type: 'turn/end', time: 1789000000001, data: { turn: 1 } },
  ], { dayKey: () => DAY });
  assert.deepEqual(folded.days[DAY]['prov/mod'], [10, 4, 1, 0]);
  assert.equal(folded.samples, 1);
  assert.equal(folded.unpriced, 0);
});

test('a later sample of the same attempt replaces the earlier one', () => {
  const folded = foldSession([
    { type: 'turn/start', time: 1, data: { turn: 3 } },
    { type: 'step/start', time: 1, data: { step: 2 } },
    assistant(1, 3, 2, 'prov', 'mod', usage(1, 1, 0, 0)),
    assistant(2, 3, 2, 'prov', 'mod', usage(90, 9, 3, 1)),
  ], { dayKey: () => DAY });
  assert.deepEqual(folded.days[DAY]['prov/mod'], [90, 9, 3, 1], 'only the final sample of an attempt is billed');
});

test('a retry is billed as its own attempt', () => {
  const folded = foldSession([
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'step/start', time: 1, data: { step: 1 } },
    assistant(1, 1, 1, 'prov', 'mod', usage(5, 1, 0, 0)),
    { type: 'llm/retry-started', time: 2, data: {} },
    assistant(2, 1, 1, 'prov', 'mod', usage(7, 2, 0, 0)),
  ], { dayKey: () => DAY });
  assert.deepEqual(folded.days[DAY]['prov/mod'], [12, 3, 0, 0], 'llm/retry-started ends the replacement scope');
});

test('an assistant attempt marker is billed as its own attempt', () => {
  const folded = foldSession([
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'step/start', time: 1, data: { step: 1 } },
    assistant(1, 1, 1, 'prov', 'mod', usage(5, 1, 0, 0)),
    { type: 'assistant/attempt', time: 2, data: {} },
    assistant(2, 1, 1, 'prov', 'mod', usage(7, 2, 0, 0)),
  ], { dayKey: () => DAY });
  assert.deepEqual(folded.days[DAY]['prov/mod'], [12, 3, 0, 0]);
});

test('the same step number in a different turn does not collide', () => {
  const folded = foldSession([
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'step/start', time: 1, data: { step: 1 } },
    assistant(1, 1, 1, 'prov', 'mod', usage(5, 1, 0, 0)),
    { type: 'turn/end', time: 1, data: { turn: 1 } },
    { type: 'turn/start', time: 2, data: { turn: 2 } },
    { type: 'step/start', time: 2, data: { step: 1 } },
    assistant(2, 2, 1, 'prov', 'mod', usage(7, 2, 0, 0)),
  ], { dayKey: () => DAY });
  assert.deepEqual(folded.days[DAY]['prov/mod'], [12, 3, 0, 0]);
});

test('messages with no usage are counted, not invented', () => {
  const folded = foldSession([
    { type: 'assistant/message', time: 1, data: { turn: 1, step: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' } } } },
  ], { dayKey: () => DAY });
  assert.deepEqual(folded.days, {});
  assert.equal(folded.unpriced, 1);
});

test('a message with no model route lands in the unattributed slice', () => {
  const folded = foldSession([
    { type: 'assistant/message', time: 1, data: { turn: 1, step: 1, usage: usage(3, 1, 0, 0), message: { source: { kind: 'plugin', plugin: 'x' } } } },
    { type: 'assistant/message', time: 1, data: { turn: 1, step: 2, usage: usage(3, 1, 0, 0) } },
    { type: 'assistant/message', time: 1, data: { turn: 1, step: 3, usage: usage(3, 1, 0, 0), message: { source: { kind: 'model', provider: '', model: 'm' } } } },
  ], { dayKey: () => DAY });
  assert.deepEqual(folded.days[DAY][UNKNOWN_MODEL_KEY], [9, 3, 0, 0]);
});

test('non-integer and negative counts are refused rather than summed', () => {
  assert.equal(toCount(5), 5);
  assert.equal(toCount(-1), 0);
  assert.equal(toCount(1.5), 0);
  assert.equal(toCount(Number.MAX_SAFE_INTEGER + 2), 0);
  assert.equal(toCount('12'), 0);
  assert.equal(toCount(undefined), 0);
  const folded = foldSession([
    { type: 'assistant/message', time: 1, data: { turn: 1, step: 1, usage: { inputTokens: -4, outputTokens: 2 }, message: { source: { kind: 'model', provider: 'p', model: 'm' } } } },
  ], { dayKey: () => DAY });
  assert.deepEqual(folded.days[DAY]['p/m'], [0, 2, 0, 0]);
});

test('the day comes from the event timestamp in local time', () => {
  const stamp = new Date(2026, 8, 10, 23, 30, 0).getTime();
  const folded = foldSession([
    { type: 'assistant/message', time: stamp, data: { turn: 1, step: 1, usage: usage(1, 1, 0, 0), message: { source: { kind: 'model', provider: 'p', model: 'm' } } } },
  ]);
  assert.deepEqual(Object.keys(folded.days), ['2026-09-10']);
  assert.equal(localDayKey(stamp), '2026-09-10');
});

test('metricValue sums the buckets the panel offers', () => {
  const buckets = [10, 2, 5, 1];
  assert.equal(metricValue(buckets, 'all'), 18, 'the provider total counts every bucket');
  assert.equal(metricValue(buckets, 'total'), 12);
  assert.equal(metricValue(buckets, 'input'), 10);
  assert.equal(metricValue(buckets, 'output'), 2);
  assert.equal(metricValue(buckets, 'cacheRead'), 5);
  assert.equal(metricValue(buckets, 'cacheWrite'), 1);
  assert.equal(metricValue(buckets, 'nonsense'), 12, 'an unknown metric falls back to total');
});

test('a closed session is freshness-checked from metadata without parsing its log', async () => {
  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  let parses = 0;
  const list = query.listEvents;
  query.listEvents = async (id) => { parses += 1; return list(id); };
  const stats = [];
  const persistence = {
    stat: async (id) => { stats.push(id); return { header: { id }, revision: 'rev-1', eventCount: 4, sizeBytes: 512 }; },
  };
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, sessionPersistence: persistence, cachePath: null, aggregateTtlMs: 60000 });
  const first = await handlers.summary({});
  assert.deepEqual(first.models[0].buckets, [4, 2, 0, 0]);
  assert.equal(stats.length, 1, 'the cheap metadata path must be consulted');
  assert.equal(parses, 0, 'a closed session must not be parsed just to detect change');

  const second = await settled(handlers, { force: true });
  assert.equal(second.scope.reused, 1);
  assert.equal(parses, 0, 'the second scan must stay off the parse path too');
});

test('a live session is still parsed so unflushed events are counted', async () => {
  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, live: true, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  let parses = 0;
  const list = query.listEvents;
  query.listEvents = async (id) => { parses += 1; return list(id); };
  const persistence = { stat: async (id) => ({ header: { id }, revision: 'rev-1', eventCount: 99, sizeBytes: 999 }) };
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, sessionPersistence: persistence, cachePath: null, aggregateTtlMs: 60000 });
  await handlers.summary({});
  assert.equal(parses, 1, 'a live session\u2019s file metadata can lag its in-memory events');
});

/**
 * The live session is the one log that changes between two scans, so it decides
 * what a refresh costs. Reading it through `readSession` deep-copies every event
 * and replays the log (~4.9s for the ~31MB session measured on this machine, on
 * the host's only thread); observing it is O(1) for the change marker and hands
 * the fold the same events without copying them.
 */
test('a live session is observed once instead of listed and then read', async () => {
  const query = observingQuery([{ header: { id: 's1', isSeeded: false }, live: true, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  const first = await handlers.summary({});
  assert.deepEqual(first.models[0].buckets, [4, 2, 0, 0]);
  assert.equal(query.counts.observations, 1, 'the live session is observed once per scan');
  assert.equal(query.counts.materializations, 1, 'and its events are read exactly once');
  assert.deepEqual(query.reads, [], 'observing replaces the whole-log read');
  assert.deepEqual(query.listings, [], 'and the one-record-per-event listing before it');
  assert.equal(query.counts.released, query.counts.observations, 'every observation is handed back');
});

test('a live session that has not grown is never materialized again', async () => {
  const session = { header: { id: 's1', isSeeded: false }, live: true, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
  const query = observingQuery([session]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  await handlers.summary({});
  const second = await settled(handlers, { force: true });
  assert.equal(second.scope.reused, 1);
  assert.equal(second.scope.read, 0);
  assert.equal(query.counts.materializations, 1, 'the second scan must not touch the log at all');
  assert.equal(query.counts.released, query.counts.observations, 'reusing still hands the observation back');
  assert.deepEqual(query.reads, []);
});

test('a grown live log replaces its own buckets through the observation', async () => {
  const session = { header: { id: 's1', isSeeded: false }, live: true, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
  const query = observingQuery([session]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  await handlers.summary({});
  session.events = session.events.concat([
    { type: 'turn/start', time: 1789000001000, data: { turn: 2 } },
    { type: 'step/start', time: 1789000001000, data: { step: 1 } },
    assistant(1789000001000, 2, 1, 'prov', 'm', usage(6, 3, 0, 0)),
  ]);
  const grown = await settled(handlers, { force: true });
  assert.equal(grown.scope.read, 1);
  assert.deepEqual(grown.models[0].buckets, [10, 5, 0, 0], 'the whole live log is folded, never a delta');
  assert.equal(query.counts.materializations, 2, 'a grown log is read once more');
  assert.deepEqual(query.reads, [], 'still no whole-log read through readSession');
});

test('a live session that cannot be observed fails like any other unreadable log', async () => {
  const query = observingQuery([
    { header: { id: 'ok', isSeeded: false }, live: true, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) },
    { header: { id: 'gone', isSeeded: false }, live: true, inheritedEventCount: 0, events: [] },
  ]);
  const observe = query.observeSession;
  query.observeSession = async (id) => {
    if (id === 'gone') throw new Error('session "' + id + '" not found');
    return observe(id);
  };
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  const payload = await handlers.summary({});
  assert.equal(payload.scope.failed, 1);
  assert.equal(payload.scope.failedSessions[0].id, 'gone');
  assert.equal(payload.scope.failedSessions[0].error, 'Error: session "gone" not found');
  assert.deepEqual(payload.models[0].buckets, [4, 2, 0, 0], 'one unobservable session must not lose the rest');
  assert.equal(query.counts.released, query.counts.observations);
});

test('a refresh answers at once and the panel keeps asking until the scan lands', async () => {
  const session = { header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
  const query = stubQuery([session]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  const cold = await handlers.summary({});
  assert.equal(cold.stale, false, 'the first ever answer has to wait for a scan');
  session.events = session.events.concat([
    { type: 'turn/start', time: 1789000001000, data: { turn: 2 } },
    { type: 'step/start', time: 1789000001000, data: { step: 1 } },
    assistant(1789000001000, 2, 1, 'prov', 'm', usage(6, 3, 0, 0)),
  ]);
  const started = Date.now();
  const forced = await handlers.refresh({});
  assert.ok(Date.now() - started < 50, 'refresh must not run the scan inside the request');
  assert.deepEqual(forced.models[0].buckets, [4, 2, 0, 0], 'it answers with the numbers it has');
  assert.equal(forced.stale, true, 'flagged as not being the scan it asked for');
  assert.equal(forced.scanning, true, 'and as a scan still running');
  const done = await settled(handlers);
  assert.equal(done.stale, false);
  assert.equal(done.scanning, false);
  assert.deepEqual(done.models[0].buckets, [10, 5, 0, 0], 'the follow-up carries the scan\u2019s own output');
});

/**
 * The projection fast path.
 *
 * The harness already folds every session's provider-reported totals into a
 * `tokenUsage` projection and checkpoints them durably. Reading those back is a
 * Map lookup, where re-deriving the same numbers from the logs cost 11.1s for one
 * 12MB session — so this path is the reason a refresh is fast, and it must keep
 * working when the services are absent, stale, or shaped differently.
 */
test('cached platform totals are read without touching a log', () => {
  const header = { version: 4, id: 's1', createdAt: 1789000000000, cwd: 'C:/w', isSeeded: false };
  const rows = { tokenUsage: { ver: 2, seq: 17222, val: { totals: { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 300, cacheWriteTokens: 1 }, last: null } } };
  const asked = [];
  const projectionCache = {
    recordFor: (id, identity) => {
      asked.push({ id, identity });
      return { identity, rows };
    },
  };
  const projections = {
    viewCheckpoint: (given, keys) => (given === rows && keys.includes('tokenUsage')
      ? { tokenUsage: { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 300, cacheWriteTokens: 1 } }
      : {}),
  };

  const usage = readCachedUsage(projectionCache, projections, [header]);
  assert.deepEqual([...usage.keys()], ['s1']);
  assert.deepEqual(usage.get('s1').buckets, [10, 4, 300, 1], 'the platform\u2019s four buckets come back in the panel\u2019s order');
  assert.equal(usage.get('s1').seq, 17222, 'the row watermark travels with the value so a caller can judge staleness');
  // The identity the cache matches on is the lifecycle, and it comes from the
  // listed header alone — no stat, no open, no read.
  assert.deepEqual(asked[0].identity, { formatVersion: 4, createdAt: 1789000000000, cwd: 'C:/w', isSeeded: false, inheritedEventCount: 0 });
});

test('the cached path degrades to nothing rather than failing a scan', () => {
  const header = { version: 4, id: 's1', createdAt: 1, isSeeded: false };
  // No services at all: an older composition simply has no fast path.
  assert.equal(readCachedUsage(undefined, undefined, [header]).size, 0);
  assert.equal(readCachedUsage(null, null, [header]).size, 0);
  // A service shaped differently, a throwing lookup, a missing row, a row the
  // registry refuses to view: every one of them means "fall back to the log".
  assert.equal(readCachedUsage({}, { viewCheckpoint: () => ({}) }, [header]).size, 0);
  assert.equal(readCachedUsage({ recordFor: () => { throw new Error('boom'); } }, { viewCheckpoint: () => ({}) }, [header]).size, 0);
  assert.equal(readCachedUsage({ recordFor: () => undefined }, { viewCheckpoint: () => ({}) }, [header]).size, 0);
  assert.equal(readCachedUsage({ recordFor: () => ({ rows: {} }) }, { viewCheckpoint: () => { throw new Error('bad row'); } }, [header]).size, 0);
  assert.equal(readCachedUsage({ recordFor: () => ({ rows: {} }) }, { viewCheckpoint: () => ({}) }, [header]).size, 0);
});

test('a cached total reconciles the fold, so the panel agrees with the platform', () => {
  // The log yields 6 input tokens; the platform says 10 (a retry it scoped
  // differently). The platform wins the total, and the shape of the folded data
  // survives the correction.
  const events = [
    { type: 'turn/start', time: 1789000000000, data: { turn: 1 } },
    { type: 'step/start', time: 1789000000000, data: { step: 1 } },
    assistant(1789000000000, 1, 1, 'prov', 'mod', usage(4, 2, 0, 0)),
    { type: 'turn/start', time: 1789000100000, data: { turn: 2 } },
    { type: 'step/start', time: 1789000100000, data: { step: 1 } },
    assistant(1789000100000, 2, 1, 'prov', 'mod', usage(0, 0, 0, 0)),
  ];
  const folded = foldSession(events, { dayKey: () => DAY, total: { buckets: [10, 6, 0, 0], seq: 99 } });
  const total = totalOfDays(folded.days);
  assert.deepEqual(total, [10, 6, 0, 0], 'the session total is exactly what the platform reported');
  assert.deepEqual(folded.days[DAY]['prov/mod'], [10, 6, 0, 0], 'and it lands on the day and model that were folded');

  // With no platform total the fold is left exactly as it was.
  const plain = foldSession(events, { dayKey: () => DAY });
  assert.deepEqual(totalOfDays(plain.days), [4, 2, 0, 0]);
});

test('a cached total rescues a session whose log cannot be read', async () => {
  const session = { header: { id: 's1', isSeeded: false }, unreadable: true, inheritedEventCount: 0, events: [] };
  const query = stubQuery([session]);
  const projectionCache = {
    recordFor: () => ({
      rows: { tokenUsage: { ver: 2, seq: 42, val: { totals: {}, last: null } } },
    }),
  };
  const projections = {
    viewCheckpoint: () => ({ tokenUsage: { uncachedInputTokens: 5, outputTokens: 3, cacheReadTokens: 700, cacheWriteTokens: 0 } }),
  };
  const handlers = createHandlers(
    { get: () => undefined },
    { sessionQuery: query, sessionProjectionCache: projectionCache, sessionProjections: projections, cachePath: null, aggregateTtlMs: 0 },
  );
  const payload = await handlers.summary({});
  // The query service refuses this log, but the platform can still account for
  // the session: its total is kept, parked on the session's creation day.
  assert.equal(payload.scope.failed, 0, 'a session the platform can account for is not a failure');
  assert.equal(payload.scope.cached, 1);
  assert.equal(totalOfWireDays(payload.days)[2], 700, 'the cached total is not lost');
  assert.equal(payload.models[payload.models.length - 1].key, UNKNOWN_MODEL_KEY, 'undated usage is attributed to no model');
});

/**
 * The regression that made every refresh cost seconds.
 *
 * A scan that runs out of its split budget parks a session on the platform's own
 * total and records which platform row that placement came from. Recording
 * `undefined` there instead (because the entry being replaced had no row) meant the
 * session could never satisfy the carry-over test, so it re-entered the read queue
 * on EVERY scan: measured on a real corpus, 5 of 25 sessions were re-read on every
 * refresh forever, which was most of a 3-5s refresh. A repeat refresh must not read
 * a log at all once every session has been placed.
 */
test('a session parked on its platform total is not re-read on the next scan', async () => {
  const sessions = [
    { header: { id: 'big', isSeeded: false, version: 4, createdAt: 1789000000000 }, inheritedEventCount: 0, events: sessionEvents('m', usage(1000, 200, 5000, 0), 1789000000000) },
    { header: { id: 'small', isSeeded: false, version: 4, createdAt: 1789000000000 }, inheritedEventCount: 0, events: sessionEvents('m', usage(10, 2, 30, 0), 1789000000000) },
  ];
  const query = stubQuery(sessions);
  const totals = {
    big: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 },
    small: { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 0 },
  };
  const perId = (id) => (totals[id] === undefined
    ? undefined
    : { identity: { formatVersion: 4 }, rows: { tokenUsage: { ver: 2, seq: 99, val: { totals: {}, last: null } } } });
  // The registry views a row for whichever session the cache was just asked about.
  let asked = 'big';
  const projectionCache = {
    recordFor: (id) => {
      asked = id;
      return perId(id);
    },
  };
  const projections = { viewCheckpoint: () => ({ tokenUsage: totals[asked] }) };

  // An exhausted budget parks every split on the first scan, which is the state
  // this test is about: both sessions reported from the platform cache alone.
  const handlers = createHandlers(
    { get: () => undefined },
    { sessionQuery: query, sessionProjectionCache: projectionCache, sessionProjections: projections, cachePath: null, aggregateTtlMs: 0, splitBudgetMs: -1 },
  );
  const first = await handlers.summary({});
  assert.equal(first.scope.deferred, 2, 'an exhausted budget parks both sessions');
  assert.equal(first.scope.cached, 2, 'and both are still answered from the platform total');
  const readsAfterFirst = query.reads.length;

  // The parked placement was reconciled against the platform row that produced it,
  // so the next scan must not read either log: this is the regression that made a
  // repeat refresh cost seconds, because a parked session could never satisfy the
  // carry-over test and so re-entered the read queue forever.
  //
  // `refresh` publishes the current aggregate and scans behind it, so the scan's own
  // numbers have to be asked for the way the panel asks for them.
  const second = await settled(handlers, { force: true });
  assert.equal(query.reads.length, readsAfterFirst, 'a parked session must not be re-read');
  assert.equal(second.scope.reused, 2, 'both sessions carry over from the platform cache');
});

test('the durable rollup is keyed on the log, not on the file that holds it', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-token-stats-test-'));
  const cachePath = join(dir, 'rollup.json');
  try {
    const session = { header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
    // A store that reports a stable event count and a byte size the rewriter
    // changes: compaction must not invalidate an unchanged log.
    let bytes = 1000;
    const query = stubQuery([session]);
    const persistence = {
      stat: async () => ({ header: session.header, eventCount: 4, sizeBytes: bytes }),
      open: async () => { throw new Error('not used'); },
      list: async () => [],
    };
    const first = createHandlers({ get: () => undefined }, { sessionQuery: query, sessionPersistence: persistence, cachePath, aggregateTtlMs: 0 });
    await first.refresh({});
    assert.deepEqual(query.reads, ['s1']);
    bytes = 900;
    const second = createHandlers({ get: () => undefined }, { sessionQuery: query, sessionPersistence: persistence, cachePath, aggregateTtlMs: 0 });
    // The rollup is restored before the scan runs, so `summary` answers from it at
    // once and the scan settles behind the response; `settled` asks the way the
    // panel does and hands back the scan's own output.
    const payload = await settled(second);
    assert.deepEqual(query.reads, ['s1'], 'a re-compressed but unchanged log must not be re-read');
    assert.equal(payload.scope.reused, 1, 'the session is answered from the rollup, not re-folded');
    assert.equal(payload.scope.read, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a scan that fails stops reporting itself instead of spinning forever', async () => {  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  await handlers.summary({});
  query.listSessions = async () => { throw new Error('listing exploded'); };
  const forced = await handlers.refresh({});
  assert.equal(forced.scanning, true);
  let after = await handlers.summary({});
  for (let i = 0; i < 50 && after.scanning === true; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    after = await handlers.summary({});
  }
  assert.equal(after.scanning, false, 'a failed scan must stop claiming to be running');
  assert.equal(after.stale, false, 'and the previous numbers are the best answer there is');
  assert.deepEqual(after.models[0].buckets, [4, 2, 0, 0]);
});

test('sessions removed from the listing keep counting unless retention is off', async () => {
  const session = { header: { id: 'gone', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(100, 50, 0, 0), 1789000000000) };
  const sessions = [session];
  const query = {
    listSessions: async () => sessions.map((entry) => ({ header: entry.header, live: false, persisted: true })),
    listEvents: async () => session.events.map((event, index) => ({ seq: index, type: event.type, time: event.time })),
    readSession: async () => ({ session: session.header, inheritedEventCount: 0, events: session.events }),
  };
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  const before = await handlers.summary({});
  assert.deepEqual(before.models[0].buckets, [100, 50, 0, 0]);
  assert.equal(before.scope.retired, 0);

  sessions.length = 0;
  const after = await settled(handlers, { force: true });
  assert.equal(after.scope.retired, 1, 'the removed session must be reported as retained');
  assert.deepEqual(after.models[0].buckets, [100, 50, 0, 0], 'a lifetime total must not shrink when history is cleaned up');

  const strict = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000, retainSessions: false });
  await strict.summary({});
  const emptied = await settled(strict, { force: true });
  assert.equal(emptied.scope.retired, 0);
  assert.equal(emptied.models.length, 0, 'retainSessions:false must drop removed sessions');
});

test('markers change when a log grows', () => {
  assert.equal(markerOf([]), '0:-1');
  assert.equal(markerOf([{ seq: 0 }, { seq: 7 }]), '2:7');
  assert.notEqual(markerOf([{ seq: 7 }]), markerOf([{ seq: 7 }, { seq: 8 }]));
});

test('the payload ranks models and folds the tail into one slice', () => {
  const cache = new Map([
    ['s1', { marker: 'm', days: { '2026-09-09': { 'p/big': [100, 100, 0, 0], 'p/small': [1, 1, 0, 0] } } }],
    ['s2', { marker: 'm', days: { '2026-09-10': { 'p/big': [50, 10, 5, 1], 'p/tiny': [2, 2, 0, 0] } } }],
  ]);
  const payload = buildPayload(cache, new Map([['p/big', 'Big Model']]), 2);
  assert.equal(payload.models.length, 3, 'two kept models plus the folded tail');
  assert.equal(payload.models[0].key, 'p/big');
  assert.equal(payload.models[0].name, 'Big Model');
  assert.equal(payload.models[1].key, 'p/tiny', 'ranking uses input + output');
  assert.equal(payload.models[2].key, OTHER_MODEL_KEY);
  assert.deepEqual(payload.models[2].buckets, [1, 1, 0, 0], 'the folded tail must not lose its usage');
  assert.deepEqual(payload.range, { first: '2026-09-09', last: '2026-09-10' });
  assert.deepEqual(payload.days.map((day) => day.d), ['2026-09-09', '2026-09-10']);
  const first = payload.days[0];
  assert.deepEqual(first.b, [101, 101, 0, 0]);
  assert.deepEqual(first.m, [[0, 100, 100, 0, 0], [2, 1, 1, 0, 0]], 'day slices are index-ordered');
});

test('a model without a name falls back to its id', () => {
  const cache = new Map([['s1', { marker: 'm', days: { '2026-09-10': { 'prov/model-x': [1, 1, 0, 0] } } }]]);
  const payload = buildPayload(cache, new Map(), 8);
  assert.equal(payload.models[0].name, 'model-x');
  assert.equal(payload.models[0].provider, 'prov');
  assert.equal(payload.models[0].model, 'model-x');
});

/** A sessionQuery stub over an in-memory session table. */
function stubQuery(sessions) {
  const reads = [];
  const listings = [];
  return {
    reads,
    listings,
    listSessions: async () => sessions.map((session) => ({ header: session.header, live: session.live === true, persisted: true })),
    listEvents: async (id) => {
      listings.push(id);
      const session = sessions.find((entry) => entry.header.id === id);
      return session === undefined ? [] : session.events.map((event, index) => ({ sessionId: id, seq: index, type: event.type, time: event.time, surface: 'log' }));
    },
    readSession: async (id) => {
      reads.push(id);
      const session = sessions.find((entry) => entry.header.id === id);
      if (session === undefined) throw new Error('unknown session');
      if (session.unreadable === true) throw new Error('format generation not supported');
      return { session: session.header, inheritedEventCount: session.inheritedEventCount, events: session.events };
    },
  };
}

/**
 * Follow one rescan all the way to its own output.
 *
 * Neither entry point waits for a scan any more: both answer from what the host
 * already has and tag that answer `stale` / `scanning` while a scan runs. Tests
 * that want the *scan's* numbers therefore have to ask the way the panel does —
 * request the scan, then keep asking until the host stops reporting one.
 *
 * @param handlers - the handler map under test.
 * @param options - `{ force?: boolean }`: force the first request to rescan.
 * @returns the payload produced by the latest completed scan.
 */
async function settled(handlers, options = {}) {
  let value = await handlers.summary(options.force === true ? { force: true } : {});
  for (let i = 0; i < 200 && (value.stale === true || value.scanning === true); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    value = await handlers.summary({});
  }
  return value;
}

/**
 * Pressing Refresh repeatedly is normal — the numbers are being watched — and each
 * press used to redo the whole pass, which starts with `listSessions` and then
 * visits every session. On the corpus this was measured against that meant every
 * single press cost 1-3s. A press landing just after a scan finished is now answered
 * from that scan, so a burst costs one scan.
 */
test('a burst of refresh presses costs one scan', async () => {
  const session = { header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
  const query = stubQuery([session]);
  const handlers = createHandlers(
    { get: () => undefined },
    { sessionQuery: query, cachePath: null, aggregateTtlMs: 0, refreshFloorMs: 60_000 },
  );

  // The first press scans and settles; the ones right behind it must not.
  const first = await settled(handlers, { force: true });
  const readsAfterFirst = query.reads.length;
  assert.equal(readsAfterFirst, 1, 'the first press scans once');

  for (let i = 0; i < 5; i += 1) {
    const press = await handlers.refresh({});
    assert.equal(press.scanning, false, 'a press inside the floor starts no scan');
    assert.equal(press.stale, false, 'and its numbers are not stale');
    assert.equal(press.durationMs, first.durationMs, 'the answer is the scan that already ran');
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(query.reads.length, readsAfterFirst, 'a burst of presses reads nothing more');
});

test('outside the floor a press scans again', async () => {
  const session = { header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
  const query = stubQuery([session]);
  // A zero floor is what a direct caller gets: a press is always a real scan, so a
  // caller that needs a guaranteed fresh answer is never silently served a cached
  // one. This is the behaviour the other refresh tests rely on.
  const handlers = createHandlers(
    { get: () => undefined },
    { sessionQuery: query, cachePath: null, aggregateTtlMs: 0, refreshFloorMs: 0 },
  );
  await handlers.refresh({});
  assert.equal(query.reads.length, 1, 'the first press scans');
  // With no floor the press is not answered from the scan that just ran: it is
  // reported stale because a fresh scan is behind it. That scan may coalesce with
  // one already in flight — concurrent callers share a pass on purpose — so the
  // claim here is about the reported freshness, not a read count.
  const press = await handlers.refresh({});
  assert.equal(press.stale, true, 'a press past the floor is reported stale while it rescans');
});

/**
 * A sessionQuery stub whose sessions are reachable through `observeSession`,
 * like the real service.
 *
 * `counts.materializations` counts reads of the lazily published event array,
 * which is what makes "the cache never touched that log" a provable claim rather
 * than an assumption; `counts.released` counts the observations handed back.
 *
 * @param sessions - in-memory session table, same shape as {@link stubQuery}.
 * @returns the stub plus a `counts` record.
 */
function observingQuery(sessions) {
  const query = stubQuery(sessions);
  const counts = { observations: 0, materializations: 0, released: 0 };
  query.counts = counts;
  query.observeSession = async (id) => {
    const session = sessions.find((entry) => entry.header.id === id);
    if (session === undefined) throw new Error('unknown session');
    const events = session.events;
    let published;
    counts.observations += 1;
    return {
      source: 'live',
      header: session.header,
      inheritedEventCount: session.inheritedEventCount,
      cursor: events.length === 0 ? -1 : events.length - 1,
      get events() {
        counts.materializations += 1;
        published ??= events.slice();
        return published;
      },
      [Symbol.dispose]() { counts.released += 1; },
    };
  };
  return query;
}

/** Sum the wire payload's day rows into four buckets. */
function totalOfWireDays(days) {
  const total = [0, 0, 0, 0];
  for (const day of days) {
    for (let i = 0; i < 4; i += 1) total[i] += day.b[i];
  }
  return total;
}

/** Sum a day × model table, for assertions about session totals. */
function totalOfDays(days) {
  const total = [0, 0, 0, 0];
  for (const day of Object.keys(days)) {
    for (const model of Object.keys(days[day])) {
      const buckets = days[day][model];
      for (let i = 0; i < 4; i += 1) total[i] += buckets[i];
    }
  }
  return total;
}

/** Events for one billed step. */
function sessionEvents(model, buckets, time) {  return [
    { type: 'turn/start', time, data: { turn: 1 } },
    { type: 'step/start', time, data: { step: 1 } },
    assistant(time, 1, 1, 'prov', model, buckets),
    { type: 'turn/end', time: time + 1, data: { turn: 1 } },
  ];
}

test('a scan reads each session once and then reuses unchanged logs', async () => {
  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  const first = await handlers.summary({});
  assert.deepEqual(query.reads, ['s1']);
  assert.equal(first.scope.read, 1);
  assert.equal(first.scope.reused, 0);
  assert.deepEqual(first.models[0].buckets, [4, 2, 0, 0]);

  const second = await settled(handlers, { force: true });
  assert.deepEqual(query.reads, ['s1'], 'an unchanged log must not be re-read');
  assert.equal(second.scope.reused, 1);
  assert.equal(second.scope.read, 0);
  assert.deepEqual(second.models[0].buckets, [4, 2, 0, 0], 'a reused rollup still answers the payload');
});

/**
 * The host has one thread, and folding a changed session is synchronous work on
 * it. A scan therefore has to hand the loop back between sessions, or a panel
 * request whose answer is already cached waits for the whole pass: measured
 * against the live host, summary calls issued during a rescan took 0.5–3.9s.
 */
test('a scan yields the loop between sessions', async () => {
  const sessions = [
    { header: { id: 'a', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) },
    { header: { id: 'b', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(6, 3, 0, 0), 1789000001000) },
  ];
  const query = stubQuery(sessions);
  const turned = { value: false, atRead: [] };
  // Queued before the scan, so it sits ahead of the scan's own yield in the
  // check phase. The fake queries below resolve on microtasks, and microtasks
  // never reach the check phase, so this stays false for the whole scan unless
  // the scan hands the loop back itself.
  setImmediate(() => { turned.value = true; });
  const original = query.readSession;
  query.readSession = async (id) => {
    turned.atRead.push(turned.value);
    return original(id);
  };

  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const payload = await handlers.summary({});
  assert.equal(payload.scope.sessions, 2);
  assert.equal(turned.atRead.length, 2, 'both sessions must have been read');
  assert.deepEqual(turned.atRead, [true, true], 'every session must be folded only after a macrotask turn');
});

test('a grown log is re-read and replaces its own buckets', async () => {
  const session = { header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
  const query = stubQuery([session]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  await handlers.summary({});
  session.events = session.events.concat([
    { type: 'turn/start', time: 1789000001000, data: { turn: 2 } },
    { type: 'step/start', time: 1789000001000, data: { step: 1 } },
    assistant(1789000001000, 2, 1, 'prov', 'm', usage(6, 3, 0, 0)),
  ]);
  const grown = await settled(handlers, { force: true });
  assert.deepEqual(query.reads, ['s1', 's1']);
  assert.equal(grown.scope.read, 1);
  assert.deepEqual(grown.models[0].buckets, [10, 5, 0, 0], 'a replaced rollup must not double count');
});

test('a forked session does not re-count its inherited prefix', async () => {
  const inherited = sessionEvents('parent-model', usage(1000, 500, 0, 0), 1789000000000);
  const own = [
    { type: 'turn/start', time: 1789000002000, data: { turn: 5 } },
    { type: 'step/start', time: 1789000002000, data: { step: 1 } },
    assistant(1789000002000, 5, 1, 'prov', 'own-model', usage(7, 3, 0, 0)),
  ];
  const query = stubQuery([
    { header: { id: 'parent', isSeeded: false }, inheritedEventCount: 0, events: inherited },
    { header: { id: 'fork', isSeeded: true }, inheritedEventCount: inherited.length, events: inherited.concat(own) },
  ]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const payload = await handlers.summary({});
  assert.equal(payload.scope.seeded, 1);
  assert.deepEqual(payload.models.map((entry) => entry.key).sort(), ['prov/own-model', 'prov/parent-model']);
  const byKey = new Map(payload.models.map((entry) => [entry.key, entry.buckets]));
  assert.deepEqual(byKey.get('prov/parent-model'), [1000, 500, 0, 0], 'the parent is counted once, not twice');
  assert.deepEqual(byKey.get('prov/own-model'), [7, 3, 0, 0]);
});

test('an unreadable session is skipped without failing the scan', async () => {
  const query = stubQuery([
    { header: { id: 'ok', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) },
    { header: { id: 'legacy', isSeeded: false }, unreadable: true, inheritedEventCount: 0, events: [] },
  ]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const payload = await handlers.summary({});
  assert.equal(payload.scope.failed, 1);
  assert.equal(payload.scope.failedSessions.length, 1);
  assert.equal(payload.scope.failedSessions[0].id, 'legacy');
  assert.equal(payload.scope.failedSessions[0].error, 'Error: format generation not supported');
  assert.equal(payload.scope.sessions, 2);
  assert.deepEqual(payload.models[0].buckets, [4, 2, 0, 0], 'one bad session must not lose the good ones');
});

test('an unreadable session is not re-read on every scan', async () => {
  const query = stubQuery([{ header: { id: 'legacy', isSeeded: false }, unreadable: true, inheritedEventCount: 0, events: [] }]);
  let attempts = 0;
  const read = query.readSession;
  query.readSession = async (id) => { attempts += 1; return read(id); };
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const first = await handlers.summary({});
  assert.equal(first.scope.failed, 1);
  assert.equal(attempts, 1);

  const second = await handlers.summary({ force: true });
  assert.equal(second.scope.failed, 1, 'the failure must keep being reported');
  assert.equal(second.scope.failedSessions[0].id, 'legacy');
  assert.equal(second.scope.failedSessions[0].error, 'Error: format generation not supported');
  assert.equal(attempts, 1, 'an unchanged unreadable log must not be re-read on every scan');
});

test('the aggregate is served from cache inside the TTL and refreshed past it', async () => {
  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 60000 });
  const first = await handlers.summary({});
  const second = await handlers.summary({});
  assert.equal(second.stale, false);
  assert.equal(query.listings.length, 1, 'no second listing inside the TTL');
  const started = Date.now();
  const forced = await handlers.refresh({});
  assert.ok(Date.now() - started < 50, 'but it must not wait for that rescan to finish');
  assert.equal(forced.stale, true, 'the answer is from before the scan it asked for');
  assert.equal(forced.scanning, true, 'and the panel must be told a scan is running');
  const done = await settled(handlers);
  assert.equal(query.listings.length, 2, 'refresh always rescans, just not inside the request');
  assert.equal(done.stale, false);
  assert.equal(done.scanning, false);
});

test('a stale aggregate is answered at once and refreshed behind the response', async () => {
  const session = { header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
  const query = stubQuery([session]);
  // TTL 0 makes every later read stale.
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const cold = await handlers.summary({});
  assert.equal(cold.stale, false, 'the first ever answer has to wait for a scan');
  assert.deepEqual(cold.models[0].buckets, [4, 2, 0, 0]);

  session.events = session.events.concat([
    { type: 'turn/start', time: 1789000001000, data: { turn: 2 } },
    { type: 'step/start', time: 1789000001000, data: { step: 1 } },
    assistant(1789000001000, 2, 1, 'prov', 'm', usage(6, 3, 0, 0)),
  ]);

  const listingsBefore = query.listings.length;
  const started = Date.now();
  const stale = await handlers.summary({});
  const elapsed = Date.now() - started;
  // Regression: this call used to block on a full rescan, which re-reads the
  // live session's whole log — 1-2s on a real machine, paid on every panel open.
  assert.equal(stale.stale, true, 'an expired aggregate must be flagged, not silently waited on');
  assert.deepEqual(stale.models[0].buckets, [4, 2, 0, 0], 'the stale answer is the previous scan');
  assert.ok(elapsed < 50, 'the stale answer must not wait for the rescan, took ' + elapsed + 'ms');
  assert.equal(query.listings.length, listingsBefore, 'the rescan must run off the response path');

  for (let i = 0; i < 40 && query.reads.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const settled = await handlers.summary({});
  assert.deepEqual(settled.models[0].buckets, [10, 5, 0, 0], 'the background scan replaced the stale answer');
});

test('the persisted aggregate lets a cold host answer without scanning', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-token-stats-test-'));
  const cachePath = join(dir, 'rollup.json');
  try {
    const session = { header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
    const first = createHandlers({ get: () => undefined }, { sessionQuery: stubQuery([session]), cachePath, aggregateTtlMs: 60000 });
    await first.summary({});

    // A brand-new handler stands in for a restarted web process.
    const coldQuery = stubQuery([session]);
    const second = createHandlers({ get: () => undefined }, { sessionQuery: coldQuery, cachePath, aggregateTtlMs: 60000 });
    const restored = await second.summary({});
    assert.equal(restored.stale, false, 'a restored aggregate is inside its TTL');
    assert.deepEqual(restored.models[0].buckets, [4, 2, 0, 0]);
    assert.deepEqual(coldQuery.reads, [], 'nothing had to be read to answer');
    assert.deepEqual(coldQuery.listings, [], 'not even a listing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent callers share one scan', async () => {
  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const [a, b, c] = await Promise.all([handlers.summary({}), handlers.summary({}), handlers.summary({})]);
  assert.equal(a.generatedAt, b.generatedAt);
  assert.equal(b.generatedAt, c.generatedAt);
  assert.equal(query.listings.length, 1, 'three panels opening at once must cost one scan');
});

test('a persistent rollup is written and reused across handler instances', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-token-stats-test-'));
  const cachePath = join(dir, 'rollup.json');
  try {
    const session = { header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
    const first = createHandlers({ get: () => undefined }, { sessionQuery: stubQuery([session]), cachePath, aggregateTtlMs: 60000 });
    await first.summary({});
    const secondQuery = stubQuery([session]);
    const second = createHandlers({ get: () => undefined }, { sessionQuery: secondQuery, cachePath, aggregateTtlMs: 60000 });
    // Force a scan: a plain summary now answers from the restored aggregate, so
    // only an explicit rescan proves the per-session rollup itself survived.
    const payload = await settled(second, { force: true });
    assert.deepEqual(secondQuery.reads, [], 'a warm rollup survives a handler restart');
    assert.equal(payload.scope.reused, 1);
    assert.deepEqual(payload.models[0].buckets, [4, 2, 0, 0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt rollup is ignored rather than trusted', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-token-stats-test-'));
  const cachePath = join(dir, 'rollup.json');
  try {
    await writeFile(cachePath, '{ this is not json', 'utf8');
    const query = stubQuery([{ header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
    const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath, aggregateTtlMs: 0 });
    const payload = await handlers.summary({});
    assert.deepEqual(query.reads, ['s1'], 'a corrupt cache must fall back to a full read');
    assert.deepEqual(payload.models[0].buckets, [4, 2, 0, 0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model display names are resolved when the llm service is mounted', async () => {
  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  const ctx = { get: (name) => (name === 'llm' ? { listModels: async (provider) => (provider === 'prov' ? [{ provider, id: 'm', name: 'Model M' }] : []) } : undefined) };
  const handlers = createHandlers(ctx, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const payload = await handlers.summary({});
  assert.equal(payload.models[0].name, 'Model M');
});

test('a failing llm service degrades to raw model ids', async () => {
  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  const ctx = { get: (name) => (name === 'llm' ? { listModels: async () => { throw new Error('provider is not mounted'); } } : undefined) };
  const handlers = createHandlers(ctx, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const payload = await handlers.summary({});
  assert.equal(payload.models[0].name, 'm');
});

test('a composition without sessionQuery fails with a business error', async () => {
  const handlers = createHandlers({ get: () => undefined }, { cachePath: null });
  await assert.rejects(() => handlers.summary({}), (error) => {
    assert.equal(error.code, 'token-stats/no-session-query');
    return true;
  });
});

/**
 * The load-bearing correctness test: on every real Turn that the platform's own
 * `deriveTurnTokenUsage()` can derive, the fold must reproduce all four buckets
 * exactly. The deriver is authoritative but incomplete (it returns undefined for
 * any turn containing a compaction), so it is a cross-check here rather than the
 * source of truth.
 */
test('the fold reproduces the platform deriver on every derivable real turn', async (t) => {
  const home = process.env.USERPROFILE || homedir();
  const sessionsDir = join(home, '.dsh', 'sessions');
  const deriver = join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-token-meter', 'lib', 'types', 'turn-usage.js');
  if (!existsSync(sessionsDir)) return t.skip('no session logs on this machine');
  if (!existsSync(deriver)) return t.skip('dsh-token-meter is not installed in this profile');

  let deriveTurnTokenUsage;
  try {
    ({ deriveTurnTokenUsage } = await import(pathToFileURL(deriver).href));
  } catch (error) {
    return t.skip('the deriver could not be imported: ' + error.message);
  }

  const logs = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (name.endsWith('.v3.jsonl.zstd')) logs.push(path);
    }
  };
  walk(sessionsDir);
  if (logs.length === 0) return t.skip('no v3 session logs on this machine');

  let turns = 0;
  let derivable = 0;
  let undefinedTurns = 0;
  let threw = 0;
  let totalChecked = 0;
  let totalExact = 0;
  const mismatches = [];

  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeSessionLog(log);
    } catch (error) {
      continue;
    }
    for (const turn of turnsOf(decoded.events)) {
      turns += 1;
      let derived;
      try {
        derived = deriveTurnTokenUsage(turn);
      } catch (error) {
        threw += 1;
        continue;
      }
      if (derived === undefined) {
        undefinedTurns += 1;
        continue;
      }
      derivable += 1;
      const folded = foldSession(turn, { dayKey: () => DAY });
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      for (const day of Object.keys(folded.days)) {
        for (const key of Object.keys(folded.days[day])) {
          input += folded.days[day][key][0];
          output += folded.days[day][key][1];
          cacheRead += folded.days[day][key][2];
          cacheWrite += folded.days[day][key][3];
        }
      }
      const mismatch = input !== derived.uncachedInputTokens
        || output !== derived.outputTokens
        || (derived.cacheReadTokens !== undefined && cacheRead !== derived.cacheReadTokens)
        || (derived.cacheWriteTokens !== undefined && cacheWrite !== derived.cacheWriteTokens);
      if (mismatch && mismatches.length < 5) {
        mismatches.push({ log, folded: { input, output, cacheRead, cacheWrite }, derived });
      }
      // The provider's own total must equal the sum of the four buckets; this is
      // what makes the metric switch a truthful split of one number.
      if (typeof derived.totalTokens === 'number') {
        totalChecked += 1;
        if (input + output + cacheRead + cacheWrite === derived.totalTokens) totalExact += 1;
      }
    }
  }

  if (turns === 0) return t.skip('no completed turns in any local session log');
  if (derivable === 0) return t.skip('no derivable turns in any local session log');
  assert.equal(mismatches.length, 0, 'the fold disagreed with the deriver: ' + JSON.stringify(mismatches[0], null, 2));
  assert.ok(derivable > 0, 'the comparison loop must have executed at least one comparison');
  assert.equal(totalExact, totalChecked, 'provider totals must equal input + output + cacheRead + cacheWrite');
  t.diagnostic('turns=' + turns + ' derivable=' + derivable + ' undefined(compaction)=' + undefinedTurns + ' threw=' + threw + ' totalsExact=' + totalExact);
});
