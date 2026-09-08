// ---------------------------------------------------------------------------
// Deals: validation, and the SQL the service actually emits.
//
// The service assertions below read the rendered SQL rather than a recorded builder
// call, because the claims being made are claims about SQL:
//
//   * `desc nulls last` on both sort columns, so drizzle/0001_deals.sql's index is
//     usable instead of decorative (finding F-47)
//   * a row-value comparison for the keyset boundary, not an OR-chain
//   * `version = version + 1` together with a version predicate, in ONE statement
//   * `for update` inside a real begin/commit for the stage transition
//
// tests/helpers/fake-pg.js explains why the fake sits at the socket rather than at the
// query builder.
// ---------------------------------------------------------------------------
import { jest } from '@jest/globals';
import config from '#config/env.js';
import {
  dealIdSchema,
  listDealsQuerySchema,
  createDealSchema,
  updateDealSchema,
  advanceStageSchema,
} from '#validations/deals.validation.js';
import { decodeCursor, encodeCursor } from '#utils/cursor.js';
import { nextStages, DEAL_STAGES, TERMINAL_STAGES } from '#models/deal.model.js';
import { fakeDb, allSql } from './helpers/fake-pg.js';

/** Load the service with a fake database underneath it. */
async function loadService(results) {
  jest.resetModules();
  const fake = fakeDb({ results });
  jest.unstable_mockModule('#config/database.js', () => ({
    db: fake.db,
    pool: null,
    closeDatabase: async () => ({ closed: false }),
    pingDatabase: async () => ({ ok: true }),
    poolStats: () => null,
    prewarmPool: async () => ({ warmed: 0 }),
  }));
  const service = await import('#services/deals.service.js');
  return { service, ...fake };
}

const row = (over = {}) => ({
  id: 100,
  owner_id: 7,
  title: 'Acquire Initech',
  company: 'Initech',
  stage: 'sourced',
  amount_cents: 125000,
  currency: 'USD',
  version: 1,
  created_at: new Date('2026-09-05T10:00:00.000Z'),
  updated_at: new Date('2026-09-05T10:00:00.000Z'),
  closed_at: null,
  ...over,
});

describe('list query validation', () => {
  it('defaults to a bounded page', () => {
    expect(listDealsQuerySchema.parse({})).toEqual({ limit: config.pagination.defaultLimit });
  });

  it('rejects cursor and offset together instead of picking one', () => {
    // Silently preferring one would make the endpoint's behaviour depend on an
    // undocumented precedence rule, and the two strategies produce different pages from
    // the same data. A caller sending both has a bug.
    const result = listDealsQuerySchema.safeParse({ cursor: 'abc', offset: '20' });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/either cursor or offset/);
  });

  it('caps limit and offset', () => {
    expect(listDealsQuerySchema.safeParse({ limit: '1000000' }).success).toBe(false);
    // Deep OFFSET is the cost being demonstrated, so some of it is permitted — but an
    // unbounded offset is a caller-controlled scan, the same defect class as the
    // uncapped limit pagination itself introduced in Phase 1.
    expect(listDealsQuerySchema.safeParse({ offset: '100001' }).success).toBe(false);
    expect(listDealsQuerySchema.safeParse({ offset: '100000' }).success).toBe(true);
  });

  it('rejects an unknown stage and an unknown parameter', () => {
    expect(listDealsQuerySchema.safeParse({ stage: 'closed' }).success).toBe(false);
    expect(listDealsQuerySchema.safeParse({ stagee: 'sourced' }).success).toBe(false);
  });
});

describe('deal id validation', () => {
  it('bounds ids at what JSON can represent exactly', () => {
    // bigserial is 64-bit, but a JSON number is an IEEE-754 double: above 2^53-1 the
    // value a client receives is not the value the database holds.
    expect(dealIdSchema.safeParse({ id: '9007199254740991' }).success).toBe(true);
    expect(dealIdSchema.safeParse({ id: '9007199254740993' }).success).toBe(false);
  });

  it.each([['12abc'], [''], ['-1'], ['1.0'], ['0']])('rejects id=%s', (id) => {
    expect(dealIdSchema.safeParse({ id }).success).toBe(false);
  });
});

