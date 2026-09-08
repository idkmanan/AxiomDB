// ---------------------------------------------------------------------------
// The consumer: idempotent handling, bounded retries, and a real dead-letter topic.
//
// THREE THINGS HAVE TO BE TRUE FOR A CONSUMER TO BE SAFE, and each is one section below.
//
// 1. AT-LEAST-ONCE DELIVERY MUST NOT MEAN AT-LEAST-ONCE EFFECT. The publisher can resend (see
//    src/events/publisher.js) and Kafka can redeliver after a rebalance or an uncommitted offset.
//    So every event is claimed by inserting `(consumer_group, event_id)` into `processed_events`
//    with `ON CONFLICT DO NOTHING`, in the SAME transaction as the handler's writes. Zero rows
//    inserted means "already handled" and the handler is skipped. The claim and the effect commit
//    together or not at all.
//
// 2. A POISON MESSAGE MUST NOT BLOCK THE PARTITION. Kafka delivers a partition in order, so a
//    message that always throws will be retried forever and every message behind it waits — the
//    single most common way an event pipeline stops without anybody noticing that it stopped.
//    After `maxHandlerAttempts` the event is produced to the DLQ topic with its failure context
//    and the offset moves on.
//
// 3. THE OFFSET MUST BE COMMITTED ONLY AFTER THE WORK IS DURABLE. kafkajs' `eachMessage` commits
//    automatically after the callback resolves, so the transaction has to be inside it. Throwing
//    out of the callback is what prevents the commit and causes the retry.
// ---------------------------------------------------------------------------
import config from '#config/env.js';
import logger from '#config/logger.js';
import { db } from '#config/database.js';
import { withTransaction } from '#utils/tx.js';
import { processedEvents } from '#models/outbox.model.js';
import { handlers as defaultHandlers } from '#events/handlers.js';
import { causeChain } from '#utils/db-error.js';

/**
 * Every message in the chain, outermost first.
 *
 * Finding F-36 applied to a DLQ header: drizzle wraps a handler failure in a `DrizzleQueryError`
 * whose own message is "Failed query: …", so recording `error.message` alone parks the event with a
 * diagnosis that names the statement and not the problem. Whoever reads the DLQ needs the root
 * cause, and the chain is where it lives.
 */
const describeError = (err) =>
  [...causeChain(err)]
    .map((e) => e?.message)
    .filter(Boolean)
    .join(' <- ');

export const consumerStats = {
  received: 0,
  handled: 0,
  duplicates: 0,
  unhandled: 0,
  retries: 0,
  deadLettered: 0,
  lastError: null,
};

/** Attempt counters, keyed by the message's position. In memory on purpose — see `attemptKey`. */
const attempts = new Map();

/**
 * A message's identity for retry counting.
 *
 * Position rather than `eventId`, because a redelivery after a rebalance is the same position and
 * should continue counting, while a genuinely republished event (a new outbox attempt) is a new
 * position and deserves a fresh budget.
 *
 * Resets on restart, and that is an accepted limitation: a poison message that survives a restart
 * simply takes another `maxHandlerAttempts` before it reaches the DLQ. The alternative — tracking
 * attempts in Postgres — adds a write per failed attempt to protect against a case where the
 * outcome is identical, only later.
 */
const attemptKey = ({ topic, partition, message }) => `${topic}/${partition}/${message.offset}`;

/**
 * Handle one message.
 *
 * Exported and pure with respect to its dependencies so the whole contract can be tested without
 * a broker: pass an executor and a producer.
 */
