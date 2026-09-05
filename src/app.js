import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import logger from '#config/logger.js';
import config from '#config/env.js';
import { pingDatabase, poolStats } from '#config/database.js';
import authRoutes from '#routes/auth.routes.js';
import usersRoutes from '#routes/users.routes.js';
import { requestId } from '#middleware/request-id.middleware.js';
import { requestLogger } from '#middleware/request-log.middleware.js';
import { errorHandler, notFoundHandler } from '#middleware/error.middleware.js';

const app = express();

// ---------------------------------------------------------------------------
// Proxy trust, OFF by default and deliberately so.
//
// With `trust proxy` enabled, Express takes `req.ip` from X-Forwarded-For. If
// nothing trustworthy is actually in front of the process, any client can set
// that header and mint itself an unlimited supply of rate-limit buckets — the
// limiter becomes decorative while still looking present, which is worse than not
// having one. Phase 7 sets TRUST_PROXY once there is a known ingress.
// ---------------------------------------------------------------------------
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY);
  logger.info('Express trust proxy enabled', { value: process.env.TRUST_PROXY });
}

// Do not advertise the framework. Cheap, and it removes a version string that
// tells an attacker which CVE list to consult.
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// FIRST, ahead of everything, and that ordering was a bug once (finding F-31).
//
// The correlation id was originally mounted after `express.json()`. A malformed
// request body makes the body parser throw before that point, so `req.id` was
// undefined and the 400 went out with no id — `JSON.stringify` silently drops the
// undefined field, so the response simply had no `requestId` at all. That is
// exactly the case where a client most needs one: it sent something the server
// rejected and will ask which request.
//
// `requestId` depends on nothing, so it goes first and every response — including
// one produced by a parser failure — carries an id.
// ---------------------------------------------------------------------------
app.use(requestId);

app.use(helmet());

// ---------------------------------------------------------------------------
// CORS, actually driven by CORS_ORIGIN.
//
// v0 called `cors()` with no options while documenting CORS_ORIGIN in three env
// templates, so the effective policy was `Access-Control-Allow-Origin: *` and the
// documented variable was read by nothing. A security setting that appears
// configured and is not is worse than an absent one.
// ---------------------------------------------------------------------------
if (config.cors.origins) {
  app.use(cors({ origin: config.cors.origins, credentials: config.cors.credentials }));
} else {
  app.use(cors());
  if (config.isProduction) {
    logger.warn(
      'CORS_ORIGIN is unset, so Access-Control-Allow-Origin is "*". Set it to an ' +
        'explicit origin list in production.'
    );
  }
}
// A body limit, which v0 omitted. express.json defaults to 100kb, so this is
// mostly explicitness — but an unset limit is one dependency-default change away
// from an unbounded allocation per request, and 413 is handled properly by the
// error middleware.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());
// ---------------------------------------------------------------------------
// Request logging replaces morgan.
//
// v0: app.use(morgan('combined', {stream:{write: m => logger.info(m.trim())}}))
//
// That logged every request twice — once as morgan's Apache-combined string
// wrapped in a JSON `message` field, once from whatever the controller emitted —
// and the morgan half was unqueryable. "Structured logging" that a log processor
// cannot filter by status or duration is a string, not a structure.
// ---------------------------------------------------------------------------
app.use(requestLogger);

// ---------------------------------------------------------------------------
// NO app-level security middleware, which is the substantive change from v0.
//
// v0 mounted Arcjet here, ahead of every route, so a liveness probe paid a full
// bot-detection and rate-limit check: measured at 404.69 ms p95 on `/health`, an
// endpoint that does no I/O, against 4.19 ms with the middleware bypassed
// (findings F-07, F-16). Rate limiting now lives on the routers that need it —
// src/routes/auth.routes.js and src/routes/users.routes.js — for two reasons:
// probes must not be throttled, and the authenticated limiter has to run AFTER
// `authenticate` or `req.user` is undefined and every per-role limit collapses to
// the guest bucket, which is precisely what happened in v0.
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.status(200).send('Hello from Acquisitions...');
});

// LIVENESS. "Is this process able to serve?" Answers from in-process state only,
// with no dependency check. A liveness probe that fails when the database is down
// gets the container killed and restarted, which does nothing for a database
// outage except remove capacity — the classic way a dependency blip becomes a
// full outage.
app.get('/health', (req, res) => {
  res.status(app.locals.shuttingDown ? 503 : 200).json({
    status: app.locals.shuttingDown ? 'SHUTTING_DOWN' : 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// READINESS. "Should traffic be routed here?" Checks the dependency, and flips to
// 503 the moment SIGTERM arrives so the load balancer stops sending work before
// the listener closes. That gap is the difference between a rolling deploy that
// drops requests and one that does not — see src/server.js.
app.get('/ready', async (req, res) => {
  if (app.locals.shuttingDown) {
    return res.status(503).json({ status: 'SHUTTING_DOWN', ready: false });
  }
  try {
    const db = await pingDatabase();
    return res.status(200).json({ status: 'READY', ready: true, db, pool: poolStats() });
  } catch (e) {
    logger.error('Readiness check failed', { requestId: req.id, error: e.message });
    return res.status(503).json({ status: 'NOT_READY', ready: false, reason: 'database' });
  }
});

app.get('/api', (req, res) => {
  res.status(200).json({ message: 'Acquisitions API is running!' });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);

// Order matters and is load-bearing. The 404 handler must come after every route,
// and the error handler must come last of all — Express selects error middleware
// by its four-argument signature and by registration order, so an error handler
// mounted before a router never sees that router's errors.
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
