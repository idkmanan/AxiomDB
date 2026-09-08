// ---------------------------------------------------------------------------
// Outbox reads and writes. No Kafka in this file — that separation is the point.
//
// The enqueue side runs inside the caller's transaction (src/services/deals.service.js), and the
// claim side is what the publisher polls. Keeping the broker out of here means the domain write
// path has no dependency on Kafka at all: `POST /api/deals` succeeds, and is durable, whether or
// not a broker exists. That is the property the drill in scripts/events/outbox-drill.mjs
// demonstrates.
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { db } from '#config/database.js';
import logger from '#config/logger.js';
import { outbox, OUTBOX_MAX_ATTEMPTS } from '#models/outbox.model.js';

/**
 * Append an event, in the caller's transaction.
 *
 * THE `executor` PARAMETER IS THE WHOLE DESIGN. It is not optional in spirit: passing the
 * pool-backed `db` here instead of a transaction would make this a second write that can fail
 * independently of the domain write, which is the dual-write problem the outbox exists to
 * remove. Every call site in this repository passes a `tx`.
 *
 * @param {object} executor a drizzle transaction
 * @param {object} event
 * @param {string} event.aggregateType e.g. 'deal'
 * @param {string|number} event.aggregateId
 * @param {string} event.eventType e.g. 'deal.created'
 * @param {object} event.payload
 */
export async function enqueueEvent(executor, { aggregateType, aggregateId, eventType, payload }) {
  const [row] = await executor
    .insert(outbox)
    .values({
      aggregate_type: aggregateType,
      aggregate_id: String(aggregateId),
      event_type: eventType,
      // Generated here, by the writer, so it is stable across every redelivery — that stability
      // is what lets a consumer deduplicate. A broker-assigned id would be different on each
      // send and useless for that.
      event_id: randomUUID(),
      payload,
    })
    .returning({ id: outbox.id, event_id: outbox.event_id });

  return row;
}

/**
 * Claim a batch of due events for publishing.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this a work queue rather than a bottleneck: rows locked
 * by another publisher are skipped instead of waited on, so N publishers process disjoint sets
 * with no coordination and no lock contention. Without SKIP LOCKED, a second publisher would
 * block behind the first on the same oldest row and add nothing but a connection.
 *
 * THE LOCK IS HELD FOR THE WHOLE PUBLISH, and that is deliberate: the transaction stays open
 * across the Kafka send, so a publisher that dies mid-send releases its rows and another attempt
 * re-sends them. That yields at-least-once delivery, which is why the consumer must be
 * idempotent. The cost is a transaction whose lifetime includes a network round trip — long
 * transactions hold back VACUUM, which is why the batch is small (100) rather than 10,000.
 *
 * @param {object} executor a transaction — this must not be called on the pool
 * @param {number} limit
 */
export async function claimBatch(executor, { limit = 100 } = {}) {
  return (
    executor
      .select()
      .from(outbox)
      .where(
        and(
          isNull(outbox.published_at),
          isNull(outbox.dead_lettered_at),
          lte(outbox.available_at, sql`now()`)
        )
      )
      // Oldest first, and `id` as the tiebreaker so the order is total. Publishing out of order
      // within one aggregate is exactly what the partition key is meant to prevent, so the read
      // side must not introduce it.
      .orderBy(asc(outbox.available_at), asc(outbox.id))
      .limit(limit)
      .for('update', { skipLocked: true })
  );
}

export async function markPublished(executor, ids) {
  if (ids.length === 0) return 0;
  const result = await executor
    .update(outbox)
    .set({ published_at: sql`now()`, last_error: null })
    .where(sql`${outbox.id} in ${ids}`)
    .returning({ id: outbox.id });
  return result.length;
}

/**
 * Record a failed publish and push the row into the future.
 *
 * Exponential backoff with a ceiling, expressed as `available_at` rather than as a sleep: the
 * poller's WHERE clause simply cannot see the row until it is due, so backoff needs no scheduler
 * and survives a publisher restart. A retry loop in memory would forget everything on redeploy
 * and hammer the broker the moment it came back.
 */
export async function markFailed(executor, row, error) {
  const attempts = row.attempts + 1;
  const backoffMs = Math.min(2 ** attempts * 250, 5 * 60_000);
  const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS;

  await executor
    .update(outbox)
    .set({
      attempts,
      last_error: String(error?.message ?? error).slice(0, 2000),
      available_at: sql`now() + ${`${backoffMs} milliseconds`}::interval`,
      // Marked, never deleted. A dead-lettered row stays queryable in the database, which is the
      // difference between a dead-letter queue somebody reads and one that exists on a diagram.
      ...(exhausted ? { dead_lettered_at: sql`now()` } : {}),
    })
    .where(eq(outbox.id, row.id));

  const level = exhausted ? 'error' : 'warn';
  logger.log(level, exhausted ? 'Outbox row dead-lettered' : 'Outbox publish failed; will retry', {
    outboxId: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    attempts,
    backoffMs: exhausted ? undefined : backoffMs,
    error: String(error?.message ?? error),
  });

  return { attempts, exhausted, backoffMs };
}

/**
 * Backlog gauges for /metrics.
 *
 * `oldest_pending_age_seconds` is the number that matters, and it is not the same as depth: a
 * queue of 10,000 rows that is draining is healthy, and a queue of 3 rows where the oldest is 20
 * minutes old means publishing is broken. Depth alone would page for the first and miss the
 * second.
 */
export async function outboxStats({ executor = db } = {}) {
  const result = await executor.execute(sql`
    select
      count(*) filter (where published_at is null and dead_lettered_at is null)::int as pending,
      count(*) filter (where dead_lettered_at is not null)::int as dead_lettered,
      coalesce(
        extract(epoch from (now() - min(created_at) filter (where published_at is null and dead_lettered_at is null))),
        0
      )::float as oldest_pending_age_seconds
    from outbox
  `);
  const rows = Array.isArray(result) ? result : (result?.rows ?? []);
  const row = rows[0] ?? {};
  return {
    pending: Number(row.pending ?? 0),
    deadLettered: Number(row.dead_lettered ?? 0),
    oldestPendingAgeSeconds: Number(row.oldest_pending_age_seconds ?? 0),
  };
}

export { OUTBOX_MAX_ATTEMPTS };
