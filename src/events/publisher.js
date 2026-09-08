// ---------------------------------------------------------------------------
// The outbox publisher: poll, claim, send, mark.
//
// THE PARTITION KEY IS THE ONLY INTERESTING DESIGN DECISION HERE, and it is easy to get wrong in
// a way that only shows up under load. Kafka guarantees order WITHIN a partition and nothing
// across partitions. With a null key, messages are spread round-robin, so `deal.created` and
// `deal.stage_advanced` for the same deal can land in different partitions and a consumer can
// see the stage change first — for a deal it has never heard of. Keying on
// `<aggregate_type>:<aggregate_id>` sends every event for one deal to one partition, which is
// exactly as much ordering as the domain needs and no more (deals do not need to be ordered
// relative to each other, and pretending they do would mean one partition and no parallelism).
//
// WHY A SINGLE PUBLISHER, WITH SKIP LOCKED ANYWAY. Two publishers using SKIP LOCKED never claim
// the same row — but they can send row 2 before row 1, which reorders events for one aggregate
// and defeats the key. So the publisher takes a Redis lock and normally runs alone.
//
// The lock is an OPTIMISATION, not the correctness mechanism, for exactly the reason set out in
// src/redis/lock.js: a lock with a TTL can expire while its holder is paused, so two publishers
// can briefly overlap no matter how careful the locking is. `FOR UPDATE SKIP LOCKED` is what
// makes that overlap harmless — Postgres, the resource, refuses to hand the same row to both.
// Lock for order, SKIP LOCKED for safety.
// ---------------------------------------------------------------------------
import config from '#config/env.js';
import logger from '#config/logger.js';
import { db } from '#config/database.js';
import { withTransaction } from '#utils/tx.js';
import { claimBatch, markPublished, markFailed } from '#events/outbox.service.js';
import { getProducer } from '#events/kafka.js';

export const publisherStats = {
  cycles: 0,
  published: 0,
  failed: 0,
  lockMissed: 0,
  lastError: null,
};

/** The wire format. Versioned, because a consumer deployed last month still has to read it. */
export function toMessage(row) {
  return {
    key: `${row.aggregate_type}:${row.aggregate_id}`,
    value: JSON.stringify({
      schemaVersion: 1,
      eventId: row.event_id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      occurredAt: row.created_at,
      payload: row.payload,
    }),
    // Headers duplicate three fields from the body on purpose: a consumer, a DLQ inspector or a
    // `kafka-console-consumer` can route and filter on them without deserialising the payload.
    headers: {
      'event-type': row.event_type,
      'event-id': row.event_id,
      'schema-version': '1',
    },
  };
}

/**
 * One publish cycle. Returns what it did, so the caller (and the tests) can assert on it.
 *
 * The whole cycle is ONE transaction: the claim, the send, and the mark. If the process dies
 * anywhere inside it, the transaction rolls back, the row locks are released, and the next cycle
 * re-claims the rows. Nothing is lost; something may be sent twice, which is why the consumer
 * deduplicates.
 */
export async function publishOnce({
  producer,
  executor = db,
  limit = config.kafka.batchSize,
} = {}) {
  publisherStats.cycles += 1;

  return withTransaction(
    executor,
    async (tx) => {
      const rows = await claimBatch(tx, { limit });
      if (rows.length === 0) return { claimed: 0, published: 0, failed: 0 };

      try {
        await producer.send({ topic: config.kafka.topic, messages: rows.map(toMessage) });
        const marked = await markPublished(
          tx,
          rows.map((r) => r.id)
        );
        publisherStats.published += marked;
        logger.debug('Outbox batch published', { count: marked });
        return { claimed: rows.length, published: marked, failed: 0 };
      } catch (e) {
        // A batch send is atomic from the client's point of view but not from the broker's: some
        // messages may already be on the log. Marking the whole batch failed therefore risks
        // resending those — at-least-once again, and the reason `processed_events` exists. The
        // alternative, sending one message per request, trades that risk for an order of
        // magnitude more round trips.
        publisherStats.failed += rows.length;
        publisherStats.lastError = e.message;
        for (const row of rows) await markFailed(tx, row, e);
        return { claimed: rows.length, published: 0, failed: rows.length };
      }
    },
    { label: 'outbox-publish' }
  );
}

/**
 * Run the publisher until stopped.
 *
 * `setTimeout` chained after each cycle rather than `setInterval`: an interval fires on a
 * schedule regardless of whether the previous cycle finished, so a slow broker would stack
 * overlapping cycles and each one would claim more rows while the last was still sending.
 */
export function startPublisher({ producer, intervalMs = config.kafka.pollIntervalMs, lock } = {}) {
  let stopped = false;
  let timer = null;

  const cycle = async () => {
    if (stopped) return;
    try {
      if (lock) {
        const { acquired } = await lock(() => publishOnce({ producer }));
        if (!acquired) publisherStats.lockMissed += 1;
      } else {
        await publishOnce({ producer });
      }
    } catch (e) {
      // Never let a cycle failure kill the loop: the publisher is a background worker, and a
      // crash loop here means events stop flowing entirely rather than being delayed.
      publisherStats.lastError = e.message;
      logger.error('Publisher cycle failed', { error: e.message });
    } finally {
      if (!stopped) {
        timer = setTimeout(cycle, intervalMs);
        timer.unref?.();
      }
    }
  };

  void cycle();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Convenience for the worker entrypoint: connect a producer and start polling. */
export async function startPublisherWithProducer(opts = {}) {
  const producer = await getProducer();
  return startPublisher({ producer, ...opts });
}
