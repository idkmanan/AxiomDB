// ---------------------------------------------------------------------------
// Logger output.
//
// The v0 bug was `winston.format.combine((a, b, c))` — an extra pair of
// parentheses making the argument list a comma expression, so `combine` received
// only its last argument and both `timestamp()` and `errors({stack:true})` were
// discarded.
//
// These tests assert on the FORMATTED LINE rather than on whether `logger.info`
// was called, and that distinction is the whole point. A mock-based test —
// `expect(logger.info).toHaveBeenCalledWith(...)` — passes identically with the
// bug present and with it fixed, because the bug is in the formatter, not the
// call. The first test below fails if the parentheses come back; the second
// reproduces the original defect so the evidence for it lives in the suite
// instead of only in a commit message.
// ---------------------------------------------------------------------------
import { Writable } from 'node:stream';
import winston from 'winston';
import logger from '#config/logger.js';

/** Collect whatever a winston Stream transport writes. */
function capture() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString().trim();
      if (text) lines.push(text);
      cb();
    },
  });
  return { lines, stream };
}

describe('the configured logger', () => {
  it('emits a timestamp and a stack trace', async () => {
    const { lines, stream } = capture();
    const transport = new winston.transports.Stream({ stream, level: 'error' });
    logger.add(transport);

    try {
      logger.error('boom', new Error('kaboom'));
      // winston writes through a stream, so give it a tick to flush.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      logger.remove(transport);
    }

    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[lines.length - 1]);

    // The two fields the comma-expression bug silently removed.
    expect(record).toHaveProperty('timestamp');
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
    expect(record).toHaveProperty('stack');
    expect(record.stack).toMatch(/kaboom/);

    // And the one that kept working, which is why nobody noticed.
    expect(record).toHaveProperty('service', 'acquisitions-api');
  });

  it('keeps structured metadata queryable as fields, not as a message string', async () => {
    const { lines, stream } = capture();
    const transport = new winston.transports.Stream({ stream, level: 'error' });
    logger.add(transport);

    try {
      logger.error('request', { status: 429, durationMs: 12.5, requestId: 'abc' });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      logger.remove(transport);
    }

    const record = JSON.parse(lines[lines.length - 1]);
    // This is what dropping morgan bought. v0 logged `"message": "127.0.0.1 - - \
    // [date] \"GET /api HTTP/1.1\" 200 42 …"` — one string that a log processor
    // cannot filter by status or duration.
    expect(record.status).toBe(429);
    expect(record.durationMs).toBe(12.5);
    expect(record.requestId).toBe('abc');
  });
});

describe('the v0 defect, reproduced', () => {
  it('combine((a, b, c)) discards every argument but the last', async () => {
    const { lines, stream } = capture();

    const buggy = winston.createLogger({
      level: 'info',
      // Verbatim v0 shape, and note that NO lint rule flags it. `no-sequences`
      // exists for exactly this mistake, but it treats a sequence wrapped in
      // explicit parentheses as deliberate — and the extra parentheses ARE the
      // bug. `no-unused-expressions` does not fire either, because this sits in a
      // call argument rather than an expression statement. Confirmed by running
      // both rules against this exact construct: zero reports.
      //
      // Which is the argument for this test existing: the defect is invisible to
      // the type of tooling you would expect to catch it, invisible in review
      // because the code reads correctly, and invisible at runtime because the
      // app starts and logs appear. The only thing that sees it is an assertion on
      // the formatted line.
      format: winston.format.combine(
        (winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json())
      ),
      transports: [new winston.transports.Stream({ stream })],
    });

    buggy.info('hello', { a: 1 });
    await new Promise((resolve) => setImmediate(resolve));

    const record = JSON.parse(lines[lines.length - 1]);
    expect(record).toEqual({ a: 1, level: 'info', message: 'hello' });
    expect(record.timestamp).toBeUndefined();
  });
});
