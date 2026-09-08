// ---------------------------------------------------------------------------
// The deals HTTP layer: authorization, routing order, and the concurrency contract as
// a client actually experiences it.
//
// The service is mocked here on purpose — its SQL is covered in tests/deals.test.js.
// What is being verified is the layer above: who may see what, which id becomes the
// owner, and whether a 409 carries enough for a client to recover without guessing.
// ---------------------------------------------------------------------------
import request from 'supertest';
import { jest } from '@jest/globals';

const calls = [];
const record =
  (name) =>
  (...args) => {
    calls.push({ name, args });
    return { name, args };
  };

/** A deal shaped like the service returns one. */
const deal = (over = {}) => ({
  id: 100,
  owner_id: 7,
  title: 'Acquire Initech',
  company: 'Initech',
  stage: 'sourced',
  amount_cents: 125000,
  currency: 'USD',
  version: 3,
  created_at: new Date('2026-09-05T10:00:00.000Z').toISOString(),
  updated_at: new Date('2026-09-05T10:00:00.000Z').toISOString(),
  closed_at: null,
  ...over,
});

/**
 * Boot the app with a stubbed deals service.
 *
 * `overrides` replaces individual service functions, so each test states only the
 * behaviour it cares about.
 *
 * NOTE ON THE COOKIES, which cost an hour to work out the first time: `jest.resetModules()`
 * gives the app a fresh module registry, and with `JWT_SECRET` unset
 * src/config/env.js GENERATES a per-process secret (finding F-25's fix). A per-registry
 * secret, in fact — so a token signed by a `#utils/jwt.js` imported at the top of this
 * file cannot be verified by the copy inside the app, and every request comes back 401
 * for a reason that looks nothing like the cause. The signer is therefore imported from
 * the same registry as the app.
 */
async function loadApp(overrides = {}) {
  jest.resetModules();
  calls.length = 0;

  const base = {
    listDeals: async (...a) => {
      record('listDeals')(...a);
      return {
        deals: [deal()],
        pagination: {
          limit: 20,
          returned: 1,
          hasMore: false,
          nextCursor: null,
          strategy: 'keyset',
        },
      };
    },
    listDealsPage: async (...a) => {
      record('listDealsPage')(...a);
      return {
        deals: [],
        pagination: { limit: 20, offset: 0, returned: 0, hasMore: false, strategy: 'offset' },
      };
    },
    getDealById: async (...a) => {
      record('getDealById')(...a);
      return deal();
    },
    createDeal: async (...a) => {
      record('createDeal')(...a);
      return deal({ version: 1 });
    },
    updateDeal: async (...a) => {
      record('updateDeal')(...a);
      return deal({ version: 4 });
    },
    advanceDealStage: async (...a) => {
      record('advanceDealStage')(...a);
      return deal({ stage: 'screening', version: 4 });
    },
    deleteDeal: async (...a) => {
      record('deleteDeal')(...a);
      return { success: true };
    },
    estimateDealCount: async () => 999501,
    pipelineSummary: async () => [{ stage: 'sourced', count: 2, total_cents: 500 }],
  };

  jest.unstable_mockModule('#services/deals.service.js', () => ({ ...base, ...overrides }));
  const { default: app } = await import('#src/app.js');
  const { jwttoken } = await import('#utils/jwt.js');

  const cookieFor = (user) => `token=${jwttoken.sign(user)}`;
  return {
    app,
    asUser: cookieFor({ id: 7, email: 'owner@example.test', role: 'user' }),
    asOther: cookieFor({ id: 8, email: 'other@example.test', role: 'user' }),
    asAdmin: cookieFor({ id: 1, email: 'admin@example.test', role: 'admin' }),
  };
}

const lastCall = (name) => calls.filter((c) => c.name === name).at(-1);

/** The most recently booted app's cookies, so each test can read `ctx.asUser`. */
let ctx;
async function boot(overrides) {
  ctx = await loadApp(overrides);
  return ctx.app;
}

