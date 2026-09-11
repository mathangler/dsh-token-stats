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
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, sessionPersistence: persistence, cachePath: null, aggregateTtlMs: 0 });
  const first = await handlers.summary({});
  assert.deepEqual(first.models[0].buckets, [4, 2, 0, 0]);
  assert.equal(stats.length, 1, 'the cheap metadata path must be consulted');
  assert.equal(parses, 0, 'a closed session must not be parsed just to detect change');

  const second = await handlers.summary({ force: true });
  assert.equal(second.scope.reused, 1);
  assert.equal(parses, 0, 'the second scan must stay off the parse path too');
});

test('a live session is still parsed so unflushed events are counted', async () => {
  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, live: true, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  let parses = 0;
  const list = query.listEvents;
  query.listEvents = async (id) => { parses += 1; return list(id); };
  const persistence = { stat: async (id) => ({ header: { id }, revision: 'rev-1', eventCount: 99, sizeBytes: 999 }) };
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, sessionPersistence: persistence, cachePath: null, aggregateTtlMs: 0 });
  await handlers.summary({});
  assert.equal(parses, 1, 'a live session\u2019s file metadata can lag its in-memory events');
});

test('sessions removed from the listing keep counting unless retention is off', async () => {
  const session = { header: { id: 'gone', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(100, 50, 0, 0), 1789000000000) };
  const sessions = [session];
  const query = {
    listSessions: async () => sessions.map((entry) => ({ header: entry.header, live: false, persisted: true })),
    listEvents: async () => session.events.map((event, index) => ({ seq: index, type: event.type, time: event.time })),
    readSession: async () => ({ session: session.header, inheritedEventCount: 0, events: session.events }),
  };
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const before = await handlers.summary({});
  assert.deepEqual(before.models[0].buckets, [100, 50, 0, 0]);
  assert.equal(before.scope.retired, 0);

  sessions.length = 0;
  const after = await handlers.summary({ force: true });
  assert.equal(after.scope.retired, 1, 'the removed session must be reported as retained');
  assert.deepEqual(after.models[0].buckets, [100, 50, 0, 0], 'a lifetime total must not shrink when history is cleaned up');

  const strict = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0, retainSessions: false });
  await strict.summary({});
  const emptied = await strict.summary({ force: true });
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

/** Events for one billed step. */
function sessionEvents(model, buckets, time) {
  return [
    { type: 'turn/start', time, data: { turn: 1 } },
    { type: 'step/start', time, data: { step: 1 } },
    assistant(time, 1, 1, 'prov', model, buckets),
    { type: 'turn/end', time: time + 1, data: { turn: 1 } },
  ];
}

test('a scan reads each session once and then reuses unchanged logs', async () => {
  const query = stubQuery([{ header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) }]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  const first = await handlers.summary({});
  assert.deepEqual(query.reads, ['s1']);
  assert.equal(first.scope.read, 1);
  assert.equal(first.scope.reused, 0);
  assert.deepEqual(first.models[0].buckets, [4, 2, 0, 0]);

  const second = await handlers.summary({ force: true });
  assert.deepEqual(query.reads, ['s1'], 'an unchanged log must not be re-read');
  assert.equal(second.scope.reused, 1);
  assert.equal(second.scope.read, 0);
  assert.deepEqual(second.models[0].buckets, [4, 2, 0, 0], 'a reused rollup still answers the payload');
});

test('a grown log is re-read and replaces its own buckets', async () => {
  const session = { header: { id: 's1', isSeeded: false }, inheritedEventCount: 0, events: sessionEvents('m', usage(4, 2, 0, 0), 1789000000000) };
  const query = stubQuery([session]);
  const handlers = createHandlers({ get: () => undefined }, { sessionQuery: query, cachePath: null, aggregateTtlMs: 0 });
  await handlers.summary({});
  session.events = session.events.concat([
    { type: 'turn/start', time: 1789000001000, data: { turn: 2 } },
    { type: 'step/start', time: 1789000001000, data: { step: 1 } },
    assistant(1789000001000, 2, 1, 'prov', 'm', usage(6, 3, 0, 0)),
  ]);
  const grown = await handlers.summary({ force: true });
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
  const forced = await handlers.refresh({});
  // Counted rather than compared by timestamp: two in-memory scans can land in
  // the same millisecond.
  assert.equal(query.listings.length, 2, 'refresh always rescans');
  assert.equal(forced.stale, false);
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
    const first = createHandlers({ get: () => undefined }, { sessionQuery: stubQuery([session]), cachePath, aggregateTtlMs: 0 });
    await first.summary({});
    const secondQuery = stubQuery([session]);
    const second = createHandlers({ get: () => undefined }, { sessionQuery: secondQuery, cachePath, aggregateTtlMs: 0 });
    // Force a scan: a plain summary now answers from the restored aggregate, so
    // only an explicit rescan proves the per-session rollup itself survived.
    const payload = await second.refresh({});
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
