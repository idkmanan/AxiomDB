#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Topic creation, done explicitly.
//
//   node scripts/events/topics.mjs
//   node scripts/events/topics.mjs --partitions 6 --replication 1
//
// WHY NOT AUTO-CREATION. `allowAutoTopicCreation` is off in src/events/kafka.js, so a producer or
// consumer that names a topic which does not exist fails instead of silently making one. Auto-created
// topics take the broker's defaults — usually one partition and replication factor 1 — which means a
// typo in a topic name creates a topic that works in development and is a single point of failure in
// production. Worse, the partition count is effectively permanent: raising it later re-hashes keys, so
// events for one aggregate stop landing in the partition that holds their history and ORDERING BREAKS
// for existing keys.
//
// PARTITIONS: 3 by default, which is the consumer-parallelism ceiling — Kafka gives each partition to
// exactly one consumer in a group, so three partitions means at most three useful consumer replicas.
//
// REPLICATION: 1 by default because the committed compose stack runs a single-node KRaft broker. That
// is stated rather than hidden: with one replica, `acks: all` acknowledges one copy, and a broker loss
// is data loss. Any real deployment sets --replication 3 and min.insync.replicas=2.
// ---------------------------------------------------------------------------
import config from '#config/env.js';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PARTITIONS = Number(getArg('partitions', 3));
const REPLICATION = Number(getArg('replication', 1));

const say = (line) => process.stdout.write(`${line}\n`);

async function main() {
  if (config.kafka.brokers.length === 0) {
    say('KAFKA_BROKERS is not set. Set it and re-run, e.g.');
    say('  KAFKA_BROKERS=localhost:9092 node scripts/events/topics.mjs');
    process.exit(1);
  }

  const { default: Kafka } = await import('kafkajs').then((m) => ({ default: m.Kafka }));
  const admin = new Kafka({
    clientId: 'acquisitions-admin',
    brokers: config.kafka.brokers,
  }).admin();
  await admin.connect();

  try {
    const existing = await admin.listTopics();
    const wanted = [
      {
        topic: config.kafka.topic,
        numPartitions: PARTITIONS,
        replicationFactor: REPLICATION,
        configEntries: [
          // A week. Long enough to replay a bad deploy, short enough that the disk is bounded.
          { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
          // Delete, not compact: these are events, not a keyed snapshot of current state. Compaction
          // would silently discard all but the newest event per key, which for `deal:100` means
          // losing the creation and keeping only the latest stage change.
          { name: 'cleanup.policy', value: 'delete' },
        ],
      },
      {
        topic: config.kafka.dlqTopic,
        // One partition: the DLQ is read by a human or a replay tool, and ordering across the whole
        // topic is more useful there than parallelism.
        numPartitions: 1,
        replicationFactor: REPLICATION,
        configEntries: [
          // Thirty days. A dead-lettered event is evidence; it should outlive the incident that
          // produced it and the week it takes somebody to notice.
          { name: 'retention.ms', value: String(30 * 24 * 60 * 60 * 1000) },
        ],
      },
    ];

    const missing = wanted.filter((t) => !existing.includes(t.topic));
    if (missing.length === 0) {
      say(`both topics already exist: ${wanted.map((t) => t.topic).join(', ')}`);
    } else {
      await admin.createTopics({ topics: missing, waitForLeaders: true });
      say(`created: ${missing.map((t) => `${t.topic} (${t.numPartitions}p)`).join(', ')}`);
    }

    const meta = await admin.fetchTopicMetadata({ topics: wanted.map((t) => t.topic) });
    for (const t of meta.topics) {
      say(
        `  ${t.name}: ${t.partitions.length} partition(s), leaders ${t.partitions.map((p) => p.leader).join(',')}`
      );
    }
    if (REPLICATION === 1) {
      say('');
      say(
        'NOTE: replication factor 1 — `acks: all` acknowledges a single copy, so losing the broker'
      );
      say('loses unpublished data. Use --replication 3 against a real cluster.');
    }
  } finally {
    await admin.disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`[topics] FAILED: ${e.message}\n`);
  process.exit(1);
});
