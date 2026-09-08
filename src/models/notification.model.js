// ---------------------------------------------------------------------------
// Notifications — the async side effect at the end of the pipeline.
//
// This table exists so the Phase 5 claim is a path rather than a diagram:
//
//   POST /api/deals → deals row + outbox row (one transaction)
//                   → publisher → Kafka
//                   → consumer → notifications row + processed_events row (one transaction)
//
// It is deliberately the smallest thing that makes the last hop observable. A "send an email"
// handler would demonstrate the same mechanics and could not be asserted on by a test or read
// back by a `GET`, which is how an event pipeline ends up believed rather than verified.
//
// WHY THE WRITE BELONGS IN THE CONSUMER AND NOT IN THE REQUEST. Notifying is not part of the
// caller's transaction: it must not be able to fail the create, it must not add its latency to
// the response, and it must still happen if the process dies immediately after the commit. Those
// three properties are the entire argument for asynchronous work, and each of them is violated by
// the obvious alternative of writing the notification inline.
// ---------------------------------------------------------------------------
import { sql } from 'drizzle-orm';
import { pgTable, bigserial, integer, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from '#models/user.model.js';

export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // CASCADE here, unlike `deals.owner_id` which is RESTRICT. The difference is the point: a
    // deal is a business record that must outlive an account closure decision, and a notification
    // is a derived artefact with no independent value. Same FK mechanism, opposite policy,
    // because the question "is this data worth blocking a delete for?" has different answers.
    kind: varchar('kind', { length: 64 }).notNull(),
    subject: varchar('subject', { length: 200 }).notNull(),
    body: text('body').notNull(),
    // Correlates a notification back to the event that produced it, which is what makes the
    // pipeline debuggable from either end.
    event_id: varchar('event_id', { length: 64 }),
    created_at: timestamp('created_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    read_at: timestamp('read_at', { withTimezone: true, precision: 3 }),
  },
  (t) => [
    // "My unread notifications, newest first" — equality on the owner, then the sort key, as a
    // partial index over the only rows anyone asks for. Same reasoning as
    // `deals_open_created_idx`.
    index('notifications_unread_idx')
      .on(t.user_id, t.created_at.desc(), t.id.desc())
      .where(sql`read_at is null`),
  ]
);

export default notifications;
