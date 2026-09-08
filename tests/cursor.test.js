// ---------------------------------------------------------------------------
// Keyset cursors.
//
// The cases below are the ones that decide whether pagination is CORRECT rather than
// merely fast: a cursor that loses precision skips rows, and a cursor that is trusted
// reaches Postgres as a type error and surfaces as a 500.
// ---------------------------------------------------------------------------
import { encodeCursor, decodeCursor } from '#utils/cursor.js';

describe('cursor round trip', () => {
  it('survives encode/decode with millisecond fidelity', () => {
    const row = { created_at: new Date('2026-09-05T10:11:12.345Z'), id: 987654 };
    const { createdAt, id } = decodeCursor(encodeCursor(row));

    expect(createdAt.toISOString()).toBe('2026-09-05T10:11:12.345Z');
    expect(id).toBe(987654);
  });

  it('is URL-safe, so no client has to percent-encode it', () => {
    // base64 (not base64url) would emit `+` and `/`, which survive most clients and
    // break the one that forgets — an intermittent "invalid cursor" that is impossible
    // to reproduce from a log.
    for (let i = 0; i < 200; i++) {
      const cursor = encodeCursor({ created_at: new Date(1e12 + i * 7919), id: i * 104729 + 1 });
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('carries the id, because created_at alone is not a total order (F-44)', () => {
    // Two rows in the same millisecond: the cursor must distinguish them, otherwise the
    // next page either repeats one or skips it. This asserts the property the schema
    // relies on rather than the encoding.
    const at = new Date('2026-09-05T10:11:12.345Z');
    expect(encodeCursor({ created_at: at, id: 1 })).not.toBe(
      encodeCursor({ created_at: at, id: 2 })
    );
  });

  it('accepts an epoch-millisecond number as well as a Date', () => {
    // The seeder and the explain script build cursors from raw SQL results, where a
    // timestamp may arrive as a number.
    expect(decodeCursor(encodeCursor({ created_at: 1757067072345, id: 5 })).id).toBe(5);
  });
});

describe('cursor validation', () => {
  const rejects = (value, label) => {
    it(`rejects ${label} with a 400, not a 500`, () => {
      let thrown;
      try {
        decodeCursor(value);
      } catch (e) {
        thrown = e;
      }
      // The whole point: a malformed cursor is a client error. Left unvalidated it
      // reaches Postgres as an out-of-range timestamp or a text-vs-bigint comparison,
      // and the client is told "Internal Server Error" for its own bad input.
      expect(thrown).toBeDefined();
      expect(thrown.statusCode).toBe(400);
      expect(thrown.code).toBe('INVALID_CURSOR');
    });
  };

  rejects('', 'an empty string');
  rejects('not-base64!!', 'a non-base64 value');
  rejects(Buffer.from('v2|1|1').toString('base64url'), 'an unknown cursor version');
  rejects(Buffer.from('v1|1').toString('base64url'), 'a cursor with a missing field');
  rejects(Buffer.from('v1|1|2|3').toString('base64url'), 'a cursor with an extra field');
  rejects(Buffer.from('v1|abc|1').toString('base64url'), 'a non-numeric timestamp');
  rejects(Buffer.from('v1|1.5|1').toString('base64url'), 'a fractional timestamp');
  rejects(Buffer.from('v1|1e3|1').toString('base64url'), 'exponential notation');
  rejects(Buffer.from('v1|99999999999999|1').toString('base64url'), 'a timestamp beyond range');
  rejects(Buffer.from('v1|-1|1').toString('base64url'), 'a negative timestamp');
  rejects(Buffer.from('v1|1|0').toString('base64url'), 'a zero id');
  rejects(Buffer.from('v1|1|-4').toString('base64url'), 'a negative id');
  rejects(
    Buffer.from(`v1|1|${Number.MAX_SAFE_INTEGER + 10}`).toString('base64url'),
    'an id past 2^53'
  );
  rejects('a'.repeat(200), 'an oversized value');
  rejects(null, 'null');
  rejects(42, 'a number');
});
