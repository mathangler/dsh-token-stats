/**
 * dsh-token-stats — host half.
 *
 * A Cordis plugin row (`name: 'dsh-token-stats'`) that publishes one JSON route
 * on the composition's `webServer` and dispatches it onto the method map from
 * `host-core.js`. The plugin is self-contained: no profile patch, no code
 * generation, no lifecycle script.
 *
 * Why it registers its own route instead of using `connection.rpc.handle(...)`:
 * that helper registers the channel through `owner.webServer`, where `owner` is
 * the Connection service's context. In cordis 4.x a service context is a shadow
 * whose service lookups resolve in the PROVIDER's fiber chain, so `webServer`
 * would have to be injected by the *connection* row rather than by this one.
 * Registering directly on our own `webServer` avoids that, and is the pattern
 * the shipped `@deepseek-ai/dsh-host-open-in-app` host plugin uses.
 *
 * Security is not hand-rolled: every request goes through the composition's
 * `connection.requestRejection(req)` first, which applies the platform's
 * Host/Origin fence and its browser login-token check. Only then is a body read
 * or a handler reached.
 *
 * @module dsh-token-stats
 */
import { createHandlers, StatsError } from './host-core.js';

/** Cordis plugin name reported to the loader. */
const name = 'token-stats';

/**
 * `webServer` carries the route; `connection` is the trust fence. The session
 * and model services are read optionally through `ctx.get(...)` by host-core,
 * so a composition without them degrades to a visible error instead of a boot
 * failure.
 */
const inject = ['webServer', 'connection'];

/** Absolute route prefix owned by this plugin; must match the client half. */
const CHANNEL = '/token-stats';

/** Panel requests are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;

/** One endpoint segment: the names host-core exports, and nothing else. */
const ENDPOINT_RE = /^[A-Za-z0-9_$.-]+$/;

/**
 * Delay before the one-off warm-up scan.
 *
 * The scan reads every session log, so it must not compete with the first
 * paint or with boot. There is deliberately no interval: one warm-up per
 * process, then everything is driven by the panel and its refresh button.
 */
const WARMUP_MS = 10000;

/** Success envelope; the client half unwraps `value`. */
const ok = (value) => ({ ok: true, value });

/** Failure envelope; the client half surfaces `error.message`. */
const fail = (code, message, details) => ({ ok: false, error: { code, message, details: details === undefined ? {} : details } });

/** JSON response. `no-store`: every answer is a live fact about this machine. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Run one endpoint and answer it with the platform's envelope convention.
 * @param handlers - the host-core method map.
 * @param endpoint - validated endpoint name.
 * @param req - incoming request.
 * @param res - outgoing response.
 */
async function dispatch(handlers, endpoint, req, res) {
  const fn = Object.prototype.hasOwnProperty.call(handlers, endpoint) ? handlers[endpoint] : undefined;
  if (typeof fn !== 'function') {
    sendJson(res, 404, fail('token-stats/unknown-endpoint', 'unknown endpoint ' + JSON.stringify(endpoint)));
    return;
  }
  const raw = await readBoundedBody(req);
  if (raw === null) {
    sendJson(res, 413, fail('token-stats/too-large', 'request body exceeds ' + MAX_BODY_BYTES + ' bytes'));
    return;
  }
  let payload = {};
  if (raw.trim() !== '') {
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      sendJson(res, 400, fail('token-stats/bad-request', 'body is not valid JSON'));
      return;
    }
  }
  try {
    const args = payload !== null && typeof payload === 'object' ? payload : {};
    sendJson(res, 200, ok(await fn(args)));
  } catch (error) {
    // Business failures are answered as HTTP 200 with a failure envelope, the
    // convention the platform's own channels use, so the panel can show the
    // reason instead of a generic transport fault.
    const code = error instanceof StatsError ? error.code : 'token-stats/internal';
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 200, fail(code, message));
  }
}

/**
 * Host plugin body: publish the route and schedule one warm-up scan.
 * @param ctx - Host Cordis context.
 * @param config - optional row config, forwarded to the core as its options.
 */
function apply(ctx, config) {
  const handlers = createHandlers(ctx, config === undefined || config === null ? {} : config);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: async (req, res) => {
          // The platform's fence, first: an untrusted or unauthenticated caller
          // never reaches a handler or a body read.
          const rejection = ctx.connection.requestRejection(req);
          if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
          }
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end();
            return;
          }
          const mediaType = String(req.headers['content-type'] || '')
            .split(';', 1)[0]
            .trim()
            .toLowerCase();
          if (mediaType !== 'application/json') {
            sendJson(res, 415, fail('token-stats/bad-request', 'content type must be application/json'));
            return;
          }
          const pathname = new URL(String(req.url), 'http://localhost').pathname;
          const endpoint = pathname.slice(CHANNEL.length).replace(/^\//, '');
          if (!ENDPOINT_RE.test(endpoint)) {
            sendJson(res, 404, fail('token-stats/unknown-endpoint', 'malformed endpoint'));
            return;
          }
          await dispatch(handlers, endpoint, req, res);
        },
      }),
    `dsh-token-stats: ${CHANNEL} route`,
  );

  // One warm-up per process, well clear of the first paint, so the panel's
  // first open answers from a warm rollup. Failures are silent by design:
  // a composition without sessionQuery should not log noise at boot.
  const timer = setTimeout(() => {
    Promise.resolve(handlers.summary({})).catch(() => {});
  }, WARMUP_MS);
  if (typeof timer.unref === 'function') timer.unref();
  ctx.effect(() => () => clearTimeout(timer), 'dsh-token-stats: warm-up scan');
}

export { apply, inject, name, CHANNEL };
