import express from 'express';
import config from '#config/env.js';
import { pingRedis, redisStatus } from '#redis/client.js';

const router = express.Router();

/**
 * Redis diagnostic endpoint - helps debug production connectivity issues.
 *
 * This endpoint provides detailed information about:
 * - Redis configuration (sanitized URL)
 * - Current connection state
 * - Actual connection test results
 * - Environment variable presence
 *
 * IMPORTANT: Remove or protect this endpoint before going to production.
 * It exposes configuration details that could be useful to an attacker.
 */
router.get('/redis', async (req, res) => {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    configuration: {
      redisUrlConfigured: Boolean(config.redis.url),
      redisUrlLength: config.redis.url?.length || 0,
      // Show sanitized URL - hide password but show host/port for debugging
      redisUrlPattern: config.redis.url
        ? config.redis.url.replace(/:([^@]+)@/, ':***@')
        : null,
      rateLimitStore: config.rateLimitStore,
      keyPrefix: config.redis.keyPrefix,
      connectTimeoutMs: config.redis.connectTimeoutMs,
      commandTimeoutMs: config.redis.commandTimeoutMs,
    },
    envVars: {
      REDIS_URL_set: Boolean(process.env.REDIS_URL),
      REDIS_URL_length: process.env.REDIS_URL?.length || 0,
      RATE_LIMIT_STORE: process.env.RATE_LIMIT_STORE || 'not set',
      NODE_ENV: process.env.NODE_ENV,
    },
    currentStatus: redisStatus(),
    connectionTest: null,
    error: null,
  };

  // Try to ping Redis
  try {
    const pingResult = await pingRedis();
    diagnostics.connectionTest = {
      success: pingResult.ok,
      enabled: pingResult.enabled,
      checked: pingResult.checked,
      latencyMs: pingResult.latencyMs,
      rawResult: pingResult,
    };
  } catch (err) {
    diagnostics.error = {
      message: err.message,
      code: err.code,
      stack: config.exposeErrorDetails ? err.stack : undefined,
    };
  }

  // Try to manually connect if not already connected
  if (!diagnostics.currentStatus.connected && config.redis.url) {
    try {
      const { connectRedis } = await import('#redis/client.js');
      diagnostics.manualConnectionAttempt = {
        attempting: true,
        url: config.redis.url.replace(/:([^@]+)@/, ':***@'),
      };

      const client = await connectRedis();
      const pong = await client.ping();

      diagnostics.manualConnectionAttempt.success = true;
      diagnostics.manualConnectionAttempt.pong = pong;
      diagnostics.manualConnectionAttempt.clientStatus = client.status;
    } catch (err) {
      diagnostics.manualConnectionAttempt = {
        success: false,
        error: err.message,
        code: err.code,
        errno: err.errno,
        syscall: err.syscall,
        address: err.address,
        port: err.port,
      };
    }
  }

  // Check if ioredis is actually installed
  try {
    await import('ioredis');
    diagnostics.ioredisInstalled = true;
  } catch (e) {
    diagnostics.ioredisInstalled = false;
    diagnostics.ioredisError = e.message;
  }

  const statusCode = diagnostics.connectionTest?.success ? 200 : 503;
  res.status(statusCode).json(diagnostics);
});

/**
 * Quick health check for Redis - minimal response
 */
router.get('/redis/ping', async (req, res) => {
  try {
    const result = await pingRedis();
    if (result.ok) {
      res.json({ ok: true, latencyMs: result.latencyMs });
    } else {
      res.status(503).json({ ok: false, enabled: result.enabled });
    }
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

export default router;
