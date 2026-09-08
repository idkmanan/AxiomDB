#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Isolation levels, demonstrated against a real Postgres.
//
//   node scripts/db/isolation-demo.mjs
//   node scripts/db/isolation-demo.mjs --out benchmarks/v3-postgres/isolation-anomalies.txt
//
// WHY THIS SCRIPT EXISTS. Every claim in this repository about concurrency is meant to be
// checkable, and the concurrency claims are the easiest ones to get away with asserting:
// the failure modes are timing-dependent, so a reviewer cannot spot them by reading and a
// unit test with a mocked database cannot reach them. So each one is run here with two real
// sessions, interleaved deliberately, and the outcome is printed next to the outcome the
// code assumes.
//
// THE HEADLINE IS SCENARIO 1 — FINDING F-41. The Phase 1 code had a check-then-insert
// signup with a comment promising that Phase 3 would "wrap it in a transaction". It would
// not have helped. At READ COMMITTED, each statement takes a fresh snapshot of COMMITTED
// data, so an uncommitted INSERT in another session is invisible: both transactions pass
// the existence check and one fails at COMMIT. Only the unique index actually prevents the
// duplicate, which is why the check was deleted rather than wrapped.
//
// Sessions are labelled A and B, and every step is printed in the order it ran, so the
// interleaving is visible rather than implied.
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT = getArg('out', 'benchmarks/v3-postgres/isolation-anomalies.txt');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://bench:bench@localhost:5433/benchdb';
const DEMO_EMAIL = 'isolation_demo@example.test';

const transcript = [];
const say = (line) => {
  transcript.push(line);
  process.stdout.write(`${line}\n`);
};
const step = (session, text) => say(`   ${session} │ ${text}`);

/** SQLSTATE out of an error, whatever wrapper it arrives in. */
const code = (e) => e?.code ?? e?.cause?.code ?? '(none)';

/**
 * A scenario runs with two independent connections and reports what it observed.
 *
 * `expected` is written down BEFORE the run, and the script compares. A demonstration that
 * only prints what happened proves nothing: the point is that the database's behaviour
 * matches the behaviour the application code was written against.
 */
const scenarios = [];
const scenario = (name, expected, fn) => scenarios.push({ name, expected, fn });

// ---------------------------------------------------------------------------
// 1. Check-then-insert. The finding.
// ---------------------------------------------------------------------------
scenario(
  'check-then-insert at READ COMMITTED (F-41)',
  'both transactions see no existing row; the second INSERT fails with 23505',
  async (a, b, ctx) => {
    const email = `race_${Date.now()}@example.test`;

    await a.query('begin isolation level read committed');
    await b.query('begin isolation level read committed');

    const seenA = await a.query('select id from users where email = $1', [email]);
    step('A', `SELECT … WHERE email = '${email}' → ${seenA.rowCount} rows`);
    const seenB = await b.query('select id from users where email = $1', [email]);
    step('B', `SELECT … same email → ${seenB.rowCount} rows  ← both passed the check`);

    await a.query('insert into users (name, email, password) values ($1, $2, $3)', [
      'A',
      email,
      'x',
    ]);
    step('A', 'INSERT → ok (uncommitted, and therefore invisible to B)');

    // B's INSERT blocks here: the unique index makes it wait for A's transaction to end,
    // because until then it cannot know whether the value will exist.
    const bInsert = b
      .query('insert into users (name, email, password) values ($1, $2, $3)', ['B', email, 'x'])
      .then(() => 'inserted')
      .catch((e) => code(e));
    step('B', 'INSERT → blocks on the unique index, waiting for A');

    await a.query('commit');
    step('A', 'COMMIT');

    const outcome = await bInsert;
    step('B', `INSERT resolves → ${outcome}`);
    await b.query('rollback').catch(() => {});

    ctx.cleanup.push(['delete from users where email = $1', [email]]);
    return {
      observed: `B got ${outcome}`,
      pass: outcome === '23505',
      note:
        outcome === '23505'
          ? 'The unique index is the serialization point, not the transaction. Wrapping the ' +
            'check and the insert in BEGIN/COMMIT changes nothing: both snapshots showed no row.'
          : 'Unexpected — the demonstration assumes a unique constraint on users.email.',
    };
  }
);

