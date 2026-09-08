// ---------------------------------------------------------------------------
// A minimal HTTP surface for the background workers.
//
// WHY A WORKER NEEDS A PORT AT ALL. Kubernetes decides whether a pod is alive by probing it, and
// a process with no listener can only be probed with `exec`, which means shelling out on a
// schedule and inventing a health definition in bash. Twenty lines of `http` gives the same
// liveness/readiness semantics the API already has, plus the `/metrics` endpoint the outbox depth
// and consumer counters are exposed through — which for a worker is the ONLY way to see what it is
// doing, since nobody sends it requests.
//
// Deliberately `node:http` and not Express: a worker's HTTP surface is three routes that must never
// be a source of bugs, and the middleware stack that makes the API convenient (body parsing,
// cookies, CORS, rate limiting) is exactly what should not be in front of a probe.
// ---------------------------------------------------------------------------
import { createServer } from 'node:http';
import logger from '#config/logger.js';
import { registry } from '#metrics/collectors.js';

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.name for logs
 * @param {() => Promise<{ready: boolean, detail?: object}>} opts.readiness
 */
export function startWorkerHttp({ port, name, readiness }) {
  const state = { shuttingDown: false };

  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (req.url === '/health') {
      // Liveness: in-process state only, no dependency check. A worker that cannot reach Kafka is
      // not a worker that should be restarted — restarting it does nothing for Kafka and removes
      // the capacity that would drain the backlog when Kafka returns.
      return send(state.shuttingDown ? 503 : 200, {
        status: state.shuttingDown ? 'SHUTTING_DOWN' : 'OK',
        worker: name,
        uptime: process.uptime(),
      });
    }

    if (req.url === '/ready') {
      if (state.shuttingDown) return send(503, { status: 'SHUTTING_DOWN', ready: false });
      try {
        const result = await readiness();
        return send(result.ready ? 200 : 503, { worker: name, ...result });
      } catch (e) {
        return send(503, { worker: name, ready: false, error: e.message });
      }
    }

    if (req.url === '/metrics') {
      const expected = process.env.METRICS_TOKEN;
      if (expected) {
        const presented = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (presented !== expected) return send(401, { error: 'Unauthorized' });
      }
      return send(200, registry.render(), 'text/plain; version=0.0.4; charset=utf-8');
    }

    return send(404, { error: 'Not found' });
  });

  server.listen(port, () => logger.info(`${name} HTTP listening`, { port }));

  return {
    server,
    markShuttingDown() {
      state.shuttingDown = true;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * The shutdown sequence shared by both workers.
 *
 * Same shape as src/server.js and for the same reason: fail readiness first so the orchestrator
 * stops counting this pod as available, then stop taking new work, then release. A worker that
 * exits on SIGTERM without finishing its current unit of work leaves a partially handled event —
 * which the outbox and `processed_events` make recoverable, but recoverable is not free.
 */
export function installWorkerShutdown({ name, http, stop, release = async () => {} }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${name} shutting down`, { signal });

    http.markShuttingDown();
    try {
      await stop();
    } catch (e) {
      logger.error(`${name} failed to stop cleanly`, { error: e.message });
    }
    try {
      await release();
    } catch (e) {
      logger.error(`${name} failed to release resources`, { error: e.message });
    }
    await http.close();

    logger.info(`${name} shutdown complete`);
    setTimeout(() => process.exit(0), 50);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error(`${name} uncaught exception`, { message: err.message, stack: err.stack });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`${name} unhandled rejection`, {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    void shutdown('unhandledRejection');
  });

  return shutdown;
}
