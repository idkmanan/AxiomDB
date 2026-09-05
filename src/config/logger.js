// ---------------------------------------------------------------------------
// Structured logging.
//
// THE BUG THIS FILE EXISTED TO DEMONSTRATE (fixed in Phase 1):
//
//   format: winston.format.combine((
//     winston.format.timestamp(),
//     winston.format.errors({stack:true}),
//     winston.format.json()
//   )),
//
// The extra pair of parentheses makes the argument list a single comma
// expression. JavaScript evaluates `timestamp()` and `errors()`, discards both,
// and passes only `json()` to `combine`. So every log line was emitted with no
// timestamp and, worse, every logged Error lost its stack. Same bug again on the
// console transport at v0 logger.js:19.
//
// Verified rather than reasoned about, by running both variants against the
// installed winston:
//
//   BAD  (extra parens): {"a":1,"level":"info","message":"hello"}
//   GOOD (no parens):    {"a":1,"level":"info","message":"hello","timestamp":"…"}
//
// Worth dwelling on why this survived a code review: the code reads correctly,
// the app starts, logs appear, and the missing field is one a human skims past.
// Nothing fails. That is the shape of bug a test asserting on log OUTPUT catches
// and a test asserting that `logger.info` was called does not — which is why
// tests/logger.test.js inspects the formatted line.
// ---------------------------------------------------------------------------
import winston from 'winston';
import config from '#config/env.js';

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    // Without this, `logger.error('msg', err)` records the message and drops the
    // stack — which is exactly what the global error handler needs most.
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'acquisitions-api' },
  // File transports hold open descriptors, which under jest shows up as "Jest did
  // not exit one second after the test run completed" — an open handle that looks
  // like a leak in the code under test. Tests also have no business appending to
  // the same log file the app writes. So: no files under test, and the console
  // transport below is silenced there too, leaving the suite free to attach its
  // own capturing transport (tests/logging.test.js).
  transports: config.isTest
    ? []
    : [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
      ],
});

if (!config.isProduction) {
  logger.add(
    new winston.transports.Console({
      silent: config.isTest,
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    })
  );
}

export default logger;