describe('create validation', () => {
  it('requires an integer number of cents', () => {
    // Accepting 19.99 here would invite a float through the one boundary the schema
    // exists to protect.
    expect(
      createDealSchema.safeParse({ title: 'A deal', company: 'X', amount_cents: '19.99' }).success
    ).toBe(false);
    expect(
      createDealSchema.parse({ title: 'A deal', company: 'X', amount_cents: '1999' }).amount_cents
    ).toBe(1999);
  });

  it('normalises currency and rejects anything that is not ISO-4217-shaped', () => {
    expect(
      createDealSchema.parse({ title: 'A deal', company: 'X', amount_cents: 1, currency: 'eur' })
        .currency
    ).toBe('EUR');
    expect(
      createDealSchema.safeParse({ title: 'A deal', company: 'X', amount_cents: 1, currency: 'US' })
        .success
    ).toBe(false);
    expect(
      createDealSchema.safeParse({
        title: 'A deal',
        company: 'X',
        amount_cents: 1,
        currency: 'US$',
      }).success
    ).toBe(false);
  });

  it('refuses to create a deal that is already closed', () => {
    // The CHECK constraint requires a closing timestamp for a terminal stage, and
    // inventing one for a deal that was never open is a fabricated audit trail.
    for (const stage of TERMINAL_STAGES) {
      expect(
        createDealSchema.safeParse({ title: 'A deal', company: 'X', amount_cents: 1, stage })
          .success
      ).toBe(false);
    }
    expect(
      createDealSchema.safeParse({
        title: 'A deal',
        company: 'X',
        amount_cents: 1,
        stage: 'diligence',
      }).success
    ).toBe(true);
  });

  it('never accepts owner_id, version or timestamps from the body', () => {
    // Finding F-23 generalised: a field the server owns must not be writable by the
    // caller. `strictObject` is what enforces it, so this test guards the schema TYPE
    // as much as the field list.
    for (const key of ['owner_id', 'version', 'created_at', 'updated_at', 'closed_at']) {
      expect(
        createDealSchema.safeParse({ title: 'A deal', company: 'X', amount_cents: 1, [key]: 1 })
          .success
      ).toBe(false);
    }
  });
});

describe('update validation', () => {
  it('requires at least one field besides the version', () => {
    expect(updateDealSchema.safeParse({ version: 3 }).success).toBe(false);
    expect(updateDealSchema.safeParse({ version: 3, title: 'Renamed deal' }).success).toBe(true);
  });

  it('does not default the version, because a default is last-writer-wins', () => {
    const parsed = updateDealSchema.parse({ title: 'Renamed deal' });
    expect(parsed.version).toBeUndefined();
  });
});

describe('the stage machine', () => {
  it('allows one step forward, or closing, and nothing else', () => {
    expect(nextStages('sourced')).toEqual(['screening', 'closed_won', 'closed_lost']);
    expect(nextStages('negotiation')).toEqual(['closed_won', 'closed_lost']);
  });

  it('is terminal once closed', () => {
    for (const stage of TERMINAL_STAGES) expect(nextStages(stage)).toEqual([]);
  });

  it('rejects a stage that is not in the enum', () => {
    expect(advanceStageSchema.safeParse({ to: 'won' }).success).toBe(false);
    for (const to of DEAL_STAGES) expect(advanceStageSchema.safeParse({ to }).success).toBe(true);
  });
});

