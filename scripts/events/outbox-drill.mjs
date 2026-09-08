#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE DRILL: the broker is down at write time, and nothing is lost.
//
//   docker compose -f docker-compose.bench.yml stop kafka
//   node scripts/events/outbox-drill.mjs write --deals 5
//   docker compose -f docker-compose.bench.yml start kafka
//   node scripts/events/outbox-drill.mjs drain
//
// WHAT IS BEING PROVEN, and why it needs a drill rather than a paragraph. The claim is that
// `POST /api/deals` succeeds and its event survives while Kafka is unavailable. Both halves are
// invisible in normal operation: with the broker up you cannot tell an outbox from a dual write, and
// with the broker down a dual-write implementation returns 500s that look like an outage rather than
// like a design flaw. Stopping the broker is the only way to see the difference.
//
// `write` writes deals with the broker unreachable and asserts:
//   * every write SUCCEEDED (the domain transaction does not touch Kafka)
//   * every event is in the outbox, unpublished
//
// `drain` then asserts, with the broker back:
//   * the publisher sends them all and marks them published
//   * a consumer receives them and the notifications appear
//   * REDELIVERING one of them changes nothing, because the consumer deduplicates
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import config from '#config/env.js';
import { db, closeDatabase } from '#config/database.js';
import { outbox } from '#models/outbox.model.js';
import { notifications } from '#models/notification.model.js';
import { users } from '#models/user.model.js';
import { createDeal } from '#services/deals.service.js';
import { publishOnce } from '#events/publisher.js';
import { handleMessage } from '#events/consumer.js';
import { getProducer, createConsumer, closeKafka } from '#events/kafka.js';

const command = process.argv[2] ?? 'write';
const args = process.argv.slice(3);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const DEALS = Number(getArg('deals', 5));
const TIMEOUT_MS = Number(getArg('timeout', 15000));
const MARKER = 'DRILL';

const say = (line) => process.stdout.write(`${line}\n`);
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  say(`   ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function ensureOwner() {
  const [row] = await db
    .insert(users)
    .values({ name: 'Drill Owner', email: 'drill@example.test', password: 'x' })
    .onConflictDoUpdate({ target: users.email, set: { updated_at: new Date() } })
    .returning({ id: users.id });
  return row.id;
}

const pendingCount = async () => {
  const rows = await db
    .select({ n: sql`count(*)::int`.as('n') })
    .from(outbox)
    .where(and(isNull(outbox.published_at), isNull(outbox.dead_lettered_at)));
  return Number(rows[0].n);
};

// ---------------------------------------------------------------------------
// write — with the broker stopped
// ---------------------------------------------------------------------------
async function write() {
  say(`── writing ${DEALS} deals (the broker should be STOPPED for this half)`);
  const ownerId = await ensureOwner();
  const before = await pendingCount();

  const created = [];
  for (let i = 0; i < DEALS; i++) {
    // No try/catch: if this throws, the drill has already failed its most important assertion, and
    // the stack trace is the finding.
    created.push(
      await createDeal({
        ownerId,
        title: `${MARKER} deal ${i + 1} ${randomUUID().slice(0, 8)}`,
        company: 'Drill Co',
        amountCents: 100000 + i,
      })
    );
  }

  const after = await pendingCount();
  check(`all ${DEALS} writes succeeded with no broker`, created.length === DEALS);
  check(
    'every event is queued in the outbox',
    after - before === DEALS,
    `pending ${before} → ${after}`
  );
  say('');
  say('The API is fully available with Kafka down, and no event was lost. A dual-write');
  say('implementation would have failed the write or dropped the event.');
  say('');
  say('Now start the broker and run: node scripts/events/outbox-drill.mjs drain');
}

// ---------------------------------------------------------------------------
// drain — with the broker running
// ---------------------------------------------------------------------------
async function drain() {
  const pending = await pendingCount();
  say(`── draining ${pending} pending event(s) (the broker must be RUNNING)`);
  if (pending === 0) {
    say('Nothing pending. Run `write` first, ideally with the broker stopped.');
    return;
  }

  const producer = await getProducer();

  let published = 0;
  let cycles = 0;
  // Loop rather than one cycle: the batch size is bounded, so a large backlog needs several passes —
  // which is exactly how the real publisher drains one.
  while (cycles < 100) {
    const result = await publishOnce({ producer });
    published += result.published;
    cycles += 1;
    if (result.claimed === 0) break;
  }

  check(
    'the backlog was published',
    published === pending,
    `${published}/${pending} in ${cycles} cycle(s)`
  );
  check('nothing is left pending', (await pendingCount()) === 0);

  // ---- consume, with a throwaway group so the real one is untouched -------
  const groupId = `drill-${randomUUID().slice(0, 8)}`;
  const consumer = await createConsumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: true });

  const seen = [];
  let firstMessage = null;

  await consumer.run({
    eachMessage: async (payload) => {
      const result = await handleMessage(payload, { producer, groupId });
      seen.push(result);
      firstMessage ??= payload;
    },
  });

  const deadline = Date.now() + TIMEOUT_MS;
  while (seen.length < published && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  check(
    'the consumer handled every published event',
    seen.filter((s) => s.handled).length >= published,
    `${seen.length} message(s) processed`
  );

  // ---- redelivery ---------------------------------------------------------
  if (firstMessage) {
    const again = await handleMessage(firstMessage, { producer, groupId });
    // The single most important consumer property: at-least-once DELIVERY, exactly-once EFFECT.
    check(
      'redelivering an event is a no-op',
      again.skipped === 'duplicate',
      `second attempt → ${JSON.stringify(again)}`
    );
  }

  const notified = await db
    .select({ n: sql`count(*)::int`.as('n') })
    .from(notifications)
    .where(eq(notifications.kind, 'deal.created'));
  check(
    'notifications were written by the handler',
    Number(notified[0].n) > 0,
    `${notified[0].n} row(s)`
  );

  await consumer.disconnect();
  await closeKafka();
}

async function main() {
  say(`outbox drill — command: ${command}, topic: ${config.kafka.topic}`);
  say(`brokers: ${config.kafka.brokers.join(',') || '(none configured)'}`);
  say('');

  try {
    if (command === 'write') await write();
    else if (command === 'drain') await drain();
    else if (command === 'full') {
      await write();
      say('');
      await drain();
    } else {
      say(`Unknown command "${command}". Use: write | drain | full`);
      process.exit(1);
    }
  } finally {
    await closeDatabase().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  say('');
  say(`${results.length - failed.length}/${results.length} assertions passed`);
  if (failed.length) {
    say(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exit(1);
  }
}

main().catch(async (e) => {
  process.stderr.write(`[drill] FAILED: ${e.message}\n`);
  await closeDatabase().catch(() => {});
  process.exit(1);
});
