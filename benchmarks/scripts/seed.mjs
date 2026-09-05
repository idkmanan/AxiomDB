#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Benchmark seeder.
//
//   node benchmarks/scripts/seed.mjs --users 1000
//
// Design notes:
//
// 1. bcrypt is hashed ONCE and the resulting digest is reused for every seeded
//    row. Measured cost at rounds=10 is ~114ms per hash, so hashing 1,000 rows
//    individually would take ~2 minutes of pure CPU for zero benchmark value —
//    every seeded user shares the same password anyway. The login path still
//    performs a real bcrypt.compare at full cost, which is what we measure.
//
// 2. Inserts are batched via multi-row VALUES. Row-at-a-time inserts would make
//    seeding 1M rows take hours.
//
// 3. Uses `pg` directly rather than Drizzle. The seeder must work regardless of
//    which driver src/config/database.js happens to select, and it needs COPY-
//    style bulk behaviour that the ORM layer would only get in the way of.
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import pg from 'pg';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const USER_COUNT = Number(getArg('users', 1000));
const BATCH_SIZE = Number(getArg('batch', 500));
const PASSWORD = process.env.SEED_PASSWORD || 'BenchPassword123!';
const BCRYPT_ROUNDS = Number(process.env.SEED_BCRYPT_ROUNDS || 10);
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'bench_admin@example.test';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://bench:bench@localhost:5433/benchdb';

function log(msg) {
  process.stdout.write(`[seed] ${msg}\n`);
}

async function main() {
  log(`target: ${DATABASE_URL.replace(/(:\/\/[^:]+:)[^@]+@/, '$1***@')}`);
  log(`users: ${USER_COUNT}, batch: ${BATCH_SIZE}, bcrypt rounds: ${BCRYPT_ROUNDS}`);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    // The schema comes from drizzle/0000_dapper_hedge_knight.sql. Create it if
    // absent so the seeder works on a fresh volume without a migration step
    // (scripts/dev.sh:37 runs migrations from the host BEFORE the container's
    // Postgres is healthy — a race documented as finding F-09).
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id serial PRIMARY KEY NOT NULL,
        name varchar(255) NOT NULL,
        email varchar(255) NOT NULL,
        password varchar(255) NOT NULL,
        role varchar(50) DEFAULT 'user' NOT NULL,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL,
        CONSTRAINT users_email_unique UNIQUE(email)
      );
    `);

    const existing = await client.query(
      'SELECT count(*)::int AS n FROM users WHERE email LIKE $1',
      ['bench\\_%']
    );

    const t0 = Date.now();
    const hash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);
    log(`hashed shared password in ${Date.now() - t0}ms (reused for all rows — see header note)`);

    // The admin is ensured on EVERY invocation, including the already-seeded
    // early-return path below. benchmarks/k6/baseline.js setup() now throws if it
    // cannot authenticate as this account, because without an admin session
    // GET /api/users returns 403 from authorize() before the controller runs
    // (src/middleware/auth.middleware.js:35-40) and the unbounded scan is never
    // measured. Re-running the seeder after changing SEED_PASSWORD must therefore
    // repair the admin's password rather than skip it.
    await ensureAdmin(client, hash);

    if (existing.rows[0].n >= USER_COUNT) {
      log(`already seeded (${existing.rows[0].n} bench users present) — skipping bulk insert`);
      await verify(client);
      return;
    }

    // Deterministic emails so the k6 script can address any seeded user by index
    // without a lookup round-trip.
    let inserted = 0;
    const tStart = Date.now();

    for (let start = 1; start <= USER_COUNT; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE - 1, USER_COUNT);
      const values = [];
      const params = [];
      let p = 1;

      for (let i = start; i <= end; i++) {
        values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(`Bench User ${i}`, `bench_user_${i}@example.test`, hash, 'user');
      }

      // ON CONFLICT DO NOTHING makes the seeder idempotent and re-runnable.
      const res = await client.query(
        `INSERT INTO users (name, email, password, role)
         VALUES ${values.join(', ')}
         ON CONFLICT (email) DO NOTHING`,
        params
      );
      inserted += res.rowCount;

      if (end % (BATCH_SIZE * 10) === 0 || end === USER_COUNT) {
        const elapsed = (Date.now() - tStart) / 1000;
        log(`${end}/${USER_COUNT} rows (${(end / elapsed).toFixed(0)} rows/s)`);
      }
    }

    log(`inserted ${inserted} new rows in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

    // ANALYZE so the planner has fresh statistics. Skipping this is a common way
    // to accidentally benchmark a bad query plan and blame the schema.
    await client.query('ANALYZE users');
    log('ANALYZE complete — planner statistics refreshed');

    await verify(client);
  } finally {
    await client.end();
  }
}

async function ensureAdmin(client, hash) {
  // ON CONFLICT ... DO UPDATE, not DO NOTHING: if the row already exists with the
  // wrong role or a stale password hash, the load test's setup() would fail to
  // authenticate and abort. Upserting makes the seeder self-healing.
  const res = await client.query(
    `INSERT INTO users (name, email, password, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE
       SET role = 'admin', password = EXCLUDED.password, updated_at = now()
     RETURNING id, role`,
    ['Bench Admin', ADMIN_EMAIL, hash]
  );
  const row = res.rows[0];
  log(`admin ready: ${ADMIN_EMAIL} (id=${row.id}, role=${row.role})`);
}

async function verify(client) {
  const { rows } = await client.query(`
    SELECT role, count(*)::int AS n FROM users GROUP BY role ORDER BY role
  `);
  log('verification:');
  for (const r of rows) log(`  role=${r.role.padEnd(6)} count=${r.n}`);

  const { rows: idx } = await client.query(`
    SELECT indexname FROM pg_indexes WHERE tablename = 'users' ORDER BY indexname
  `);
  log(`indexes on users: ${idx.map((r) => r.indexname).join(', ') || '(none)'}`);
  log(`run id: ${randomUUID()}`);
}

main().catch((e) => {
  process.stderr.write(`[seed] FAILED: ${e.message}\n`);
  process.exit(1);
});