// ---------------------------------------------------------------------------
// 2. The same race at SERIALIZABLE.
// ---------------------------------------------------------------------------
scenario(
  'check-then-insert at SERIALIZABLE',
  'the second transaction aborts with 40001 (or 23505) instead of committing bad data',
  async (a, b, ctx) => {
    const email = `race_ser_${Date.now()}@example.test`;

    await a.query('begin isolation level serializable');
    await b.query('begin isolation level serializable');
    await a.query('select id from users where email = $1', [email]);
    await b.query('select id from users where email = $1', [email]);
    step('A/B', 'both SELECT under SSI — the read is now tracked for conflict detection');

    await a.query('insert into users (name, email, password) values ($1, $2, $3)', [
      'A',
      email,
      'x',
    ]);
    const bInsert = b
      .query('insert into users (name, email, password) values ($1, $2, $3)', ['B', email, 'x'])
      .then(() => 'inserted')
      .catch((e) => code(e));

    await a.query('commit');
    step('A', 'COMMIT');
    const outcome = await bInsert;
    step('B', `INSERT resolves → ${outcome}`);
    await b.query('rollback').catch(() => {});

    ctx.cleanup.push(['delete from users where email = $1', [email]]);
    return {
      observed: `B got ${outcome}`,
      pass: outcome === '40001' || outcome === '23505',
      note:
        'SERIALIZABLE detects the conflict rather than preventing it, so it is only usable ' +
        'with a retry loop — which is why src/utils/tx.js has one. Note that 23505 is also a ' +
        'correct outcome here: the unique index does not need SSI to do its job.',
    };
  }
);

// ---------------------------------------------------------------------------
// 3. Lost update — the defect that was in updateUser (F-42).
// ---------------------------------------------------------------------------
scenario(
  'read-modify-write at READ COMMITTED loses an update (F-42)',
  'two +10 increments produce +10, not +20',
  async (a, b, ctx) => {
    const dealId = await ctx.makeDeal({ amount_cents: 100 });

    await a.query('begin');
    await b.query('begin');

    const readA = await a.query('select amount_cents from deals where id = $1', [dealId]);
    const readB = await b.query('select amount_cents from deals where id = $1', [dealId]);
    step('A', `read amount_cents = ${readA.rows[0].amount_cents}`);
    step('B', `read amount_cents = ${readB.rows[0].amount_cents}  ← same value, no lock taken`);

    // Each session computes in application code from the value it read — which is exactly
    // what read-modify-write means, and why the second write erases the first.
    await a.query('update deals set amount_cents = $1 where id = $2', [
      Number(readA.rows[0].amount_cents) + 10,
      dealId,
    ]);
    step('A', `UPDATE amount_cents = ${Number(readA.rows[0].amount_cents) + 10}`);
    await a.query('commit');

    await b.query('update deals set amount_cents = $1 where id = $2', [
      Number(readB.rows[0].amount_cents) + 10,
      dealId,
    ]);
    step('B', `UPDATE amount_cents = ${Number(readB.rows[0].amount_cents) + 10}  ← overwrites A`);
    await b.query('commit');

    const final = await ctx.amount(dealId);
    step('—', `final amount_cents = ${final}`);

    return {
      observed: `final = ${final}`,
      pass: final === 110,
      note:
        'No error, no warning, no log line — the first update simply ceased to exist. This is ' +
        'the failure mode that makes "it worked in testing" so convincing.',
    };
  }
);

