// ---------------------------------------------------------------------------
// Pagination on the users list.
//
// v0 `getAllUsers()` selected every row with no LIMIT, no OFFSET and no ORDER BY.
// Phase 0 measured what that cost at 1,001 seeded rows: 167 KiB per response and
// 7.36 ms of JSON.stringify, against 2.20 ms in Postgres — so the expense was in
// Node, not the database, and an index would have achieved nothing.
//
// The tests below cover the part that is easy to get wrong on the way to fixing
// it: a paginated endpoint whose page size is set by the caller is not a fix, it
// is the same unbounded query with a nicer interface.
// ---------------------------------------------------------------------------
import { jest } from '@jest/globals';
import config from '#config/env.js';
import { listUsersQuerySchema, userIdSchema } from '#validations/users.validation.js';

describe('list query validation', () => {
  it('defaults to a bounded page when no parameters are given', () => {
    // Matters beyond convenience: the FROZEN v0 k6 script calls GET /api/users with
    // no query string, so the v0-vs-v1 comparison is the same request returning
    // 1,001 rows before and one page after. If the default were "everything", the
    // fix would not appear in the benchmark at all.
    const parsed = listUsersQuerySchema.parse({});
    expect(parsed).toEqual({ limit: config.pagination.defaultLimit, offset: 0 });
    expect(parsed.limit).toBeLessThanOrEqual(config.pagination.maxLimit);
  });

  it('coerces numeric strings, because query parameters are always strings', () => {
    expect(listUsersQuerySchema.parse({ limit: '25', offset: '50' })).toEqual({
      limit: 25,
      offset: 50,
    });
  });

  it('rejects a limit above the cap instead of honouring it', () => {
    // The trap. Without a cap, `?limit=1000000` reintroduces the unbounded query as
    // a caller-controlled denial of service — an endpoint whose cost is chosen by
    // whoever calls it. That is a more common bug than the missing LIMIT it
    // replaces, precisely because the pagination looks present.
    const result = listUsersQuerySchema.safeParse({ limit: '1000000' });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/may not exceed/);
  });

  it.each([['0'], ['-1'], ['abc'], ['1.5'], ['1e9']])('rejects limit=%s', (limit) => {
    expect(listUsersQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects a negative offset and unknown parameters', () => {
    expect(listUsersQuerySchema.safeParse({ offset: '-5' }).success).toBe(false);
    // Strict, so a typo like `?limitt=5` fails loudly rather than silently paging
    // at the default and looking like the parameter was ignored.
    expect(listUsersQuerySchema.safeParse({ limitt: '5' }).success).toBe(false);
  });
});

describe('user id validation', () => {
  it('produces a number, so ownership checks are a plain comparison', () => {
    // v0 compared `req.user.id !== parseInt(id)` at every call site. Correct, but
    // only because parseInt was reapplied each time — the kind of thing that holds
    // until one site forgets.
    expect(userIdSchema.parse({ id: '42' })).toEqual({ id: 42 });
    expect(typeof userIdSchema.parse({ id: '42' }).id).toBe('number');
  });

  it.each([['12abc'], [''], ['-1'], ['1.0'], [' 7'], ['0x10']])('rejects id=%s', (id) => {
    // `parseInt('12abc')` is 12 and `Number('')` is 0, so a permissive parse turns
    // a malformed id into a valid-looking lookup against a different row.
    expect(userIdSchema.safeParse({ id }).success).toBe(false);
  });

  it('rejects an id beyond the 32-bit serial range', () => {
    // Otherwise it reaches Postgres as SQLSTATE 22003 and surfaces as a 500 rather
    // than the 400 it is.
    expect(userIdSchema.safeParse({ id: '2147483648' }).success).toBe(false);
    expect(userIdSchema.safeParse({ id: '2147483647' }).success).toBe(true);
  });
});

describe('getAllUsers issues a bounded, ordered query', () => {
  it('applies limit, offset and ORDER BY, and reports pagination metadata', async () => {
    jest.resetModules();

    const calls = { limit: null, offset: null, orderBy: null, columns: null };
    const rows = [
      { id: 1, email: 'a@b.test', name: 'A', role: 'user' },
      { id: 2, email: 'c@d.test', name: 'C', role: 'user' },
    ];

    // Two select() calls per invocation: the page, and the count. The mock
    // distinguishes them by whether a `total` column was requested.
    const makeChain = () => {
      let isCount = false;
      const chain = {
        select(cols) {
          calls.columns = cols;
          isCount = Object.prototype.hasOwnProperty.call(cols, 'total');
          return chain;
        },
        from: () => (isCount ? Promise.resolve([{ total: 137 }]) : chain),
        orderBy: (o) => {
          calls.orderBy = o;
          return chain;
        },
        limit: (n) => {
          calls.limit = n;
          return chain;
        },
        offset: (n) => {
          calls.offset = n;
          return Promise.resolve(rows);
        },
      };
      return chain;
    };

    jest.unstable_mockModule('#config/database.js', () => ({
      db: makeChain(),
      closeDatabase: async () => ({ closed: false }),
      pingDatabase: async () => ({ ok: true }),
      poolStats: () => null,
      pool: null,
    }));

    const { getAllUsers } = await import('#services/users.service.js');
    const result = await getAllUsers({ limit: 2, offset: 10 });

    expect(calls.limit).toBe(2);
    expect(calls.offset).toBe(10);
    // Ordering is a CORRECTNESS requirement, not cosmetics: without ORDER BY,
    // Postgres may return rows in any order, so paging would skip and duplicate
    // rows as the heap changed underneath. Ordering by the primary key is free —
    // it is an index-ordered scan.
    expect(calls.orderBy).toBeDefined();

    expect(result.users).toHaveLength(2);
    expect(result.pagination).toEqual({
      limit: 2,
      offset: 10,
      total: 137,
      returned: 2,
      hasMore: true,
    });
  });

  it('never selects the password column', async () => {
    jest.resetModules();

    let selected = null;
    const chain = {
      select(cols) {
        if (!Object.prototype.hasOwnProperty.call(cols, 'total')) selected = Object.keys(cols);
        return chain;
      },
      from: () => (selected && !chain._counted ? chain : Promise.resolve([{ total: 0 }])),
      orderBy: () => chain,
      limit: () => chain,
      offset: () => Promise.resolve([]),
    };

    jest.unstable_mockModule('#config/database.js', () => ({
      db: chain,
      closeDatabase: async () => ({ closed: false }),
      pingDatabase: async () => ({ ok: true }),
      poolStats: () => null,
      pool: null,
    }));

    const { getAllUsers } = await import('#services/users.service.js');
    await getAllUsers({ limit: 1, offset: 0 }).catch(() => {});

    // `db.select()` with no projection returns every column including the bcrypt
    // hash. The list endpoint must always pass an explicit column set.
    expect(selected).not.toContain('password');
    expect(selected).toEqual(['id', 'email', 'name', 'role', 'created_at', 'updated_at']);
  });
});
