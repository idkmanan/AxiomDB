#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Wait until the schema this build expects actually exists.
//
//   node scripts/db/wait-for-schema.mjs --tables users,deals,outbox --timeout 120
//
// WHY THIS EXISTS INSTEAD OF RUNNING MIGRATIONS IN AN INIT CONTAINER. The obvious design is
// `initContainers: [{ command: ['npm','run','db:migrate'] }]` on the API Deployment — and with
// three replicas that is three concurrent migration runs against one database. drizzle-kit's
// migrator creates its bookkeeping table and inserts a row per applied migration; run three at
// once and the outcomes range from a duplicate-key error (loud, survivable) to two identical
// `CREATE TYPE` statements racing (loud, and it fails the rollout). Neither is a good look for
// something that runs on every deploy.
//
// So migrations are a JOB — one pod, one run, ordered before the rollout — and every application
// pod waits for the result with this script. The wait is what makes the ordering real: a Job that
// is "applied first" is not a Job that has "finished first", and a pod that starts against an old
// schema fails in whichever endpoint touches the new column.
//
// The check is deliberately for TABLES rather than for the migration journal: it asserts the state
// the application needs, not the mechanism that produced it, so it stays true if the migration tool
// is ever replaced.
// ---------------------------------------------------------------------------
import pg from 'pg';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const TABLES = getArg('tables', 'users,deals,outbox,processed_events,notifications')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
const TIMEOUT_S = Number(getArg('timeout', 120));
const INTERVAL_MS = Number(getArg('interval', 2000));

const say = (line) => process.stdout.write(`[wait-for-schema] ${line}\n`);

async function present(client) {
  const { rows } = await client.query(
    `select t.name, to_regclass(t.name) is not null as ok
       from unnest($1::text[]) as t(name)`,
    [TABLES]
  );
  return rows;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const deadline = Date.now() + TIMEOUT_S * 1000;
  say(`waiting for: ${TABLES.join(', ')} (timeout ${TIMEOUT_S}s)`);

  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      // Short, because a connection that hangs here is indistinguishable from a database that is
      // still starting, and both should simply be retried.
      connectionTimeoutMillis: 3000,
    });
    try {
      await client.connect();
      const rows = await present(client);
      const missing = rows.filter((r) => !r.ok).map((r) => r.name);
      if (missing.length === 0) {
        say(`all ${TABLES.length} tables present after ${attempt} attempt(s)`);
        await client.end();
        return;
      }
      say(`missing: ${missing.join(', ')} — retrying`);
    } catch (e) {
      say(`not ready (${e.message}) — retrying`);
    } finally {
      await client.end().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  // Non-zero exit fails the init container, which keeps the pod out of the Service rather than
  // letting it serve traffic against a schema it cannot use. CrashLoopBackOff with this message in
  // the logs is a far better failure than a 500 per request.
  throw new Error(`timed out after ${TIMEOUT_S}s waiting for: ${TABLES.join(', ')}`);
}

main().catch((e) => {
  process.stderr.write(`[wait-for-schema] FAILED: ${e.message}\n`);
  process.exit(1);
});