// ---------------------------------------------------------------------------
// 4. The same interleaving, with the version column.
// ---------------------------------------------------------------------------
scenario(
  'the version column converts the lost update into a 409',
  "B's UPDATE matches zero rows, so the application can refuse it",
  async (a, b, ctx) => {
    const dealId = await ctx.makeDeal({ amount_cents: 100 });

    const readA = await a.query('select amount_cents, version from deals where id = $1', [dealId]);
    const readB = await b.query('select amount_cents, version from deals where id = $1', [dealId]);
    step('A', `read version = ${readA.rows[0].version}`);
    step('B', `read version = ${readB.rows[0].version}`);

    const upA = await a.query(
      'update deals set amount_cents = $1, version = version + 1 where id = $2 and version = $3',
      [Number(readA.rows[0].amount_cents) + 10, dealId, readA.rows[0].version]
    );
    step('A', `UPDATE … AND version = ${readA.rows[0].version} → ${upA.rowCount} row(s)`);

    const upB = await b.query(
      'update deals set amount_cents = $1, version = version + 1 where id = $2 and version = $3',
      [Number(readB.rows[0].amount_cents) + 10, dealId, readB.rows[0].version]
    );
    step(
      'B',
      `UPDATE … AND version = ${readB.rows[0].version} → ${upB.rowCount} row(s)  ← the conflict, detected`
    );

    const final = await ctx.amount(dealId);
    step('—', `final amount_cents = ${final}`);

    return {
      observed: `A updated ${upA.rowCount} row, B updated ${upB.rowCount} rows, final = ${final}`,
      pass: upA.rowCount === 1 && upB.rowCount === 0 && final === 110,
      note:
        'Same final value as the lost update, but the second writer is TOLD. That is the whole ' +
        'difference: 409 with the current version lets the client re-read and re-apply, so the ' +
        'intended +20 can still happen. src/services/deals.service.js updateDeal.',
    };
  }
);

// ---------------------------------------------------------------------------
// 5. SELECT … FOR UPDATE.
// ---------------------------------------------------------------------------
scenario(
  'SELECT … FOR UPDATE serialises the two writers instead',
  'B blocks until A commits, then reads the new value: +20',
  async (a, b, ctx) => {
    const dealId = await ctx.makeDeal({ amount_cents: 100 });

    await a.query('begin');
    await b.query('begin');

    const readA = await a.query('select amount_cents from deals where id = $1 for update', [
      dealId,
    ]);
    step('A', `SELECT … FOR UPDATE → ${readA.rows[0].amount_cents} (row now locked)`);

    const bRead = b
      .query('select amount_cents from deals where id = $1 for update', [dealId])
      .then((r) => Number(r.rows[0].amount_cents));
    step('B', 'SELECT … FOR UPDATE → blocks');

    await a.query('update deals set amount_cents = $1 where id = $2', [
      Number(readA.rows[0].amount_cents) + 10,
      dealId,
    ]);
    await a.query('commit');
    step('A', 'UPDATE + COMMIT — lock released');

    const bValue = await bRead;
    step('B', `SELECT resolves → ${bValue}  ← A's committed value, not the stale one`);
    await b.query('update deals set amount_cents = $1 where id = $2', [bValue + 10, dealId]);
    await b.query('commit');
    step('B', `UPDATE amount_cents = ${bValue + 10} + COMMIT`);

    const final = await ctx.amount(dealId);
    step('—', `final amount_cents = ${final}`);

    return {
      observed: `final = ${final}`,
      pass: final === 120,
      note:
        'Both increments survive because the lock made read-then-write atomic. The cost is that ' +
        'B waited. Correct for a decision that depends on current state — the stage machine — and ' +
        'wrong across a client round trip, where the wait is a human being.',
    };
  }
);