describe('keyset pagination emits an index-usable query', () => {
  it('orders by both columns DESC NULLS LAST', async () => {
    const { service, queries } = await loadService([[row()]]);
    await service.listDeals({ limit: 20 });

    // FINDING F-47. `ORDER BY x DESC` means `NULLS FIRST` in SQL, while the index is
    // built `DESC NULLS LAST`. Postgres compares null placement when it matches an
    // index to a requested ordering, so the drizzle helper `desc()` would have produced
    // a Sort over a full scan while the index sat unused. This assertion is the guard.
    expect(queries[0].text.toLowerCase()).toContain(
      'order by "deals"."created_at" desc nulls last, "deals"."id" desc nulls last'
    );
  });

  it('asks for one row more than the page, so hasMore needs no COUNT', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => row({ id: 100 - i }));
    const { service, queries } = await loadService([rows]);

    const result = await service.listDeals({ limit: 20 });

    expect(queries[0].params).toContain(21);
    expect(result.deals).toHaveLength(20);
    expect(result.pagination.hasMore).toBe(true);
    // The 21st row is the probe, not data — returning it would give the client a page
    // one row longer than it asked for.
    expect(result.deals.map((d) => d.id)).not.toContain(80);
  });

  it('reports no next cursor on the last page', async () => {
    const { service } = await loadService([[row(), row({ id: 99 })]]);
    const result = await service.listDeals({ limit: 20 });

    expect(result.pagination.hasMore).toBe(false);
    // A cursor on the last page invites a client to keep polling an endpoint that will
    // only ever return zero rows.
    expect(result.pagination.nextCursor).toBeNull();
  });

  it('hands back a cursor that decodes to the last row of the page', async () => {
    const last = row({ id: 55, created_at: new Date('2026-09-04T08:07:06.123Z') });
    const rows = [...Array.from({ length: 20 }, () => row()).slice(0, 19), last, row({ id: 1 })];
    const { service } = await loadService([rows]);

    const result = await service.listDeals({ limit: 20 });
    expect(decodeCursor(result.pagination.nextCursor)).toEqual({
      createdAt: new Date('2026-09-04T08:07:06.123Z'),
      id: 55,
    });
  });

  it('expresses the page boundary as a row comparison with explicit casts', async () => {
    const { service, queries } = await loadService([[row()]]);
    const cursor = encodeCursor({ created_at: new Date('2026-09-05T10:00:00.000Z'), id: 100 });

    await service.listDeals({ limit: 20, cursor });

    const sql = queries[0].text.toLowerCase();
    // The row constructor is the form Postgres can push into a multicolumn index. The
    // equivalent OR-chain — `created_at < $1 or (created_at = $1 and id < $2)` — is
    // logically identical and filters instead of seeking.
    expect(sql).toContain('("deals"."created_at", "deals"."id") < ($1::timestamptz, $2::bigint)');
    expect(sql).not.toMatch(/ or /);
    expect(queries[0].params[0]).toEqual(new Date('2026-09-05T10:00:00.000Z'));
    expect(queries[0].params[1]).toBe(100);
  });

  it('rejects a tampered cursor before it reaches Postgres', async () => {
    const { service, queries } = await loadService([[row()]]);
    await expect(service.listDeals({ limit: 20, cursor: 'not-a-cursor' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_CURSOR',
    });
    expect(queries).toHaveLength(0);
  });

  it('adds closed_at IS NULL for an open stage, because the planner cannot infer it', async () => {
    const { service, queries } = await loadService([[row()]]);
    await service.listDeals({ limit: 20, stage: 'diligence' });

    // The CHECK constraint makes this predicate a tautology for a non-terminal stage, so
    // it adds no selectivity. It is there to make the PARTIAL index usable:
    // `predicate_implied_by()` reasons over the query's own qualifiers and does not
    // consult table CHECK constraints.
    expect(queries[0].text.toLowerCase()).toContain('"closed_at" is null');
  });

  it('omits it for a terminal stage, where it would exclude every matching row', async () => {
    const { service, queries } = await loadService([[row()]]);
    await service.listDeals({ limit: 20, stage: 'closed_won' });
    expect(queries[0].text.toLowerCase()).not.toContain('is null');
  });

  it('scopes to an owner when asked, so the composite index is the one used', async () => {
    const { service, queries } = await loadService([[row()]]);
    await service.listDeals({ limit: 20, ownerId: 7 });
    expect(queries[0].text.toLowerCase()).toContain('"owner_id" = $1');
  });
});

describe('offset pagination is kept as the comparison instrument', () => {
  it('emits OFFSET and says which strategy produced the page', async () => {
    const { service, queries } = await loadService([[row()]]);
    const result = await service.listDealsPage({ limit: 20, offset: 950000 });

    expect(queries[0].text.toLowerCase()).toContain('offset');
    expect(queries[0].params).toContain(950000);
    // Labelled in the response, so a benchmark result can never be attributed to the
    // wrong strategy after the fact.
    expect(result.pagination.strategy).toBe('offset');
  });
});

