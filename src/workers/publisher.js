#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The outbox publisher, as its own process.
//
//   npm run worker:publisher
//
// A SEPARATE PROCESS, NOT A TIMER INSIDE THE API, and the reason is scaling in opposite
// directions. The API scales with request traffic; the publisher's work is proportional to the
// WRITE rate and is single-writer by design (see src/events/publisher.js on ordering). Running it
// in-process would mean every API replica polls the same table, which is both wasted work and the
// reordering hazard the lock exists to avoid — and it would tie the publisher's lifecycle to a
// deployment that restarts whenever a route changes.
//
// REPLICAS: 1 in Kubernetes, with the Redis lock as a belt-and-braces guard during a rolling
// deploy, when two pods briefly overlap.
// ---------------------------------------------------------------------------
import 'dotenv/config';
import config from '#config/env.js';
import logger from '#config/logger.js';
import { closeDatabase, pingDatabase, prewarmPool } from '#config/database.js';
import { connectRedis, closeRedis } from '#redis/client.js';
import { withLock } from '#redis/lock.js';
import { getProducer, closeKafka, kafkaEnabled } from '#events/kafka.js';
import { startPublisher, publisherStats } from '#events/publisher.js';
import { outboxStats } from '#events/outbox.service.js';
import { startWorkerHttp, installWorkerShutdown } from '#workers/worker-http.js';
import '#metrics/outbox-collectors.js';

const PORT = Number(process.env.PUBLISHER_PORT || 3100);

if (!kafkaEnabled()) {
  // Explicit and fatal. A publisher with no broker is a process that polls a table forever and
  // publishes nothing, which looks healthy on every dashboard.
  logger.error('KAFKA_BROKERS is not set — the publisher has nothing to publish to. Exiting.');
  process.exit(1);
}

// Half the pool, like the API: the publisher holds a connection for the length of each publishing
// transaction, so a cold pool would add connection setup to the first batch after every deploy.
await prewarmPool();

if (config.redis.url) {
  await connectRedis().catch((e) =>
    // Not fatal. Without the lock, ordering relies on there being one publisher replica — which
    // there is — and `FOR UPDATE SKIP LOCKED` still prevents double-claiming either way.
    logger.warn('Redis unavailable — running without the publisher lock', { error: e.message })
  );
}

const producer = await getProducer();

const lock = config.redis.url ? (fn) => withLock('outbox-publisher', fn, { ttlMs: 30_000 }) : null;

const publisher = startPublisher({ producer, lock });

const http = startWorkerHttp({
  port: PORT,
  name: 'publisher',
  readiness: async () => {
    // Readiness for a publisher means "can I do my job": the database is the queue, so it is the
    // gate. Kafka is deliberately NOT — if the broker is down the correct behaviour is to keep
    // running, accumulate backlog and drain when it returns, which is exactly what the drill
    // demonstrates. Failing readiness would only hide the backlog.
    const db = await pingDatabase();
    const stats = await outboxStats();
    return {
      ready: db.ok,
      db,
      outbox: stats,
      publisher: { published: publisherStats.published, failed: publisherStats.failed },
    };
  },
});

installWorkerShutdown({
  name: 'publisher',
  http,
  // Stop polling first, so no new batch is claimed while shutting down.
  stop: async () => publisher.stop(),
  release: async () => {
    await closeKafka();
    await closeRedis();
    await closeDatabase();
  },
});

logger.info('Publisher started', {
  topic: config.kafka.topic,
  pollIntervalMs: config.kafka.pollIntervalMs,
  batchSize: config.kafka.batchSize,
  lock: Boolean(lock),
});
