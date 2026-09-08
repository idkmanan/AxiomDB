#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EXPLAIN (ANALYZE, BUFFERS) capture — the Phase 3 evidence.
//
//   node benchmarks/scripts/explain.mjs                 # writes benchmarks/v3-postgres/
//   node benchmarks/scripts/explain.mjs --depth 950000 --repeat 5
//
// WHAT THIS PRODUCES, and why it is the deliverable rather than a paragraph: for each
// query, the plan Postgres chose WITH the index and the plan it chose WITHOUT it, on the
// same 1M rows, in the same session, with buffer counts and execution times. A claim like
// "keyset pagination is O(page) and OFFSET is O(offset)" is either visible in those plans
// or it is not true here.
//
// THE TRICK THAT MAKES THE "WITHOUT" HALF SAFE: Postgres has transactional DDL, so
//
//   BEGIN; DROP INDEX …; EXPLAIN (ANALYZE) …; ROLLBACK;
//
// measures the query with the index genuinely absent and then puts it back. No rebuild, no
// window where the schema is wrong, no chance of leaving the database in a different state
// than it started. The one real cost is that DROP INDEX takes an ACCESS EXCLUSIVE lock on
// the table for the duration of the transaction, which is why this script is meant to run
// against a benchmark database with no other traffic.
//
// A note on what is NOT controlled: `jit`, `work_mem`, `shared_buffers` and
// `max_parallel_workers_per_gather` all change plans and timings. They are RECORDED in the
// output instead of being pinned, because a plan captured under settings nobody runs is a
// different kind of useless than a plan whose settings are unknown.
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const DEPTH = Number(getArg('depth', 950_000));
const PAGE = Number(getArg('page', 20));
const REPEAT = Number(getArg('repeat', 3));
const OUT_DIR = getArg('out', 'benchmarks/v3-postgres');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://bench:bench@localhost:5433/benchdb';

const log = (msg) => process.stdout.write(`[explain] ${msg}\n`);

/** The ORDER BY the application uses, character for character — see finding F-47. */
const ORDER = 'order by created_at desc nulls last, id desc nulls last';

/**
 * Build the query set. `anchor` is the sort key of the row at `DEPTH`, so the keyset query
 * asks for exactly the page the OFFSET query asks for — otherwise the comparison is
 * between two different pieces of work and the faster one wins for the wrong reason.
 */
function buildQueries(anchor, ownerId) {
  return [
    {
      name: 'offset-deep',
      // The instrument being replaced. OFFSET does not skip rows, it reads and discards
      // them, so the work is linear in the depth.
      sql: `select id, owner_id, title, company, stage, amount_cents, currency, version,
                   created_at, updated_at, closed_at
              from deals ${ORDER} limit ${PAGE} offset ${DEPTH}`,
      dropIndex: null,
    },
    {
      name: 'keyset-deep',
      // The same page, addressed by value. Expect an index scan reading ~PAGE rows
      // regardless of depth.
      sql: `select id, owner_id, title, company, stage, amount_cents, currency, version,
                   created_at, updated_at, closed_at
              from deals
             where (created_at, id) < ($1::timestamptz, $2::bigint)
             ${ORDER} limit ${PAGE}`,
      params: [anchor.created_at, anchor.id],
      dropIndex: 'deals_created_at_id_idx',
    },
    {
      name: 'keyset-first-page',
      // The control: if this and keyset-deep cost the same, depth-independence is shown
      // rather than argued.
      sql: `select id, created_at from deals ${ORDER} limit ${PAGE}`,
      dropIndex: 'deals_created_at_id_idx',
    },
    {
      name: 'keyset-owner-scoped',
      // Equality on owner_id then the sort key — the composite index in column order. This
      // is the hot query in production, because a non-admin caller is always scoped to
      // their own deals (src/controllers/deals.controller.js).
      sql: `select id, created_at from deals
             where owner_id = $1 and (created_at, id) < ($2::timestamptz, $3::bigint)
             ${ORDER} limit ${PAGE}`,
      params: [ownerId, anchor.created_at, anchor.id],
      dropIndex: 'deals_owner_created_id_idx',
    },
    {
      name: 'keyset-open-stage-partial',
      // `closed_at is null` is redundant against the CHECK constraint and mandatory for
      // the PARTIAL index to be usable — predicate_implied_by() reasons over the query's
      // own qualifiers, not over table constraints.
      sql: `select id, created_at from deals
             where stage = 'diligence' and closed_at is null
             ${ORDER} limit ${PAGE}`,
      dropIndex: 'deals_open_created_idx',
    },
    {
      name: 'pipeline-summary-groupby',
      // The honest counterexample: an aggregate over every open row has to read every open
      // row. No index fixes this; a materialised summary or an incremental counter does.
      sql: `select stage, count(*), coalesce(sum(amount_cents), 0)
              from deals where closed_at is null group by stage`,
      dropIndex: null,
    },
    {
      name: 'exact-count-star',
      // Finding F-45, as a plan rather than a claim: COUNT(*) reads every visible row
      // because MVCC keeps no authoritative counter.
      sql: 'select count(*) from deals',
      dropIndex: null,
    },
  ];
}

