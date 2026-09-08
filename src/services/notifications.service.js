// ---------------------------------------------------------------------------
// Notifications — the read side of the async pipeline.
//
// Small on purpose. Its job is to make the last hop of
// `POST → persist+outbox → publish → consume → notify` observable from the outside, so the Phase 5
// claim can be checked with curl rather than believed from a log line.
// ---------------------------------------------------------------------------
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '#config/database.js';
import logger from '#config/logger.js';
import { notifications } from '#models/notification.model.js';
import { AppError } from '#middleware/error.middleware.js';

const COLUMNS = {
  id: notifications.id,
  kind: notifications.kind,
  subject: notifications.subject,
  body: notifications.body,
  event_id: notifications.event_id,
  created_at: notifications.created_at,
  read_at: notifications.read_at,
};

/**
 * A user's notifications, newest first.
 *
 * Keyset by `id` alone here rather than by `(created_at, id)` as the deals list does, and the
 * difference is worth a sentence: `id` is a monotonically increasing bigserial, so for a
 * single-writer table it is already a total order that matches insertion time. `deals` needs the
 * composite cursor because it is ordered by a business timestamp that the seeder — and a backfill
 * — can write out of id order.
 */
export const listNotifications = async ({ userId, limit = 20, before, unreadOnly = false }) => {
  const clauses = [eq(notifications.user_id, userId)];
  if (unreadOnly) clauses.push(isNull(notifications.read_at));
  if (before !== undefined) clauses.push(lt(notifications.id, before));

  const rows = await db
    .select(COLUMNS)
    .from(notifications)
    .where(and(...clauses))
    .orderBy(desc(notifications.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    notifications: page,
    pagination: {
      limit,
      returned: page.length,
      hasMore,
      nextBefore: hasMore ? page[page.length - 1].id : null,
    },
  };
};

/** Mark one notification read. Scoped to the owner in the predicate, never by a pre-read. */
export const markNotificationRead = async ({ id, userId }) => {
  const [row] = await db
    .update(notifications)
    // `read_at IS NULL` in the predicate makes this idempotent: marking a read notification read
    // again affects zero rows and keeps the ORIGINAL timestamp, rather than quietly rewriting when
    // the user first saw it.
    .set({ read_at: sql`now()` })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.user_id, userId),
        isNull(notifications.read_at)
      )
    )
    .returning(COLUMNS);

  if (row) return row;

  // Zero rows: either it is not there, not theirs, or already read. The already-read case is not
  // an error — the client asked for a state the row is already in.
  const [existing] = await db
    .select(COLUMNS)
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.user_id, userId)))
    .limit(1);

  if (!existing)
    throw new AppError('Notification not found', 404, { code: 'NOTIFICATION_NOT_FOUND' });
  logger.debug('Notification was already read', { id, userId });
  return existing;
};
