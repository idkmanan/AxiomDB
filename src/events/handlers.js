// ---------------------------------------------------------------------------
// Event handlers.
//
// EVERY HANDLER RECEIVES THE TRANSACTION and must do all of its work inside it. That is not a
// style preference — it is the entire idempotency mechanism. The consumer inserts a row into
// `processed_events` in the same transaction (src/events/consumer.js), so either the handler's
// effects AND the "I have seen this" marker commit together, or neither does. A handler that
// wrote through the pool instead would be able to commit its effect and then have the marker
// roll back, and the redelivery would apply the effect twice — the dual-write problem
// reappearing inside the fix for the dual-write problem.
//
// HANDLERS MUST ALSO BE IDEMPOTENT ON THEIR OWN where they can be. The marker makes duplicate
// DELIVERY harmless; it cannot help with a handler that is retried after a partial failure
// inside its own transaction. In practice that means: prefer inserts with a natural unique key,
// prefer `UPDATE … WHERE` over read-modify-write, and never depend on the number of times you
// were called.
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';
import { notifications } from '#models/notification.model.js';

const money = (cents, currency) =>
  `${(Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: currency || 'USD' })}`;

/**
 * `deal.created` → tell the owner.
 *
 * The insert is deliberately not conditional on anything: the `processed_events` marker already
 * guarantees one execution per event per consumer group, and adding a second guard here would be
 * duplicated logic that can disagree with the first.
 */
async function onDealCreated({ event, tx }) {
  const { payload } = event;
  await tx.insert(notifications).values({
    user_id: payload.owner_id,
    kind: 'deal.created',
    subject: `Deal created: ${payload.title}`,
    body: `${payload.company} — ${money(payload.amount_cents, payload.currency)} at stage "${payload.stage}".`,
    event_id: event.eventId,
  });
  logger.info('Notified owner of a new deal', { dealId: payload.id, userId: payload.owner_id });
}

/** `deal.stage_advanced` → tell the owner, and say what changed. */
async function onDealStageAdvanced({ event, tx }) {
  const { payload } = event;
  const closing = Boolean(payload.closed_at);
  await tx.insert(notifications).values({
    user_id: payload.owner_id,
    kind: 'deal.stage_advanced',
    subject: closing
      ? `Deal ${payload.stage === 'closed_won' ? 'won' : 'lost'}: ${payload.title}`
      : `Deal moved to ${payload.stage}: ${payload.title}`,
    body: `${payload.company} is now at stage "${payload.stage}" (version ${payload.version}).`,
    event_id: event.eventId,
  });
  logger.info('Notified owner of a stage change', {
    dealId: payload.id,
    stage: payload.stage,
    userId: payload.owner_id,
  });
}

/**
 * The registry.
 *
 * An event type with no handler here is RECORDED as processed rather than retried — see the note
 * in src/events/consumer.js. That is the right default for a shared topic: a consumer group that
 * does not care about an event type should not spend the rest of its life failing on it.
 */
export const handlers = {
  'deal.created': onDealCreated,
  'deal.stage_advanced': onDealStageAdvanced,
};

export default handlers;
