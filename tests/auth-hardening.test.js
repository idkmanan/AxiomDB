// ---------------------------------------------------------------------------
// Auth hardening: the privilege escalation, the session-lifetime contradiction,
// and the forgeable default secret.
//
// All three were live in v0 and all three are the kind of defect that leaves the
// application working perfectly, which is why they need tests rather than a
// changelog entry.
// ---------------------------------------------------------------------------
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '#src/app.js';
import config from '#config/env.js';
import { cookies } from '#utils/cookies.js';
import { jwttoken } from '#utils/jwt.js';
import { signupSchema, signinSchema } from '#validations/auth.validation.js';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('signup cannot assign a role', () => {
  it('the schema has no role field at all', () => {
    // Not "role is validated" — role is absent. Privilege is not user input, so it
    // does not belong in a request schema.
    expect(Object.keys(signupSchema.shape)).toEqual(['name', 'email', 'password']);
  });

  it('rejects a role in the body loudly rather than stripping it silently', () => {
    const result = signupSchema.safeParse({
      name: 'Eve',
      email: 'eve@example.test',
      password: 'password1',
      role: 'admin',
    });

    // A non-strict object schema would strip `role` and report success — which
    // fixes the escalation but leaves nothing to assert on and nothing in the log.
    expect(result.success).toBe(false);
    expect(result.error.issues[0].code).toBe('unrecognized_keys');
    expect(result.error.issues[0].keys).toEqual(['role']);
  });

  it('POST /api/auth/sign-up with role=admin is a 400, before any user is created', async () => {
    // The v0 request that returned an admin JWT to an anonymous caller. It now
    // fails validation, so it never reaches the service and never touches the
    // database — which is also why this test needs no database.
    const res = await request(app).post('/api/auth/sign-up').send({
      name: 'Eve',
      email: 'eve-escalation@example.test',
      password: 'password1',
      role: 'admin',
    });

    expect(res.status).toBe(400);
    expect(res.body.errors).toMatch(/role/);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('signin also rejects unknown keys', () => {
    expect(
      signinSchema.safeParse({ email: 'a@b.test', password: 'x', role: 'admin' }).success
    ).toBe(false);
  });
});

describe('createUser ignores any role handed to it', () => {
  it('always writes role "user", even when a caller passes admin', async () => {
    // Defence in depth. The schema is the first gate; this is the second, and it is
    // the one that survives someone adding a new caller later. v0's signature was
    // `({name, password, email, role='user'})` — a safe default is no protection
    // when the caller overrides it.
    jest.resetModules();

    const captured = {};
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: async () => [],
      insert: () => chain,
      values: (v) => {
        captured.values = v;
        return chain;
      },
      returning: async () => [
        {
          id: 1,
          name: captured.values.name,
          email: captured.values.email,
          role: captured.values.role,
        },
      ],
    };

    jest.unstable_mockModule('#config/database.js', () => ({
      db: chain,
      closeDatabase: async () => ({ closed: false }),
      pingDatabase: async () => ({ ok: true }),
      poolStats: () => null,
      pool: null,
    }));

    const { createUser } = await import('#services/auth.service.js');
    const created = await createUser({
      name: 'Eve',
      email: 'eve2@example.test',
      password: 'password1',
      role: 'admin',
    });

    expect(captured.values.role).toBe('user');
    expect(created.role).toBe('user');
  });
});

describe('session lifetime is one value, not two', () => {
  it('the cookie maxAge and the JWT expiry agree exactly', () => {
    // The v0 defect: cookies.js:6 said 15 minutes, jwt.js:5 said '1d'. The browser
    // discarded the cookie after 15 minutes while the token stayed valid for
    // another 23h45m, with no revocation path — so a captured token was good for a
    // day and the short cookie created a false sense of a short session.
    const token = jwttoken.sign({ id: 1, email: 'a@b.test', role: 'user' });
    const decoded = jwt.decode(token);

    const tokenLifetimeMs = (decoded.exp - decoded.iat) * 1000;
    expect(tokenLifetimeMs).toBe(cookies.getOptions().maxAge);
    expect(tokenLifetimeMs).toBe(config.session.ttlMs);
  });

  it('defaults to 15 minutes, not a day', () => {
    expect(config.session.ttlMs).toBe(15 * 60 * 1000);
  });

  it('clearCookie is not sent a future maxAge, which would defeat the clear', () => {
    const captured = [];
    const res = {
      cookie: (...a) => captured.push(['cookie', ...a]),
      clearCookie: (...a) => captured.push(['clear', ...a]),
    };

    cookies.set(res, 'token', 'abc');
    cookies.clear(res, 'token');

    expect(captured[0][2]).toBe('abc');
    expect(captured[0][3].maxAge).toBe(config.session.ttlMs);
    expect(captured[1][2]).not.toHaveProperty('maxAge');
  });

  it('the cookie is httpOnly and sameSite=strict', () => {
    const opts = cookies.getOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('strict');
  });
});

describe('the JWT secret has no usable default in production', () => {
  it('config throws when JWT_SECRET is missing and NODE_ENV=production', async () => {
    // v0 fell back to a literal string committed in this repository. A production
    // deploy that forgot the variable would sign tokens with a publicly known key,
    // behave completely normally, and let anyone mint an admin token.
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'production' };
    delete process.env.JWT_SECRET;

    await expect(import(`#config/env.js?bust=${Math.random()}`)).rejects.toThrow(
      /JWT_SECRET is required in production/
    );
  });

  it('config throws when JWT_SECRET is too short in production', async () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'production', JWT_SECRET: 'short' };

    await expect(import(`#config/env.js?bust=${Math.random()}`)).rejects.toThrow(
      /at least 32 characters/
    );
  });

  it('accepts a long secret in production', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(32),
    };

    const mod = await import(`#config/env.js?bust=${Math.random()}`);
    expect(mod.default.session.jwtSecret).toBe('x'.repeat(32));
    expect(mod.default.session.usingInsecureDevSecret).toBe(false);
    // And the debug escape hatch cannot be switched on in production.
    expect(mod.default.exposeErrorDetails).toBe(false);
  });
});
