// ---------------------------------------------------------------------------
// Process lifecycle: listen, and shut down without dropping work.
//
// v0 src/server.js was seven lines — `app.listen` and a `console.log`. No signal
// handling at all, verified: `grep -rn "SIGTERM\|SIGINT\|server.close" src/`
// returned nothing.
//
// That matters more than it sounds. Kubernetes rolling deploys send SIGTERM, and
// Node's default action is to exit immediately, so every in-flight request is
// severed mid-response — the client sees a connection reset, not a 500 it can
// interpret. At the Phase 0 knee (~2.4 iterations/s as-built, p95 6.4 s) a deploy
// could cut a request that had been running for several seconds. Any claim about
// 3 replicas in Phase 7 is unsupportable without this, because "I ran three
// containers" and "I ran three containers and deploys don't drop requests" are
// different claims and only the second one is interesting.
//
// THE ORDER BELOW IS THE WHOLE POINT.
//
//   1. mark not-ready         -> /ready returns 503 immediately
//   2. wait readinessDelayMs  -> give the load balancer time to notice
//   3. server.close()         -> stop accepting NEW connections, keep serving
//                                the ones already in flight
//   4. wait for drain         -> up to drainTimeoutMs
//   5. close the pool and the rate-limit sweeper
//   6. exit
//
// Step 2 is the one that gets skipped. Closing the listener the instant SIGTERM
// lands still loses requests, because the load balancer has not yet been told to
// stop routing and will keep sending them to a closing socket. Failing readiness
// first and then pausing is what makes the drain actually drain.
// ---------------------------------------------------------------------------
import app from '#src/app.js';
import config from '#config/env.js';
import logger from '#config/logger.js';
import { closeDatabase } from '#config/database.js';
import { closeRateLimiter } from '#middleware/rate-limit.middleware.js';

app.locals.shuttingDown = false;

const server = app.listen(config.port, () => {
  logger.info('Server listening', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    sessionTtlMs: config.session.ttlMs,
    poolMax: config.pool.max,
  });
});

// Explicit, and slightly longer than a typical load-balancer idle timeout. If the
// server closes a keep-alive connection at the same moment the balancer reuses it,
// the result is an unexplained 502 — one of the more common and least obvious
// causes of intermittent errors behind a proxy.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

/** Track open sockets so shutdown can report what it is waiting on, and can
 *  eventually destroy anything that refuses to finish. */
const sockets = new Set();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    logger.warn('Second shutdown signal ignored; drain already in progress', { signal });
    return;
  }
  shuttingDown = true;

  // Step 1: fail readiness. Instant, and the only step a load balancer can
  // actually observe.
  app.locals.shuttingDown = true;
  logger.info('Shutdown initiated — readiness now failing', {
    signal,
    openSockets: sockets.size,
  });

  // Step 2: let the probe notice before the door closes.
  if (config.shutdown.readinessDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.shutdown.readinessDelayMs));
  }

  // Steps 3 and 4: stop accepting, drain what is in flight.
  const drained = new Promise((resolve) => server.close(() => resolve('drained')));
  const timedOut = new Promise((resolve) =>
    setTimeout(() => resolve('timeout'), config.shutdown.drainTimeoutMs)
  );
  const outcome = await Promise.race([drained, timedOut]);

  if (outcome === 'timeout') {
    // Deliberately destructive, and logged as such. A request still running after
    // the drain window is either wedged or long-polling, and holding the process
    // open past the orchestrator's grace period means SIGKILL arrives instead —
    // which skips step 5 entirely and can leave Postgres holding connections.
    logger.warn('Drain timed out — destroying remaining sockets', {
      drainTimeoutMs: config.shutdown.drainTimeoutMs,
      remaining: sockets.size,
    });
    for (const socket of sockets) socket.destroy();
  } else {
    logger.info('All in-flight requests completed');
  }

  // Step 5: release resources. Nothing can start new work by this point.
  closeRateLimiter();
  try {
    const result = await closeDatabase();
    logger.info('Database connections released', result);
  } catch (e) {
    logger.error('Error closing database pool', { error: e.message });
  }

  logger.info('Shutdown complete', { signal });

  // Give winston's file transports a tick to flush. Without it the last few lines
  // — including this one — can be lost, which makes a clean shutdown
  // indistinguishable from a crash when you read the log afterwards.
  setTimeout(() => process.exit(0), 50);
}

// SIGTERM from orchestrators, SIGINT from Ctrl-C, same path — so the drain logic
// runs every time you stop the dev server rather than only during a deploy, which
// is the difference between shutdown code that works and shutdown code that has
// never been executed.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Last resort. Both are genuinely fatal: after an uncaught exception the process
// state is undefined, so the correct move is to log with full fidelity — which
// required the logger fix, since with the v0 comma-expression bug this line
// recorded no stack and no timestamp — and then leave through the same drain path
// rather than dying mid-request.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down', { message: err.message, stack: err.stack });
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection — shutting down', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  void shutdown('unhandledRejection');
});

export { server, shutdown };
export default server;