export async function handleMessage(
  { topic, partition, message },
  { executor = db, producer, handlers = defaultHandlers, groupId = config.kafka.consumerGroup } = {}
) {
  consumerStats.received += 1;

  let event;
  try {
    event = JSON.parse(message.value.toString());
  } catch (e) {
    // Unparseable: retrying cannot help, so it goes straight to the DLQ. Anything else would
    // block the partition on a message that will never be valid.
    await deadLetter({ producer, message, topic, partition, error: e, reason: 'unparseable' });
    consumerStats.deadLettered += 1;
    return { deadLettered: true, reason: 'unparseable' };
  }

  const key = attemptKey({ topic, partition, message });

  try {
    const result = await withTransaction(
      executor,
      async (tx) => {
        // THE CLAIM. One statement, atomic, and the reason this consumer is idempotent.
        const [claimed] = await tx
          .insert(processedEvents)
          .values({
            consumer_group: groupId,
            event_id: event.eventId,
            event_type: event.eventType,
          })
          .onConflictDoNothing()
          .returning({ event_id: processedEvents.event_id });

        if (!claimed) return { skipped: 'duplicate' };

        const handler = handlers[event.eventType];
        if (!handler) {
          // Recorded as processed, not retried. A consumer group that does not care about an event
          // type must not spend the rest of its life failing on it — and on a shared topic that is
          // the normal case, not an error.
          return { skipped: 'no-handler' };
        }

        await handler({ event, tx });
        return { handled: true };
      },
      { label: `consume:${event.eventType}` }
    );

    attempts.delete(key);

    if (result.skipped === 'duplicate') {
      consumerStats.duplicates += 1;
      logger.debug('Duplicate event skipped', { eventId: event.eventId, groupId });
    } else if (result.skipped === 'no-handler') {
      consumerStats.unhandled += 1;
    } else {
      consumerStats.handled += 1;
    }
    return result;
  } catch (e) {
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    consumerStats.lastError = e.message;

    if (attempt >= config.kafka.maxHandlerAttempts) {
      await deadLetter({
        producer,
        message,
        topic,
        partition,
        error: e,
        reason: 'handler-failed',
        event,
      });
      attempts.delete(key);
      consumerStats.deadLettered += 1;
      logger.error('Event dead-lettered after exhausting attempts', {
        eventId: event.eventId,
        eventType: event.eventType,
        attempts: attempt,
        error: e.message,
      });
      // Resolved, NOT thrown: resolving lets kafkajs commit the offset so the partition moves past
      // the poison message. Throwing here is what turns one bad event into a stopped pipeline.
      return { deadLettered: true, reason: 'handler-failed', attempts: attempt };
    }

    consumerStats.retries += 1;
    logger.warn('Event handler failed; will be retried', {
      eventId: event.eventId,
      attempt,
      maxAttempts: config.kafka.maxHandlerAttempts,
      error: e.message,
    });
    // Thrown, so kafkajs does not commit the offset and redelivers.
    throw e;
  }
}

/**
 * Publish to the dead-letter topic.
 *
 * The original value is forwarded UNCHANGED, with the diagnosis in headers. A DLQ that rewrites
 * the payload cannot be replayed into the main topic, which is the only thing a DLQ is for.
 */
async function deadLetter({ producer, message, topic, partition, error, reason, event }) {
  if (!producer) {
    // Without a producer there is nowhere to send it. Logging the full payload is the last resort
    // that keeps the event recoverable by hand.
    logger.error('No producer available for the DLQ — event logged instead', {
      reason,
      topic,
      partition,
      offset: message.offset,
      value: message.value?.toString()?.slice(0, 2000),
      error: error?.message,
    });
    return;
  }

  await producer
    .send({
      topic: config.kafka.dlqTopic,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: {
            ...(message.headers ?? {}),
            'dlq-reason': reason,
            'dlq-error': describeError(error).slice(0, 500),
            'dlq-source-topic': topic,
            'dlq-source-partition': String(partition),
            'dlq-source-offset': String(message.offset),
            'dlq-event-type': event?.eventType ?? 'unknown',
            'dlq-at': new Date().toISOString(),
          },
        },
      ],
    })
    .catch((e) =>
      // If the DLQ send fails there is nothing left to try; log everything needed to replay by
      // hand rather than losing it.
      logger.error('DLQ publish failed — event may be lost', {
        reason,
        error: e.message,
        value: message.value?.toString()?.slice(0, 2000),
      })
    );
}

/**
 * Wire a kafkajs consumer to `handleMessage`.
 *
 * `fromBeginning: false` — a new consumer group starts at the end of the topic. The alternative
 * would replay the entire history on first deploy, which for a group whose handler sends
 * notifications means notifying every user about every deal ever created.
 */
export async function startConsumer({ consumer, producer, handlers, groupId } = {}) {
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: false });

  await consumer.run({
    eachMessage: async (payload) => {
      await handleMessage(payload, { producer, handlers, groupId });
    },
  });

  logger.info('Consumer running', {
    groupId: groupId ?? config.kafka.consumerGroup,
    topic: config.kafka.topic,
  });

  return {
    async stop() {
      await consumer.disconnect();
    },
  };
}
