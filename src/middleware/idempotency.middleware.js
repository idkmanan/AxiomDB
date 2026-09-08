// ---------------------------------------------------------------------------
// Idempotency keys for unsafe writes.
//
// THE PROBLEM THIS SOLVES IS NOT THEORETICAL. A client sends `POST /api/deals`, the response
// is lost — a dropped connection, a proxy timeout, a rolling deploy severing the socket (which
// is precisely what happened to the 752 abandoned requests in finding F-34) — and the client
// retries. Without a way to recognise the retry, the server creates a second deal. The client
// cannot tell the difference between "my request was lost" and "my response was lost", and only
// the server can.
//
// THE CONTRACT:
//   Idempotency-Key: <opaque string>   on an unsafe request
//   → first time:  the request runs, the 2xx response is stored, and it is returned
//   → retried:     the SAME response is replayed, with `Idempotent-Replay: true`
//   → in flight:   409, because the original is still running and its answer is not known yet
//   → same key, different body: 422 — the key identifies one operation, and reusing it for
//     another is a client bug that would otherwise silently return the wrong resource
//
// THE KEY IS SCOPED to user + method + path + the client's value. Two users may use the same
// key; the same key on a different endpoint is a different operation. A global namespace would
// let one caller's key collide with another's and replay someone else's response.
//
// WHY THE CLAIM IS `SET NX`. Two concurrent retries must not both execute. `SET key … NX` is
// atomic — exactly one caller creates it — so the winner proceeds and the loser gets a 409.
// GET-then-SET would let both through, which is the same check-then-act mistake as F-41 in a
// different store.
//
// FAIL OPEN, and the trade is worth stating: if Redis is unreachable the request proceeds
// WITHOUT deduplication, so a retry during an outage can create a duplicate. The alternative —
// refusing writes while the dedupe cache is down — converts a Redis blip into a write outage.
// For a pipeline record that is the right way round. For money it would not be: a payments
// endpoint should fail closed here, and that is a one-line change to `onStoreFailure` below.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import logger from '#config/logger.js';
import config from '#config/env.js';
import { getRedis, redisKey } from '#redis/client.js';

export const idempotencyStats = { replayed: 0, conflicts: 0, mismatches: 0, failures: 0 };

const sha = (value) => createHash('sha256').update(value).digest('hex');

/**
 * @param {object} [opts]
 * @param {'open'|'closed'} [opts.onStoreFailure] what to do when Redis is unreachable
 */
export function idempotency({ onStoreFailure = 'open' } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const presented = req.get('Idempotency-Key');
    // Optional by design. Requiring it would break every existing client and, for a create
    // endpoint, a caller that does not care about retry safety is allowed not to.
    if (!presented || !config.redis.url) return next();

    if (presented.length > 200) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Idempotency-Key must be at most 200 characters',
      });
    }

    const scope = `${req.user?.id ?? 'anon'}:${req.method}:${req.baseUrl}${req.path}:${presented}`;
    const key = redisKey('idem', sha(scope));
    const fingerprint = sha(JSON.stringify(req.body ?? null));

    let client;
    try {
      client = getRedis();
      const claimed = await client.set(
        key,
        JSON.stringify({ state: 'in-flight', fingerprint, startedAt: Date.now() }),
        'PX',
        config.idempotency.ttlMs,
        'NX'
      );

      if (claimed !== 'OK') {
        const existing = await client.get(key);
        const record = existing ? safeParse(existing) : null;

        if (record?.fingerprint && record.fingerprint !== fingerprint) {
          idempotencyStats.mismatches += 1;
          logger.warn('Idempotency key reused with a different body', {
            requestId: req.id,
            userId: req.user?.id,
          });
          return res.status(422).json({
            error: 'Unprocessable Entity',
            message: 'This Idempotency-Key was already used with a different request body',
            requestId: req.id,
          });
        }

        if (record?.state === 'done') {
          idempotencyStats.replayed += 1;
          logger.info('Replaying idempotent response', {
            requestId: req.id,
            status: record.status,
          });
          // The header is what lets a client tell a replay from a fresh execution — and what
          // makes this testable from the outside.
          res.set('Idempotent-Replay', 'true');
          return res.status(record.status).json(record.body);
        }

        // Still running. 409 with Retry-After rather than blocking: holding this request open
        // while the first one finishes ties up a connection and the client's own timeout is
        // usually shorter than the wait.
        idempotencyStats.conflicts += 1;
        res.set('Retry-After', '1');
        return res.status(409).json({
          error: 'Conflict',
          message: 'A request with this Idempotency-Key is already in progress',
          requestId: req.id,
        });
      }
    } catch (e) {
      idempotencyStats.failures += 1;
      const failClosed = onStoreFailure === 'closed';
      logger.error(`Idempotency store unavailable — failing ${failClosed ? 'CLOSED' : 'OPEN'}`, {
        requestId: req.id,
        error: e.message,
      });
      if (failClosed) {
        return res.status(503).json({
          error: 'Service Unavailable',
          message: 'Cannot guarantee idempotency right now; the request was not attempted.',
        });
      }
      return next();
    }

    // We own the claim. Capture the response so a retry can be answered with it.
    captureResponse(req, res, { client, key, fingerprint });
    return next();
  };
}

/**
 * Record the outcome by wrapping `res.json`.
 *
 * Only 2xx is stored. A 500 must NOT be replayed — the client is supposed to be able to retry a
 * failure, and caching it would make a transient error permanent for 24 hours. A 4xx is not
 * stored either: it is deterministic from the request, so re-running produces the same answer
 * anyway, and the claim is released so a corrected retry with a new body is not met with a 422
 * about a body that never succeeded.
 */
function captureResponse(req, res, { client, key, fingerprint }) {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const status = res.statusCode;
    const finish =
      status >= 200 && status < 300
        ? client.set(
            key,
            JSON.stringify({ state: 'done', fingerprint, status, body, completedAt: Date.now() }),
            'PX',
            config.idempotency.ttlMs
          )
        : client.del(key);

    // Fire and forget, with the failure logged. Awaiting it would add a Redis round trip to the
    // latency of every write, and the consequence of losing it is a duplicate on retry rather
    // than a wrong answer.
    Promise.resolve(finish).catch((e) =>
      logger.error('Failed to record idempotent response', {
        requestId: req.id,
        error: e.message,
      })
    );

    return originalJson(body);
  };
}

const safeParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export default idempotency;