/** Median, because one slow run (an autovacuum, a checkpoint) should not set the number. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const timeOf = (plan) => {
  const m = /Execution Time: ([\d.]+) ms/.exec(plan);
  return m ? Number(m[1]) : NaN;
};
const planningOf = (plan) => {
  const m = /Planning Time: ([\d.]+) ms/.exec(plan);
  return m ? Number(m[1]) : NaN;
};
const buffersOf = (plan) => {
  // Sum every "shared hit=… read=…" line: hits come from the buffer cache, reads from the
  // OS. A query whose cost is 20 rows should touch a handful of pages; one that scans a
  // million touches tens of thousands, and that ratio is the claim.
  let hit = 0;
  let read = 0;
  for (const m of plan.matchAll(/shared hit=(\d+)(?: read=(\d+))?/g)) {
    hit += Number(m[1]);
    read += Number(m[2] ?? 0);
  }
  return { hit, read };
};
const firstNode = (plan) => plan.split('\n')[0].trim();
const usedSort = (plan) => /(^|\s)Sort\b/m.test(plan);
const usedSeqScan = (plan) => /Seq Scan/.test(plan);

async function explainOnce(client, { sql, params = [] }) {
  const { rows } = await client.query(
    { text: `explain (analyze, buffers, verbose) ${sql}`, rowMode: 'array' },
    params
  );
  return rows.map((r) => r[0]).join('\n');
}

/**
 * Run one query `REPEAT` times and keep the median plan.
 *
 * The first execution of a query on a cold cache is dominated by disk reads, which is a
 * real number but not a comparable one. Repeating and taking the median describes the
 * steady state, and the `read` counter in the output shows how much of the first run was
 * cache-filling.
 */
async function measure(client, query, { withoutIndex = false } = {}) {
  const plans = [];

  for (let i = 0; i < REPEAT; i++) {
    if (withoutIndex) {
      // Transactional DDL: the index is genuinely gone for the duration and genuinely back
      // afterwards. ACCESS EXCLUSIVE is held on `deals` inside this block.
      await client.query('begin');
      await client.query(`drop index ${query.dropIndex}`);
      plans.push(await explainOnce(client, query));
      await client.query('rollback');
    } else {
      plans.push(await explainOnce(client, query));
    }
  }

  const times = plans.map(timeOf);
  const med = median(times);
  const chosen = plans[times.indexOf(med)] ?? plans[0];

  return {
    executionMs: med,
    planningMs: median(plans.map(planningOf)),
    buffers: buffersOf(chosen),
    node: firstNode(chosen),
    sort: usedSort(chosen),
    seqScan: usedSeqScan(chosen),
    plan: chosen,
    allTimes: times,
  };
}

async function environment(client) {
  const { rows: version } = await client.query('select version()');
  const settings = [
    'shared_buffers',
    'work_mem',
    'effective_cache_size',
    'random_page_cost',
    'max_parallel_workers_per_gather',
    'jit',
    'track_io_timing',
  ];
  const { rows: gucs } = await client.query(
    `select name, setting, unit from pg_settings where name = any($1)`,
    [settings]
  );
  const { rows: size } = await client.query(
    `select (select count(*) from deals)::bigint as exact_rows,
            (select reltuples::bigint from pg_class where relname = 'deals') as reltuples,
            pg_size_pretty(pg_table_size('deals')) as heap,
            pg_size_pretty(pg_indexes_size('deals')) as indexes`
  );
  return { version: version[0].version, gucs, table: size[0] };
}