describe('authentication and routing', () => {
  it('rejects an unauthenticated request before any service call', async () => {
    const app = await boot();
    await request(app).get('/api/deals').expect(401);
    expect(calls).toHaveLength(0);
  });

  it('routes /summary to the summary handler, not to /:id', async () => {
    // Express matches in registration order. Declared after `/:id`, `/summary` would be
    // captured by the id route, fail the digits-only regex and answer 400 — a routing bug
    // that presents as a validation error.
    const app = await boot();
    const res = await request(app).get('/api/deals/summary').set('Cookie', ctx.asUser).expect(200);

    expect(res.body.open_by_stage).toEqual([{ stage: 'sourced', count: 2, total_cents: 500 }]);
    // Named `total_estimated`, never `total`: it is reltuples, not a count (F-45).
    expect(res.body.total_estimated).toBe(999501);
  });

  it('carries the rate-limit headers, since the limiter runs after authenticate', async () => {
    const app = await boot();
    const res = await request(app).get('/api/deals').set('Cookie', ctx.asUser).expect(200);
    // The v0 defect was the opposite ordering: `req.user` was undefined at limiter time,
    // so every caller silently shared the guest bucket.
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});

describe('ownership scoping', () => {
  it('pins a non-admin to their own deals even when they ask for another owner', async () => {
    const app = await boot();
    await request(app).get('/api/deals?owner_id=999').set('Cookie', ctx.asUser).expect(200);

    // Scoped, not rejected: this is an authorization decision, not a validation error.
    expect(lastCall('listDeals').args[0].ownerId).toBe(7);
  });

  it('lets an admin list across owners, and filter by one', async () => {
    const app = await boot();

    await request(app).get('/api/deals').set('Cookie', ctx.asAdmin).expect(200);
    expect(lastCall('listDeals').args[0].ownerId).toBeUndefined();

    await request(app).get('/api/deals?owner_id=42').set('Cookie', ctx.asAdmin).expect(200);
    expect(lastCall('listDeals').args[0].ownerId).toBe(42);
  });

  it('dispatches to the offset strategy only when offset is supplied', async () => {
    const app = await boot();

    await request(app).get('/api/deals').set('Cookie', ctx.asUser).expect(200);
    expect(lastCall('listDealsPage')).toBeUndefined();

    await request(app).get('/api/deals?offset=100000').set('Cookie', ctx.asUser).expect(200);
    expect(lastCall('listDealsPage').args[0].offset).toBe(100000);
  });

  it('refuses an offset past the cap rather than scanning the table', async () => {
    // The deep-OFFSET path exists to be measured, not to be a caller-controlled scan of
    // a million rows. 100,000 is deep enough for the before/after to be unambiguous;
    // benchmarks/scripts/explain.mjs goes further because it talks to Postgres directly
    // rather than through a public endpoint.
    const app = await boot();
    await request(app).get('/api/deals?offset=950000').set('Cookie', ctx.asUser).expect(400);
  });

  it('answers 404, never 403, for a deal belonging to somebody else', async () => {
    const app = await boot();
    const res = await request(app).get('/api/deals/100').set('Cookie', ctx.asOther).expect(404);

    // A 403 would confirm the row exists, turning an id into an oracle for enumerating
    // another account's pipeline. Same reasoning as the identical 401 for "no such user"
    // and "wrong password".
    expect(res.body.message).toBe('Deal not found');
  });

  it('takes owner_id from the session and refuses it in the body', async () => {
    const app = await boot();

    const body = { title: 'A deal', company: 'Initech', amount_cents: 5000 };
    await request(app).post('/api/deals').set('Cookie', ctx.asUser).send(body).expect(201);
    expect(lastCall('createDeal').args[0].ownerId).toBe(7);

    // Finding F-23 generalised: a caller that tries to attribute a deal to someone else
    // is rejected by the strict schema rather than quietly overridden.
    await request(app)
      .post('/api/deals')
      .set('Cookie', ctx.asUser)
      .send({ ...body, owner_id: 999 })
      .expect(400);
  });
});

describe('the concurrency contract as a client sees it', () => {
  it('returns the version as an ETag on read and on write', async () => {
    const app = await boot();

    const read = await request(app).get('/api/deals/100').set('Cookie', ctx.asUser).expect(200);
    // Weak, because two responses at the same version are semantically equivalent but not
    // byte-identical — `updated_at` moves on an unrelated change. Claiming a strong
    // validator would be a lie a caching proxy might act on.
    expect(read.headers.etag).toBe('W/"3"');

    const written = await request(app)
      .put('/api/deals/100')
      .set('Cookie', ctx.asUser)
      .send({ title: 'Renamed deal', version: 3 })
      .expect(200);
    expect(written.headers.etag).toBe('W/"4"');
  });

  it('accepts the asserted version from If-Match', async () => {
    const app = await boot();

    await request(app)
      .put('/api/deals/100')
      .set('Cookie', ctx.asUser)
      .set('If-Match', 'W/"3"')
      .send({ title: 'Renamed deal' })
      .expect(200);

    expect(lastCall('updateDeal').args[2].expectedVersion).toBe(3);
    // A non-admin is scoped; an admin would pass `undefined`, which the service reads as
    // "no ownership predicate".
    expect(lastCall('updateDeal').args[2].ownerId).toBe(7);
  });

  it('rejects an If-Match that disagrees with the body instead of choosing one', async () => {
    const app = await boot();

    const res = await request(app)
      .put('/api/deals/100')
      .set('Cookie', ctx.asUser)
      .set('If-Match', 'W/"3"')
      .send({ title: 'Renamed deal', version: 9 })
      .expect(400);

    expect(res.body.errors.version).toMatch(/disagree/);
    expect(lastCall('updateDeal')).toBeUndefined();
  });

  it('rejects a malformed If-Match', async () => {
    const app = await boot();
    await request(app)
      .put('/api/deals/100')
      .set('Cookie', ctx.asUser)
      .set('If-Match', '*')
      .send({ title: 'Renamed deal' })
      .expect(400);
  });

  it('invents no version when the client asserted none', async () => {
    const app = await boot();
    await request(app)
      .put('/api/deals/100')
      .set('Cookie', ctx.asUser)
      .send({ title: 'Renamed deal' })
      .expect(200);

    // `undefined`, not a default. The service turns that into a 428 (see
    // tests/deals.test.js); what matters HERE is that the controller does not quietly
    // supply a version, which would turn a forgetful client into a last-writer-wins one.
    expect(lastCall('updateDeal').args[2].expectedVersion).toBeUndefined();
  });

  it('surfaces the current version on a 409 so a client can re-apply without a GET', async () => {
    const conflict = Object.assign(new Error('Deal was modified by someone else'), {
      statusCode: 409,
      code: 'VERSION_CONFLICT',
      currentVersion: 11,
    });
    const app = await boot({
      updateDeal: async () => {
        throw conflict;
      },
    });

    const res = await request(app)
      .put('/api/deals/100')
      .set('Cookie', ctx.asUser)
      .send({ title: 'Renamed deal', version: 3 })
      .expect(409);

    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.currentVersion).toBe(11);
    expect(res.body.requestId).toBeDefined();
  });

  it('tells a client which stages are legal when a transition is refused', async () => {
    const illegal = Object.assign(
      new Error('A deal in stage "sourced" cannot move to "closed_won"'),
      {
        statusCode: 409,
        code: 'ILLEGAL_STAGE_TRANSITION',
        currentStage: 'sourced',
        allowedStages: ['screening', 'closed_won', 'closed_lost'],
      }
    );
    const app = await boot({
      advanceDealStage: async () => {
        throw illegal;
      },
    });

    const res = await request(app)
      .post('/api/deals/100/stage')
      .set('Cookie', ctx.asUser)
      .send({ to: 'diligence' })
      .expect(409);

    // An error that says only "conflict" forces the client to guess. The allowed set is
    // the difference between a recoverable response and a support ticket.
    expect(res.body.currentStage).toBe('sourced');
    expect(res.body.allowedStages).toEqual(['screening', 'closed_won', 'closed_lost']);
  });
});