// ---------------------------------------------------------------------------
// 6. Non-repeatable read.
// ---------------------------------------------------------------------------
scenario(
  'the same SELECT twice: READ COMMITTED moves, REPEATABLE READ does not',
  'READ COMMITTED sees the committed change mid-transaction; REPEATABLE READ keeps its snapshot',
  async (a, b, ctx) => {
    const dealId = await ctx.makeDeal({ amount_cents: 100 });
    const observations = {};

    for (const level of ['read committed', 'repeatable read']) {
      await ctx.setAmount(dealId, 100);
      await a.query(`begin isolation level ${level}`);
      const first = Number(
        (await a.query('select amount_cents from deals where id = $1', [dealId])).rows[0]
          .amount_cents
      );

      await b.query('update deals set amount_cents = 999 where id = $1', [dealId]);
      step('B', `UPDATE amount_cents = 999 + COMMIT (autocommit) while A is open at ${level}`);

      const second = Number(
        (await a.query('select amount_cents from deals where id = $1', [dealId])).rows[0]
          .amount_cents
      );
      await a.query('commit');
      step('A', `${level}: first read ${first}, second read ${second}`);
      observations[level] = { first, second };
    }

    const rc = observations['read committed'];
    const rr = observations['repeatable read'];
    return {
      observed: `read committed: ${rc.first} → ${rc.second}; repeatable read: ${rr.first} → ${rr.second}`,
      pass: rc.second === 999 && rr.second === rr.first,
      note:
        'A report that runs several queries at READ COMMITTED can therefore disagree with itself. ' +
        'REPEATABLE READ in Postgres is snapshot isolation: one snapshot for the whole ' +
        'transaction, taken at the first statement.',
    };
  }
);

// ---------------------------------------------------------------------------
// 7. Write skew — the anomaly REPEATABLE READ does NOT prevent.
// ---------------------------------------------------------------------------
scenario(
  'write skew at REPEATABLE READ, caught at SERIALIZABLE',
  'RR lets both sessions break a "max 3 open deals" rule; SERIALIZABLE aborts one with 40001',
  async (a, b, ctx) => {
    const results = {};

    for (const level of ['repeatable read', 'serializable']) {
      await ctx.resetOpenDeals(2); // two open deals, limit is 3

      await a.query(`begin isolation level ${level}`);
      await b.query(`begin isolation level ${level}`);

      // Both check the same invariant, over rows neither is modifying — which is exactly why
      // row locks cannot help: there is no row in common to lock.
      const countA = Number((await a.query(ctx.openCountSql, [ctx.ownerId])).rows[0].n);
      const countB = Number((await b.query(ctx.openCountSql, [ctx.ownerId])).rows[0].n);
      step('A', `counted ${countA} open deals (limit 3) → decides it may insert`);
      step('B', `counted ${countB} open deals (limit 3) → decides it may insert`);

      await a.query(ctx.insertOpenSql, [ctx.ownerId, 'skew A']);
      const bInsert = b
        .query(ctx.insertOpenSql, [ctx.ownerId, 'skew B'])
        .then(() => 'inserted')
        .catch((e) => code(e));

      const aCommit = await a
        .query('commit')
        .then(() => 'committed')
        .catch((e) => code(e));
      const bOutcome = await bInsert;
      const bCommit =
        bOutcome === 'inserted'
          ? await b
              .query('commit')
              .then(() => 'committed')
              .catch((e) => code(e))
          : (await b.query('rollback').catch(() => {}), bOutcome);

      const open = Number((await ctx.pool.query(ctx.openCountSql, [ctx.ownerId])).rows[0].n);
      step('—', `${level}: A ${aCommit}, B ${bCommit}, open deals now ${open}`);
      results[level] = { open, bCommit };
    }

    const rr = results['repeatable read'];
    const ser = results['serializable'];
    return {
      observed: `repeatable read → ${rr.open} open deals (B ${rr.bCommit}); serializable → ${ser.open} open deals (B ${ser.bCommit})`,
      pass: rr.open === 4 && ser.open === 3,
      note:
        'Write skew is the anomaly people are surprised by, because each transaction is ' +
        'individually correct: both read a valid state and wrote a row the other did not touch. ' +
        'No row lock helps — there is no shared row. Either the invariant becomes a database ' +
        'constraint, or the transaction runs at SERIALIZABLE with a retry.',
    };
  }
);

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------
const OPEN_COUNT_SQL = `select count(*)::int as n from deals where owner_id = $1 and closed_at is null`;
const INSERT_OPEN_SQL = `insert into deals (owner_id, title, company, stage, amount_cents)
                         values ($1, $2, 'Skew Co', 'sourced', 1000)`;

