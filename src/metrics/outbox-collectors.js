// ---------------------------------------------------------------------------
// Event-pipeline metrics.
//
// A SEPARATE FILE FROM `collectors.js` BECAUSE OF WHO IMPORTS IT. The API process has no publisher
// and no consumer; the workers have no HTTP routes. Registering the outbox gauges from the shared
// collector would mean the API paying for an outbox query on every scrape to report zeros, and the
// workers registering HTTP histograms nothing writes to. Each process imports the collectors that
// describe work it actually does.
//
// THE ONE METRIC TO ALERT ON IS `outbox_oldest_pending_age_seconds`, not depth. A backlog of
// 50,000 rows that is draining is a busy system; three rows where the oldest is twenty minutes old
// means publishing is broken. Depth alone pages for the first and misses the second — which is the
// same reasoning that made `pg_pool_connections{waiting}` more useful than a latency histogram in
// F-33.
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';
import { registry } from '#metrics/registry.js';
import { outboxStats } from '#events/outbox.service.js';
import { publisherStats } from '#events/publisher.js';
import { consumerStats } from '#events/consumer.js';

const publisherCounters = registry.counter(
  'outbox_publish_events_total',
  'Outbox publisher activity, by outcome.',
  ['outcome']
);

const consumerCounters = registry.counter('events_consumed_total', 'Consumed events, by outcome.', [
  'outcome',
]);

/**
 * The backlog gauges are collected from ONE cached query rather than three.
 *
 * A scrape every 15 seconds running a `count(*) filter (…)` over the outbox is cheap while the
 * table is small and is not cheap once it holds ten million published rows — and a metrics endpoint
 * that gets slower as the system gets busier is a metrics endpoint that stops being scraped. The
 * result is cached for slightly less than a scrape interval, and the query only ever touches the
 * partial index (`published_at is null`), so its cost tracks the BACKLOG rather than history.
 */
let cache = { at: 0, value: { pending: 0, deadLettered: 0, oldestPendingAgeSeconds: 0 } };
const CACHE_MS = 10_000;

async function refresh() {
  if (Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    cache = { at: Date.now(), value: await outboxStats() };
  } catch (e) {
    // A failed scrape must not throw out of the metrics endpoint: a 500 on /metrics is
    // indistinguishable from a dead process to Prometheus, and the last known values are more
    // useful than none.
    logger.warn('Could not refresh outbox stats for /metrics', { error: e.message });
  }
  return cache.value;
}

registry.gauge('outbox_pending', 'Events written but not yet published.').collect((g) => {
  // Fire-and-forget: `collect` is synchronous by design (see src/metrics/registry.js), so the
  // query runs in the background and the NEXT scrape reads the fresh value. A scrape that awaited
  // a database round trip would make the endpoint's latency a function of database health.
  void refresh();
  g.set({}, cache.value.pending);
});

registry
  .gauge('outbox_dead_lettered', 'Events that exhausted their publish attempts.')
  .collect((g) => g.set({}, cache.value.deadLettered));

registry
  .gauge(
    'outbox_oldest_pending_age_seconds',
    'Age of the oldest unpublished event. The alerting signal.'
  )
  .collect((g) => g.set({}, cache.value.oldestPendingAgeSeconds));

registry.gauge('outbox_publisher_cycles', 'Publisher poll cycles completed.').collect((g) => {
  publisherCounters.setTotal({ outcome: 'published' }, publisherStats.published);
  publisherCounters.setTotal({ outcome: 'failed' }, publisherStats.failed);
  publisherCounters.setTotal({ outcome: 'lock_missed' }, publisherStats.lockMissed);
  g.set({}, publisherStats.cycles);
});

registry
  .gauge('consumer_received', 'Messages received by this consumer since start.')
  .collect((g) => {
    consumerCounters.setTotal({ outcome: 'handled' }, consumerStats.handled);
    // `duplicate` is not an error — it is the idempotency mechanism working. A non-zero value
    // proves redelivery happens, which is the honest description of at-least-once delivery.
    consumerCounters.setTotal({ outcome: 'duplicate' }, consumerStats.duplicates);
    consumerCounters.setTotal({ outcome: 'unhandled' }, consumerStats.unhandled);
    consumerCounters.setTotal({ outcome: 'retried' }, consumerStats.retries);
    consumerCounters.setTotal({ outcome: 'dead_lettered' }, consumerStats.deadLettered);
    g.set({}, consumerStats.received);
  });

export { registry };
