// ---------------------------------------------------------------------------
// Transactions and the retry loop.
//
// Two claims are being verified here, and both are things the codebase has already been
// bitten by once:
//
//   * the retry recognises a serialization failure through drizzle's wrapper, not just
//     on a raw pg error (finding F-36 — the same bug shipped twice before)
//   * the WHOLE function is retried, not the failed statement, because a serialization
//     failure invalidates the snapshot the earlier reads came from
// ---------------------------------------------------------------------------
import { withTransaction, isRetryableTxError, backoffMs, RETRYABLE_SQLSTATES } from '#utils/tx.js';
import { fakeDb, allSql, drizzleWrappedPgError } from './helpers/fake-pg.js';

describe('isRetryableTxError', () => {
  it.each([...RETRYABLE_SQLSTATES])('retries %s when wrapped by drizzle', (code) => {
    expect(isRetryableTxError(drizzleWrappedPgError(code))).toBe(true);
  });

  it('also recognises the raw pg shape', () => {
    expect(isRetryableTxError(Object.assign(new Error('conflict'), { code: '40001' }))).toBe(true);
  });

  it.each(['23505', '23503', '22P02', undefined])('does not retry %s', (code) => {
    const err = code ? drizzleWrappedPgError(code) : new Error('something else');
    expect(isRetryableTxError(err)).toBe(false);
  });
});

describe('backoffMs', () => {
  it('is jittered within an exponentially growing ceiling', () => {
    // Full jitter, not fixed and not exponential-without-jitter: every conflicting
    // transaction fails at the same instant, so a deterministic delay makes them all
    // retry at the same instant and reproduce the conflict.
    for (const attempt of [0, 1, 2, 5]) {
      const ceiling = 10 * 2 ** attempt;
      const samples = Array.from({ length: 200 }, () => backoffMs(attempt, 10));
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...samples)).toBeLessThan(ceiling);
    }
  });
});

describe('withTransaction', () => {
  /** A db stand-in whose `transaction` runs the callback and can be made to fail. */
  function stubDb(behaviours) {
    const attempts = [];
    return {
      attempts,
      async transaction(fn, config) {
        const attempt = attempts.length;
        attempts.push({ config });
        const behaviour = behaviours[attempt] ?? 'ok';
        // The callback runs BEFORE the failure, exactly as a real transaction would:
        // reads happen, then the conflict is detected at write or commit time.
        const result = await fn({ marker: `tx-${attempt}` });
        if (behaviour !== 'ok') throw behaviour;
        return result;
      },
    };
  }

  it('retries the whole function, not the failed statement', async () => {
    // THE CLAIM. A serialization failure means the snapshot every read in that
    // transaction was taken from is no longer usable. Re-issuing only the write would
    // compute a new result from stale reads — the most common way a hand-rolled retry
    // makes correctness worse while making the error rate look better.
    const db = stubDb([drizzleWrappedPgError('40001'), drizzleWrappedPgError('40001')]);
    const seenExecutors = [];
    const delays = [];

    const result = await withTransaction(
      db,
      async (tx) => {
        seenExecutors.push(tx.marker);
        return 'done';
      },
      { wait: async (ms) => delays.push(ms) }
    );

    expect(result).toBe('done');
    // Three attempts, and the callback ran in full on each one — including its reads.
    expect(seenExecutors).toEqual(['tx-0', 'tx-1', 'tx-2']);
    expect(delays).toHaveLength(2);
  });

  it('does not retry an error that a retry cannot fix', async () => {
    const db = stubDb([drizzleWrappedPgError('23505')]);
    let calls = 0;

    await expect(
      withTransaction(db, async () => {
        calls += 1;
      })
    ).rejects.toThrow(/Failed query/);

    // A unique violation on retry is a unique violation again. Retrying it burns time
    // and sequence values to produce the same answer.
    expect(calls).toBe(1);
  });

  it('gives up with a 503 and keeps the cause', async () => {
    const conflict = drizzleWrappedPgError('40001');
    const db = stubDb([conflict, conflict, conflict]);

    let thrown;
    try {
      await withTransaction(db, async () => 'never', { wait: async () => {} });
    } catch (e) {
      thrown = e;
    }

    // 503, not 500: the request was valid and a later attempt may succeed, which is a
    // materially different instruction to the client than "we have a bug".
    expect(thrown.statusCode).toBe(503);
    expect(thrown.code).toBe('TX_RETRY_EXHAUSTED');
    expect(thrown.cause).toBe(conflict);
    expect(db.attempts).toHaveLength(3);
  });

  it('honours maxAttempts', async () => {
    const db = stubDb([drizzleWrappedPgError('40001'), drizzleWrappedPgError('40001')]);
    await expect(
      withTransaction(db, async () => 'x', { maxAttempts: 2, wait: async () => {} })
    ).rejects.toMatchObject({ code: 'TX_RETRY_EXHAUSTED' });
    expect(db.attempts).toHaveLength(2);
  });
});

describe('the SQL a transaction actually emits', () => {
  it('sets the isolation level on BEGIN when one is requested', async () => {
    const { db, queries } = fakeDb();

    await withTransaction(db, async (tx) => tx.execute('select 1'), {
      isolationLevel: 'serializable',
    });

    // Evidence rather than trust: the isolation level has to reach Postgres, and it does
    // so as part of BEGIN. A config object that drizzle ignored would leave the
    // transaction at READ COMMITTED while the code claimed serializable — a silent
    // correctness downgrade of exactly the kind F-38 was about.
    expect(allSql(queries)).toMatch(/begin isolation level serializable/);
    expect(allSql(queries)).toMatch(/commit/);
  });

  it('adds no extra round trip when no isolation level is set', async () => {
    const { db, queries } = fakeDb();

    await withTransaction(db, async (tx) => tx.execute('select 1'));

    expect(queries.map((q) => q.text.trim().toLowerCase())).toEqual([
      'begin',
      'select 1',
      'commit',
    ]);
  });

  it('rolls back when the callback throws', async () => {
    const { db, queries } = fakeDb();

    await expect(
      withTransaction(db, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(allSql(queries)).toMatch(/rollback/);
    expect(allSql(queries)).not.toMatch(/commit/);
  });
});
