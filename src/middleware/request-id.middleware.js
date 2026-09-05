// ---------------------------------------------------------------------------
// Request identity.
//
// Every log line and every error response carries one id, so a user reporting
// "I got a 500" can be matched to a stack trace without the stack trace ever
// being sent to them.
//
// Phase 6 replaces the generated id with the W3C `traceparent` trace id so the
// same correlator spans HTTP -> Postgres -> Kafka -> consumer. The header name
// and the `req.id` contract stay the same, which is the point of adding it now.
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';

const HEADER = 'x-request-id';

// An inbound id is echoed into logs, so it is untrusted input. Unbounded or
// newline-bearing values allow log forging — an attacker splits a fake log
// record into the stream. Restrict to a conservative charset and length rather
// than sanitising after the fact.
const SAFE_ID = /^[A-Za-z0-9._~-]{1,128}$/;

export function requestId(req, res, next) {
  const inbound = req.get(HEADER);
  req.id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

export default requestId;