describe('optimistic concurrency on update', () => {
  it('is one statement carrying both the version check and the increment', async () => {
    const { service, queries } = await loadService([[row({ version: 2, title: 'Renamed' })]]);

    await service.updateDeal(100, { title: 'Renamed' }, { expectedVersion: 1 });

    const sql = queries[0].text.toLowerCase();
    expect(sql).toContain('"version" = "deals"."version" + 1');
    expect(sql).toContain('"version" = $');
    expect(sql).toContain('"updated_at" = now()');
    // One round trip on the happy path. The read-modify-write shape this replaced needed
    // two, and the first one was the race (F-42).
    expect(queries).toHaveLength(1);
  });

  it('refuses to update without a version at all', async () => {
    const { service, queries } = await loadService([]);

    // 428, not 400: the request is well-formed, it is the missing precondition that makes
    // it unsafe. And nothing is sent to the database — a default version would silently
    // turn a forgetful client into a last-writer-wins client.
    await expect(service.updateDeal(100, { title: 'x' }, {})).rejects.toMatchObject({
      statusCode: 428,
      code: 'VERSION_REQUIRED',
    });
    expect(queries).toHaveLength(0);
  });

  it('answers 409 with the current version when someone else got there first', async () => {
    // First query (the UPDATE) matches nothing; the disambiguating read finds the row at
    // a newer version.
    const { service, queries } = await loadService([[], [row({ version: 5 })]]);

    let thrown;
    try {
      await service.updateDeal(100, { title: 'x' }, { expectedVersion: 1 });
    } catch (e) {
      thrown = e;
    }

    expect(thrown.statusCode).toBe(409);
    expect(thrown.code).toBe('VERSION_CONFLICT');
    // Enough for the client to re-read, re-apply and retry without guessing.
    expect(thrown.currentVersion).toBe(5);
    // The second query exists only on the failure path, where it cannot affect
    // correctness.
    expect(queries).toHaveLength(2);
  });

  it('answers 404 when the row is gone, not 409', async () => {
    const { service } = await loadService([[], []]);
    await expect(
      service.updateDeal(100, { title: 'x' }, { expectedVersion: 1 })
    ).rejects.toMatchObject({ statusCode: 404, code: 'DEAL_NOT_FOUND' });
  });

  it('answers 404 — never 403 — for a deal owned by someone else', async () => {
    const { service, queries } = await loadService([[], [row({ owner_id: 999 })]]);

    await expect(
      service.updateDeal(100, { title: 'x' }, { expectedVersion: 1, ownerId: 7 })
    ).rejects.toMatchObject({ statusCode: 404 });

    // Ownership is part of the predicate, not a pre-read: a 403 would confirm the row
    // exists and turn an id into an oracle for another account's pipeline.
    expect(queries[0].text.toLowerCase()).toContain('"owner_id" = $');
  });
});

