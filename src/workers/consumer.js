#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The event consumer, as its own process.
//
//   npm run worker:consumer
//
// SCALING: replicas up to the partition count of the topic, and not beyond. Kafka assigns each
// partition to exactly one consumer in a group, so a fourth replica against three partitions is an
// idle process — which is worth knowing before someone sets `replicas: 10` and concludes the
// pipeline does not scale. k8s/consumer-deployment.yaml says the same thing next to the replica
// count.
// ---------------------------------------------------------------------------
import 'dotenv/config';
import config from '#config/env.js';
import logger from '#config/logger.js';
import { closeDatabase, pingDatabase, prewarmPool } from '#config/database.js';
import { createConsumer, getProducer, closeKafka, kafkaEnabled } from '#events/kafka.js';
import { startConsumer, consumerStats } from '#events/consumer.js';
import { startWorkerHttp, installWorkerShutdown } from '#workers/worker-http.js';
import '#metrics/outbox-collectors.js';

const PORT = Number(process.env.CONSUMER_PORT || 3200);

if (!kafkaEnabled()) {
  logger.error('KAFKA_BROKERS is not set — there is nothing to consume. Exiting.');
  process.exit(1);
}

await prewarmPool();

const consumer = await createConsumer();
// A producer as well as a consumer, because the DLQ is a topic: an event that cannot be handled has
// to be produced somewhere, and a consumer that can only consume has no way to park a poison
// message except to keep failing on it.
const producer = await getProducer();

const running = await startConsumer({ consumer, producer });

const http = startWorkerHttp({
  port: PORT,
  name: 'consumer',
  readiness: async () => {
    const db = await pingDatabase();
    return {
      ready: db.ok,
      db,
      consumer: {
        handled: consumerStats.handled,
        duplicates: consumerStats.duplicates,
        deadLettered: consumerStats.deadLettered,
        retries: consumerStats.retries,
      },
    };
  },
});

installWorkerShutdown({
  name: 'consumer',
  http,
  // `disconnect()` leaves the group cleanly, which triggers one rebalance now instead of waiting
  // for the session timeout to expire and stalling the partitions for 30 seconds.
  stop: async () => running.stop(),
  release: async () => {
    await closeKafka();
    await closeDatabase();
  },
});

logger.info('Consumer started', {
  groupId: config.kafka.consumerGroup,
  topic: config.kafka.topic,
  dlqTopic: config.kafka.dlqTopic,
  maxHandlerAttempts: config.kafka.maxHandlerAttempts,
});
