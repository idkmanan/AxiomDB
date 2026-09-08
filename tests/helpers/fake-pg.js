// ---------------------------------------------------------------------------
// A real drizzle instance over a fake pg client.
//
// WHY THIS RATHER THAN A HAND-ROLLED CHAIN MOCK. The tests that matter in Phase 3 are
// about the SQL that reaches Postgres: does the ORDER BY say `desc nulls last` so the
// index in drizzle/0001_deals.sql is usable (F-47), is the keyset boundary a row-value
// comparison rather than an OR-chain, does the optimistic update carry
// `version = version + 1` and a version predicate, does the stage transition issue
// `for update` inside a real `begin`/`commit`.
//
// A mock that records `.where()` calls cannot answer any of those, because it never
// renders SQL — and a test that asserts a builder was called is a test of the mock.
// Here drizzle is genuinely doing the work; only the socket is fake. `client.query`
// receives exactly what node-postgres would have sent, so `queries[i].text` is the
// evidence.
//
// This is also the F-31/F-36 lesson applied to test design: a test written from the same
// mental model as the code inherits its blind spots. Rendering the SQL steps outside that
// model.
// ---------------------------------------------------------------------------
import { drizzle } from 'drizzle-orm/node-postgres';

/**
 * @param {object} [opts]
 * @param {Array<Array<object>>|((q: {text: string, params: any[], index: number}) => Array<object>)} [opts.results]
 *   Rows to return, either per-call in order or as a function of the query. Anything
 *   unspecified resolves to an empty result, which is what a `RETURNING` clause looks
 *   like when a predicate matched nothing — the case most of these tests are about.
 */
export function fakeDb({ results = [] } = {}) {
  /** @type {Array<{text: string, params: any[]}>} */
  const queries = [];
  let index = 0;

  const client = {
    async query(config, values) {
      const text = typeof config === 'string' ? config : config.text;
      // node-postgres accepts parameters either on the config object or as a second
      // argument, and drizzle uses the SECOND — worth handling both, because a fake that
      // silently reports zero parameters makes every assertion about bound values pass
      // vacuously.
      const params = values ?? (typeof config === 'string' ? undefined : config.values) ?? [];
      queries.push({ text, params });

      const rows =
        typeof results === 'function' ? results({ text, params, index }) : results[index];
      index += 1;

      // ROW MODE MATTERS, and getting it wrong makes a fake that lies convincingly.
      // For a query with an explicit projection, drizzle asks node-postgres for
      // `rowMode: 'array'` and maps the positional arrays onto field names itself using
      // its own metadata. A fake that returns objects in that mode hands drizzle a row
      // whose "columns" are the object's property values in key order — so every mapped
      // field comes back `undefined`, and a test asserting on the returned row fails for
      // a reason that has nothing to do with the code under test.
      //
      // Tests therefore write rows as objects, in projection order, and this converts.
      const shaped = (rows ?? []).map((r) =>
        config?.rowMode === 'array' && !Array.isArray(r) ? Object.values(r) : r
      );

      return { rows: shaped, rowCount: shaped.length, fields: [], command: '' };
    },
  };

  return { db: drizzle(client), queries, client };
}

/** Concatenated SQL of every statement issued, lowercased — handy for one-line asserts. */
export function allSql(queries) {
  return queries
    .map((q) => q.text)
    .join('\n')
    .toLowerCase();
}

/**
 * A pg-shaped error wrapped the way drizzle actually rethrows it.
 *
 * Finding F-36: drizzle wraps every driver failure in a `DrizzleQueryError` whose own
 * message is "Failed query: …" and which carries no `code`. A test that throws a raw
 * pg error is testing a shape the application never sees — which is precisely how the
 * 23505 handler passed its unit test while returning 500 in production.
 */
export function drizzleWrappedPgError(code, message = 'db failure') {
  const pgErr = new Error(message);
  pgErr.code = code;
  pgErr.severity = 'ERROR';
  const wrapper = new Error('Failed query: select 1', { cause: pgErr });
  wrapper.name = 'DrizzleQueryError';
  return wrapper;
}

export default fakeDb;
