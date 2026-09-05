// ---------------------------------------------------------------------------
// Importing the app must not require a database (finding F-32).
//
// Both drivers used to be constructed at import time, and `neon()` throws when
// handed `undefined`. So importing anything that reached `#config/database.js` —
// most of `src/` — needed a DATABASE_URL even for a test that never issues a
// query. CI broke the moment `DATABASE_URL` was removed from the Tests workflow on
// the correct grounds that the suite does not talk to a database, and it passed
// locally only because a gitignored `.env` supplied the variable.
//
// This suite is the guard against that specific asymmetry: it runs the import with
// DATABASE_URL explicitly deleted, which is the CI environment rather than mine.
//
//   No database connection string was provided to `neon()`.
//   Perhaps an environment variable has not been set?
//
// The lesson worth keeping: a local environment that differs from CI is a test
// that has not run.
// ---------------------------------------------------------------------------
import { jest } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('database module without DATABASE_URL', () => {
  async function importWithoutUrl(extra = {}) {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', ...extra };
    delete process.env.DATABASE_URL;
    return import(`#config/database.js?bust=${Math.random()}`);
  }

  it('imports cleanly instead of throwing at module scope', async () => {
    const mod = await importWithoutUrl();
    expect(mod.db).toBeDefined();
  });

  it('throws a message that names the missing variable, on first use', async () => {
    const { db } = await importWithoutUrl();
    // A Proxy rather than null, so the failure happens at the point of use and
    // cannot be mistaken for a query error.
    expect(() => db.select()).toThrow(/DATABASE_URL is not set/);
  });

  it('reports no pool, and closing is a no-op', async () => {
    const mod = await importWithoutUrl();
    expect(mod.pool).toBeNull();
    expect(mod.poolStats()).toBeNull();
    await expect(mod.closeDatabase()).resolves.toMatchObject({ closed: false });
  });

  it('refuses to start in production without a URL', async () => {
    // A service that starts with no database and reports itself live is worse than
    // one that refuses to start. Same reasoning as JWT_SECRET (F-25).
    await expect(
      importWithoutUrl({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) })
    ).rejects.toThrow(/DATABASE_URL is required in production/);
  });

  it('the whole app still imports and serves without a database', async () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
    delete process.env.DATABASE_URL;

    const request = (await import('supertest')).default;
    const app = (await import(`#src/app.js?bust=${Math.random()}`)).default;

    // The exact case CI exercises: no database anywhere, and the routes that do not
    // need one must work.
    await request(app).get('/health').expect(200);
    await request(app).get('/api').expect(200);
    await request(app).get('/nope').expect(404);
  });
});