async function ensureOwner(pool) {
  // A dedicated owner, so nothing here touches seeded benchmark data. ON CONFLICT makes the
  // script re-runnable.
  const { rows } = await pool.query(
    `insert into users (name, email, password) values ('Isolation Demo', $1, 'x')
       on conflict (email) do update set updated_at = now()
     returning id`,
    [DEMO_EMAIL]
  );
  return rows[0].id;
}

async function main() {
  say(`isolation demo against ${DATABASE_URL.replace(/(:\/\/[^:]+:)[^@]+@/, '$1***@')}`);

  const pool = new pg.Client({ connectionString: DATABASE_URL });
  const a = new pg.Client({ connectionString: DATABASE_URL });
  const b = new pg.Client({ connectionString: DATABASE_URL });
  await Promise.all([pool.connect(), a.connect(), b.connect()]);

  // A statement timeout on the two participants, because these scenarios deliberately block
  // one session on another. Without it, a scenario that blocks in an unexpected place hangs
  // the script forever instead of failing with a diagnosis.
  await a.query("set statement_timeout = '10s'");
  await b.query("set statement_timeout = '10s'");

  const ownerId = await ensureOwner(pool);
  const results = [];

  const ctx = {
    pool,
    ownerId,
    openCountSql: OPEN_COUNT_SQL,
    insertOpenSql: INSERT_OPEN_SQL,
    cleanup: [],
    async makeDeal({ amount_cents }) {
      const { rows } = await pool.query(
        `insert into deals (owner_id, title, company, stage, amount_cents)
         values ($1, 'Isolation demo', 'Demo Co', 'sourced', $2) returning id`,
        [ownerId, amount_cents]
      );
      return rows[0].id;
    },
    async amount(id) {
      const { rows } = await pool.query('select amount_cents from deals where id = $1', [id]);
      return Number(rows[0].amount_cents);
    },
    async setAmount(id, value) {
      await pool.query('update deals set amount_cents = $1 where id = $2', [value, id]);
    },
    async resetOpenDeals(n) {
      await pool.query('delete from deals where owner_id = $1', [ownerId]);
      for (let i = 0; i < n; i++) await pool.query(INSERT_OPEN_SQL, [ownerId, `existing ${i}`]);
    },
  };

  try {
    for (const [i, s] of scenarios.entries()) {
      say('');
      say(`── ${i + 1}. ${s.name}`);
      say(`   expected: ${s.expected}`);

      let result;
      try {
        result = await s.fn(a, b, ctx);
      } catch (e) {
        // A scenario that throws is itself a finding — most likely a deadlock or a timeout in
        // a place the script did not anticipate. Recorded, not swallowed.
        result = { observed: `threw ${code(e)}: ${e.message}`, pass: false, note: '' };
        for (const client of [a, b]) await client.query('rollback').catch(() => {});
      }

      say(`   observed: ${result.observed}`);
      say(`   ${result.pass ? 'MATCHES the expectation' : '*** DOES NOT MATCH ***'}`);
      if (result.note) say(`   note: ${result.note}`);
      results.push({ ...s, ...result });
    }
  } finally {
    // Order matters: deals reference users, and the FK is ON DELETE RESTRICT.
    await pool.query('delete from deals where owner_id = $1', [ownerId]).catch(() => {});
    for (const [sql, params] of ctx.cleanup) await pool.query(sql, params).catch(() => {});
    await pool.query('delete from users where email = $1', [DEMO_EMAIL]).catch(() => {});
    await Promise.all([pool.end(), a.end(), b.end()]);
  }

  const failed = results.filter((r) => !r.pass);
  say('');
  say(`${results.length - failed.length}/${results.length} scenarios behaved as the code assumes`);
  if (failed.length) say(`MISMATCHED: ${failed.map((f) => f.name).join('; ')}`);

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${transcript.join('\n')}\n`);
  say(`transcript written to ${OUT}`);

  // Non-zero exit on a mismatch, so this can be a gate rather than a curiosity.
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`[isolation-demo] FAILED: ${e.message}\n`);
  process.exit(1);
});
