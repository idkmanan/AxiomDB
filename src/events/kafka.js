// ---------------------------------------------------------------------------
// The Kafka client, behind a factory.
//
// `kafkajs` is imported dynamically for the same reason as `ioredis` (see src/redis/client.js):
// the offline unit suite has to be able to import every module that touches this one without the
// driver installed, and every consumer of this file takes an INJECTED producer or consumer so
// tests never construct a real client.
//
// PRODUCER SETTINGS, and each is a decision:
//
//   idempotent: true      The broker assigns each producer a session id and sequence numbers, so
//                         a retry of an in-flight batch is recognised and discarded instead of
//                         appended twice. Without it, a network timeout on an ack produces a
//                         duplicate that no application-level id can prevent — the send DID
//                         happen. kafkajs enforces acks=-1 and maxInFlightRequests=1 when this
//                         is set, which also preserves per-partition order across retries.
//
//   acks: all (implied)   The leader waits for every in-sync replica. Worth being honest about
//                         the limit of this in the committed compose stack: a single-node KRaft
//                         broker has one replica, so "all" is one. The setting is right; the
//                         durability it buys is a property of the cluster, and k8s/kafka.yaml
//                         says so too.
//
//   retry                 Bounded. An unbounded producer retry inside a publishing transaction
//                         would hold a Postgres transaction open indefinitely — the outbox is
//                         already the retry mechanism, so failing fast here and letting
//                         `available_at` schedule the next attempt is both simpler and safer.
// ---------------------------------------------------------------------------
import config from '#config/env.js';
import logger from '#config/logger.js';

let kafka = null;
let producer = null;

export const kafkaEnabled = () => config.kafka.brokers.length > 0;

async function loadDriver() {
  try {
    const mod = await import('kafkajs');
    return mod.Kafka ?? mod.default?.Kafka;
  } catch (e) {
    throw new Error(
      'The "kafkajs" package is not installed, but KAFKA_BROKERS is set. Run `npm install`, ' +
        'or unset KAFKA_BROKERS to run without a broker (events still accumulate in the outbox).',
      { cause: e }
    );
  }
}

export async function getKafka() {
  if (kafka) return kafka;
  if (!kafkaEnabled()) throw new Error('KAFKA_BROKERS is not set, so no Kafka client was created.');

  const Kafka = await loadDriver();
  kafka = new Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
    // Bounded, and short. See the header: the outbox is the durable retry, so this only needs to
    // absorb a leader election.
    retry: { retries: 3, initialRetryTime: 100, maxRetryTime: 2000 },
    logLevel: 1, // ERROR — kafkajs is chatty at INFO and its output is not structured like ours
  });
  return kafka;
}

/** The shared idempotent producer. */
export async function getProducer() {
  if (producer) return producer;
  const client = await getKafka();
  producer = client.producer({ idempotent: true, allowAutoTopicCreation: false });
  await producer.connect();
  logger.info('Kafka producer connected', {
    brokers: config.kafka.brokers,
    topic: config.kafka.topic,
  });
  return producer;
}

/**
 * A consumer for a group.
 *
 * `allowAutoTopicCreation: false` on purpose. Auto-creation gives a topic the broker's default
 * partition count and replication factor, which is how a production topic ends up with one
 * partition and no redundancy because a typo in a topic name created it. Topics are created
 * explicitly by scripts/events/topics.mjs.
 */
export async function createConsumer({ groupId = config.kafka.consumerGroup } = {}) {
  const client = await getKafka();
  return client.consumer({
    groupId,
    allowAutoTopicCreation: false,
    // A short session timeout detects a dead consumer quickly; too short and a GC pause triggers
    // a rebalance. 30s/3s is kafkajs' default pairing and there is no reason here to disagree.
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });
}

export async function closeKafka() {
  const closed = [];
  if (producer) {
    await producer
      .disconnect()
      .catch((e) => logger.warn('Producer disconnect failed', { error: e.message }));
    producer = null;
    closed.push('producer');
  }
  kafka = null;
  return { closed };
}

/** Inject a producer — tests and the drill script use this. */
export function setProducer(injected) {
  producer = injected;
  return producer;
}

export default { getKafka, getProducer, createConsumer, closeKafka, kafkaEnabled };
