/**
 * Route-layer tests for the host half.
 *
 * These drive the real `webServer` handler that `apply` registers, with fake
 * request/response objects, and prove the platform's conventions hold: the trust
 * fence runs before any read, wire faults are 4xx/5xx, and business failures are
 * HTTP 200 with a failure envelope.
 *
 * @module dsh-token-stats/test/route
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { apply, CHANNEL } from '../lib/index.js';

/** Install the plugin against a stub context and return the registered route. */
function mount(config) {
  const routes = [];
  const disposers = [];
  const ctx = {
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose; },
    get: () => undefined,
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    connection: { requestRejection: (req) => req.rejectAs },
  };
  apply(ctx, config);
  return {
    route: routes[0],
    dispose: () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose(); },
  };
}

/** A request stream carrying the given body plus the headers the code reads. */
function fakeRequest(options = {}) {
  const stream = Readable.from([Buffer.from(options.body === undefined ? '{}' : options.body, 'utf8')]);
  stream.method = options.method === undefined ? 'POST' : options.method;
  stream.headers = options.contentType === null ? {} : { 'content-type': options.contentType === undefined ? 'application/json' : options.contentType };
  stream.url = options.url === undefined ? CHANNEL + '/summary' : options.url;
  stream.rejectAs = options.rejectAs;
  return stream;
}

/** A response object that records what the handler wrote. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
}

/** Run one request through the mounted route. */
async function call(options, config) {
  const mounted = mount(config);
  const res = fakeResponse();
  await mounted.route.handler(fakeRequest(options), res);
  mounted.dispose();
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch (e) { parsed = null; }
  return { res, parsed };
}

test('the route is published as a prefix on the plugin channel', () => {
  const mounted = mount();
  assert.equal(mounted.route.kind, 'prefix');
  assert.equal(mounted.route.path, CHANNEL);
  assert.equal(typeof mounted.route.handler, 'function');
  mounted.dispose();
});

test('an untrusted caller is rejected before any read', async () => {
  const { res, parsed } = await call({ rejectAs: 401, body: '{ not json' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, '', 'a rejected request must not receive a body');
  assert.equal(parsed, null);
});

test('a non-POST method is refused with 405 and an Allow header', async () => {
  const { res } = await call({ method: 'GET' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('a non-JSON content type is refused with 415', async () => {
  const { res, parsed } = await call({ contentType: 'text/plain' });
  assert.equal(res.statusCode, 415);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'token-stats/bad-request');
});

test('a missing content type is refused with 415', async () => {
  const { res } = await call({ contentType: null });
  assert.equal(res.statusCode, 415);
});

test('a malformed endpoint is refused with 404', async () => {
  const { res, parsed } = await call({ url: CHANNEL + '/summary%20extra' });
  assert.equal(res.statusCode, 404);
  assert.equal(parsed.error.code, 'token-stats/unknown-endpoint');
});

test('an unknown endpoint is refused with 404', async () => {
  const { res, parsed } = await call({ url: CHANNEL + '/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(parsed.error.code, 'token-stats/unknown-endpoint');
  assert.ok(parsed.error.message.includes('nope'));
});

test('an oversized body is refused with 413', async () => {
  const { res, parsed } = await call({ body: 'x'.repeat(70 * 1024) });
  assert.equal(res.statusCode, 413);
  assert.equal(parsed.error.code, 'token-stats/too-large');
});

test('a non-JSON body is refused with 400', async () => {
  const { res, parsed } = await call({ body: '{ not json' });
  assert.equal(res.statusCode, 400);
  assert.equal(parsed.error.code, 'token-stats/bad-request');
});

test('an empty body is accepted as an empty payload', async () => {
  const { res, parsed } = await call({ body: '   ' });
  assert.equal(res.statusCode, 200);
  assert.equal(parsed.ok, false, 'the composition has no sessionQuery, so the business call must fail loudly');
  assert.equal(parsed.error.code, 'token-stats/no-session-query');
});

test('a business failure is HTTP 200 with a failure envelope', async () => {
  const { res, parsed } = await call({});
  assert.equal(res.statusCode, 200);
  assert.equal(parsed.ok, false);
  assert.equal(typeof parsed.error.message, 'string');
  assert.ok(parsed.error.message.length > 0, 'the panel needs a reason, not just a code');
});

test('a successful call answers the value envelope with the payload', async () => {
  const sessionQuery = {
    listSessions: async () => [{ header: { id: 's1', isSeeded: false } }],
    listEvents: async () => [{ seq: 0 }, { seq: 1 }],
    readSession: async () => ({
      session: { id: 's1' },
      inheritedEventCount: 0,
      events: [
        { type: 'turn/start', time: 1789000000000, data: { turn: 1 } },
        { type: 'step/start', time: 1789000000000, data: { step: 1 } },
        {
          type: 'assistant/message',
          time: 1789000000000,
          data: {
            turn: 1,
            step: 1,
            usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 0 },
            message: { source: { kind: 'model', provider: 'prov', model: 'mod' } },
          },
        },
        { type: 'turn/end', time: 1789000000001, data: { turn: 1 } },
      ],
    }),
  };
  const { res, parsed } = await call({}, { sessionQuery, cachePath: null });
  assert.equal(res.statusCode, 200);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.models.length, 1);
  assert.equal(parsed.value.models[0].key, 'prov/mod');
  assert.deepEqual(parsed.value.models[0].buckets, [10, 4, 1, 0]);
  assert.equal(parsed.value.scope.read, 1);
  assert.equal(parsed.value.days.length, 1);
  assert.deepEqual(parsed.value.days[0].b, [10, 4, 1, 0]);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('nothing is served without the platform fence being consulted', async () => {
  let consulted = 0;
  const routes = [];
  const ctx = {
    effect: (fn) => { const dispose = fn(); return dispose; },
    get: () => undefined,
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    connection: { requestRejection: () => { consulted += 1; return 401; } },
  };
  apply(ctx, {});
  const res = fakeResponse();
  await routes[0].handler(fakeRequest({}), res);
  assert.equal(consulted, 1, 'every request must pass through requestRejection');
  assert.equal(res.statusCode, 401);
});