async function main() {
  log(`target: ${DATABASE_URL.replace(/(:\/\/[^:]+:)[^@]+@/, '$1***@')}`);
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const env = await environment(client);
    log(
      `rows: ${env.table.exact_rows} (reltuples ${env.table.reltuples}), heap ${env.table.heap}, indexes ${env.table.indexes}`
    );
    if (Number(env.table.exact_rows) < 100_000) {
      log('WARNING: fewer than 100k rows — the difference this script exists to show will be');
      log('         inside the noise. Run `npm run db:seed:deals` first.');
    }

    // The anchor: the sort key of the row at DEPTH. This is itself a deep OFFSET scan, and
    // it is setup rather than measurement.
    const { rows: anchorRows } = await client.query(
      `select created_at, id from deals ${ORDER} limit 1 offset $1`,
      [DEPTH]
    );
    if (anchorRows.length === 0)
      throw new Error(`fewer than ${DEPTH} rows — pass a smaller --depth`);
    const anchor = anchorRows[0];

    const { rows: ownerRows } = await client.query(
      'select owner_id, count(*) as n from deals group by owner_id order by n desc limit 1'
    );
    const ownerId = ownerRows[0].owner_id;
    log(
      `anchor: created_at=${anchor.created_at.toISOString()} id=${anchor.id}; busiest owner=${ownerId}`
    );

    mkdirSync(OUT_DIR, { recursive: true });
    const results = [];

    for (const query of buildQueries(anchor, ownerId)) {
      log(`measuring ${query.name}…`);
      const withIndex = await measure(client, query);
      const withoutIndex = query.dropIndex
        ? await measure(client, query, { withoutIndex: true })
        : null;

      results.push({ query, withIndex, withoutIndex });

      const body = [
        `# ${query.name}`,
        '',
        `SQL:${query.sql}`,
        query.params ? `PARAMS: ${JSON.stringify(query.params)}` : '',
        '',
        `-- WITH INDEX ${query.dropIndex ? `(${query.dropIndex})` : '(no index dropped for this query)'}`,
        `-- median execution ${withIndex.executionMs} ms over ${REPEAT} runs: ${withIndex.allTimes.join(', ')}`,
        withIndex.plan,
        '',
      ];
      if (withoutIndex) {
        body.push(
          `-- WITHOUT ${query.dropIndex} (dropped inside a transaction, rolled back)`,
          `-- median execution ${withoutIndex.executionMs} ms over ${REPEAT} runs: ${withoutIndex.allTimes.join(', ')}`,
          withoutIndex.plan,
          ''
        );
      }
      writeFileSync(
        path.join(OUT_DIR, `explain-${query.name}.txt`),
        body.filter(Boolean).join('\n')
      );
    }

    writeFileSync(path.join(OUT_DIR, 'explain-summary.md'), renderSummary(env, results));
    log(`wrote ${results.length} plans plus explain-summary.md to ${OUT_DIR}/`);
  } finally {
    await client.end();
  }
}

function renderSummary(env, results) {
  const row = (r) => {
    const w = r.withIndex;
    const o = r.withoutIndex;
    const ratio = o && w.executionMs > 0 ? (o.executionMs / w.executionMs).toFixed(1) : '—';
    return `| \`${r.query.name}\` | ${w.executionMs} | ${o ? o.executionMs : '—'} | ${ratio} | ${w.buffers.hit + w.buffers.read} | ${o ? o.buffers.hit + o.buffers.read : '—'} | ${w.sort ? 'yes' : 'no'} | ${w.seqScan ? 'yes' : 'no'} |`;
  };

  const offsetDeep = results.find((r) => r.query.name === 'offset-deep');
  const keysetDeep = results.find((r) => r.query.name === 'keyset-deep');
  const headline =
    offsetDeep && keysetDeep && keysetDeep.withIndex.executionMs > 0
      ? `${(offsetDeep.withIndex.executionMs / keysetDeep.withIndex.executionMs).toFixed(1)}x`
      : 'not computed';

  return `# Phase 3 — query plans at ${env.table.exact_rows} rows

Generated by \`benchmarks/scripts/explain.mjs\`. Every number is the median of ${REPEAT}
runs of \`EXPLAIN (ANALYZE, BUFFERS, VERBOSE)\`; the full plans are in the
\`explain-*.txt\` files beside this one.

**Deep page, OFFSET vs keyset: ${headline}** — \`offset-deep\` and \`keyset-deep\` return the
same 20 rows at depth ${DEPTH}.

| query | ms (index) | ms (no index) | ratio | buffers (index) | buffers (no index) | Sort node | Seq Scan |
|---|---|---|---|---|---|---|---|
${results.map(row).join('\n')}

"no index" means the index named in the script was dropped inside a transaction that was
then rolled back — the query is measured with it genuinely absent. A dash means no index
was dropped for that query.

The \`Sort node\` column is the one to read for finding F-47: a Sort above a scan on a
keyset query means the ORDER BY did not match the index and Postgres sorted the whole
result instead of walking it in order.

## Environment

${env.version}

| setting | value |
|---|---|
${env.gucs.map((g) => `| ${g.name} | ${g.setting}${g.unit ? ` ${g.unit}` : ''} |`).join('\n')}

Table: heap ${env.table.heap}, indexes ${env.table.indexes}, exact rows
${env.table.exact_rows}, \`reltuples\` estimate ${env.table.reltuples}.
`;
}

main().catch((e) => {
  process.stderr.write(`[explain] FAILED: ${e.message}\n`);
  process.exit(1);
});