describe('pessimistic locking on the stage transition', () => {
  it('locks the row inside a transaction before deciding', async () => {
    const { service, queries } = await loadService([
      undefined, // begin
      [{ id: 100, stage: 'sourced', version: 1 }], // select … for update
      [row({ stage: 'screening', version: 2 })], // update … returning
      undefined, // commit
    ]);

    await service.advanceDealStage(100, 'screening');

    const sql = allSql(queries);
    expect(sql).toMatch(/begin/);
    // The lock is what makes the read and the decision atomic: a second caller blocks
    // until this transaction commits, then correctly sees the new stage.
    expect(sql).toMatch(/for update/);
    // And the event is written inside the same transaction as the stage change.
    expect(sql).toContain('insert into "outbox"');
    expect(sql).toMatch(/commit/);
    // NOT skip locked — "somebody else is moving this deal" must be answered, not
    // silently ignored. That is right for a work queue and wrong here.
    expect(sql).not.toMatch(/skip locked/);
  });

  it('sets closed_at when the transition is terminal, because a CHECK requires it', async () => {
    const { service, queries } = await loadService([
      undefined,
      [{ id: 100, stage: 'negotiation', version: 3 }],
      [row({ stage: 'closed_won', version: 4, closed_at: new Date() })],
      undefined,
    ]);

    await service.advanceDealStage(100, 'closed_won');
    expect(allSql(queries)).toContain('"closed_at" = now()');
  });

  it('refuses an illegal transition with the allowed set, and rolls back', async () => {
    const { service, queries } = await loadService([
      undefined,
      [{ id: 100, stage: 'sourced', version: 1 }],
    ]);

    let thrown;
    try {
      await service.advanceDealStage(100, 'diligence');
    } catch (e) {
      thrown = e;
    }

    expect(thrown.statusCode).toBe(409);
    expect(thrown.code).toBe('ILLEGAL_STAGE_TRANSITION');
    expect(thrown.currentStage).toBe('sourced');
    expect(thrown.allowedStages).toEqual(['screening', 'closed_won', 'closed_lost']);
    expect(allSql(queries)).toMatch(/rollback/);
  });

  it('answers 404 when the row does not exist or is not the caller’s', async () => {
    const { service } = await loadService([undefined, []]);
    await expect(service.advanceDealStage(100, 'screening', { ownerId: 7 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('the remaining write paths', () => {
  it('creates the deal and its event in one transaction, with no existence check', async () => {
    const { service, queries } = await loadService([
      undefined, // begin
      [row()], // insert into deals … returning
      [{ id: 1, event_id: 'e-1' }], // insert into outbox … returning
      undefined, // commit
    ]);

    await service.createDeal({ ownerId: 7, title: 'A deal', company: 'X', amountCents: 100 });

    const sql = allSql(queries);
    // No SELECT to confirm the owner exists: that would be check-then-act (F-41), would race a
    // concurrent account deletion, and would add a round trip to every write. The foreign key is
    // the authority.
    expect(sql).not.toContain('select');
    // Both writes inside ONE transaction. This is the dual-write fix: either the deal and its
    // event exist, or neither does. A publish after the commit could fail and lose the event
    // silently, after the client already had its 201.
    expect(queries[0].text.trim().toLowerCase()).toBe('begin');
    expect(sql).toContain('insert into "deals"');
    expect(sql).toContain('insert into "outbox"');
    expect(queries.at(-1).text.trim().toLowerCase()).toBe('commit');

    // Server-owned columns are filled by the COLUMN DEFAULT, not by a bound value: only owner_id,
    // title, company, amount_cents and currency are parameters, so `version`, `created_at`,
    // `updated_at` and `closed_at` cannot be influenced by a caller even if a future field list
    // forgets to strip them.
    expect(queries[1].params).toEqual([7, 'A deal', 'X', 100, 'USD']);
    expect(queries[1].text.toLowerCase()).toMatch(/values \(default, \$1, \$2, \$3, default/);
  });

  it('emits an event whose payload is the whole row', async () => {
    const { service, queries } = await loadService([
      undefined,
      [row({ id: 501 })],
      [{ id: 1, event_id: 'e-1' }],
      undefined,
    ]);

    await service.createDeal({ ownerId: 7, title: 'A deal', company: 'X', amountCents: 100 });

    const outboxInsert = queries.find((q) => q.text.includes('"outbox"'));
    // Keyed by aggregate so every event for one deal lands in one Kafka partition and stays
    // ordered; a payload of `{id}` would force consumers to call back into this service.
    expect(outboxInsert.params).toContain('deal');
    expect(outboxInsert.params).toContain('501');
    expect(outboxInsert.params).toContain('deal.created');
    expect(JSON.stringify(outboxInsert.params)).toContain('Acquire Initech');
  });

  it('deletes in one statement and 404s when nothing matched', async () => {
    const { service, queries } = await loadService([[]]);
    await expect(service.deleteDeal(100)).rejects.toMatchObject({ statusCode: 404 });
    expect(queries).toHaveLength(1);
  });

  it('reports an unanalysed table as null rather than as zero rows', async () => {
    // reltuples is -1 before the first ANALYZE. Reporting that as 0 would be a lie a UI
    // renders as "no results".
    const { service } = await loadService([[{ estimate: '-1' }]]);
    expect(await service.estimateDealCount()).toBeNull();
  });

  it('returns the planner estimate when the table has been analysed', async () => {
    const { service } = await loadService([[{ estimate: '999501' }]]);
    expect(await service.estimateDealCount()).toBe(999501);
  });
});
