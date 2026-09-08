# Interview notes — phases 3, 4, 5 and 7

One document for four phases, by decision: the per-phase Q&A form used in Phases 0 and
1 was costing more than the code by the end, and this project's value is defensible
claims rather than volume. Every answer below points at a file, a finding id, or a
script that produces the evidence.

The honest framing to open with: **the mechanisms are implemented and unit-tested
offline; the numbers are not collected yet.** The sandbox this was built in has no
Docker, no Redis, no Kafka and no npm registry, so everything requiring a real service
is a committed script rather than a result. See PROJECT_LIFECYCLE.md, "Not verified
here".

---

## 1. Why a second entity at all?

`users` cannot demonstrate anything about data access. Phase 0 measured its unbounded
list scan at 2.20 ms total, of which 0.335 ms was execution against 21 shared-buffer
hits — entirely cached (F-04). An index there would have improved nothing, and the fix
that mattered was pagination, because the cost was Node-side serialisation (167 KiB,
7.36 ms of `JSON.stringify`).

`deals` is seeded to 1,000,000 rows and written on every pipeline advance, so index
choice, pagination strategy and locking policy become measurable rather than asserted.
That is the whole reason it exists.

## 2. What is actually wrong with `OFFSET`?

Two things, and only one of them is about speed.

`OFFSET 950000 LIMIT 20` does not skip 950,000 rows, it reads them in order and
discards them. The work is linear in the depth, so page one and page 47,500 differ by
five orders of magnitude of I/O for an identically sized response.

The correctness problem is independent: a row inserted while a client is paging shifts
every subsequent offset, so the client sees a row twice or never. Keyset pagination
fixes that as a side effect of anchoring on a value rather than a position.

The OFFSET path is deliberately still reachable (`GET /api/deals?offset=…`, capped at
100,000) because a before/after claim needs both halves runnable through the same stack
by the same k6 script. `benchmarks/scripts/explain.mjs` captures both plans.

## 3. Why is the keyset predicate a row comparison?

```sql
WHERE (created_at, id) < ($1::timestamptz, $2::bigint)
```

The usual form is `created_at < $1 OR (created_at = $1 AND id < $2)`, which is
logically identical and considerably worse: Postgres cannot use an OR-chain as a single
index qualifier, so it filters rather than seeks. A row constructor is directly usable
against a multicolumn btree — it is the form that turns "the next 20 rows" into 20 rows
of work regardless of depth.

The explicit casts matter too: without them the parameter types in a row comparison are
inferred, and an inference resolving `$1` to `text` compares timestamps lexically —
which mostly works and stops working across a timezone or precision boundary.

## 4. The best finding in Phase 3 — an index that looks right and is not

**F-47.** `ORDER BY x DESC` means `NULLS FIRST` in SQL. drizzle emits index definitions
as `DESC NULLS LAST`. Postgres matches an index to a requested ordering by comparing
pathkeys, and null placement is part of that comparison — it does not reason about the
columns being `NOT NULL`.

So the obvious code — `orderBy(desc(deals.created_at), desc(deals.id))` — produces a
plan with an explicit Sort node above a full scan of a million rows, while the index
built for that exact query sits unused. The service spells the ordering out to match
the index character for character, `tests/deals.test.js` asserts the rendered SQL, and
`explain-summary.md` has a `Sort node` column so a regression shows up in the plan
rather than in a latency graph nobody can attribute.

The related trap worth knowing: a plain ascending index *can* serve `ORDER BY x DESC`
by being scanned backwards — but only while every column in the ORDER BY points the same
way. The moment one is mixed (`created_at DESC, id ASC`), no single-direction index can
serve it.

## 5. Why does the cursor carry a timestamp *and* an id?

`created_at` is not unique — the seeder alone writes thousands of rows per second — and
a keyset cursor over a non-unique sort key either skips rows or returns them twice
(F-44). The tiebreaker makes the ordering total, which is what the cursor arithmetic
assumes.

And the subtler one, **F-46**: Postgres timestamps default to microsecond precision, a
JavaScript `Date` holds milliseconds, and node-postgres returns a `Date`. So the value
read back is already truncated, and a cursor built from it points at a different instant
than the row it came from — skipping every row inside the gap. The fix is to declare the
column `timestamptz(3)` so the round trip is lossless. It cannot be reproduced at low
write rates, which is exactly why it survives review.

## 6. "Phase 1 said a transaction would fix the signup race. Did it?"

No, and that is the most useful thing in Phase 3 (**F-41**).

At READ COMMITTED — the Postgres default — each statement takes a fresh snapshot of
*committed* data. An uncommitted INSERT in another session is invisible. So both callers
run the existence check, both see nothing, both INSERT, and one fails at COMMIT.
`BEGIN` changes the timing of the failure and nothing about its existence.

What actually prevents the duplicate is the unique index. So the check was **deleted**
rather than wrapped: the 23505 handler stops being a fallback for a lost race and
becomes the primary path, and signup loses a round trip. SERIALIZABLE would also detect
it — with a 40001 that has to be retried — for a case an index already handles
perfectly.

`scripts/db/isolation-demo.mjs` runs it with two real sessions and prints the
interleaving, alongside lost updates at READ COMMITTED, the version column turning that
into a 409, `FOR UPDATE` serialising the writers instead, non-repeatable reads, and
write skew that REPEATABLE READ permits and SERIALIZABLE aborts.

## 7. Optimistic or pessimistic locking?

Both, on different paths, because the question is what the decision depends on.

`updateDeal` is optimistic: one statement, `WHERE id = $1 AND version = $2`, with
`version = version + 1` in the same statement. The client already read the row, so it
can assert which version it saw; no lock is held across a client round trip, and zero
rows affected means somebody else got there first — 409 with `currentVersion`, which is
enough to re-read, re-apply and retry.

`advanceDealStage` is pessimistic: `SELECT … FOR UPDATE` inside a transaction. The
request is "advance this deal", not "set stage to X if version is 7" — whether the move
is legal depends on the *current* value, which the client may never have read. There is
nothing for an optimistic check to check against, and inventing one (read, compare,
write) is the read-modify-write race with extra steps.

The discipline that makes the lock acceptable: it is taken and released inside one
transaction, on the server, with no network round trip to a client in between.
`SELECT FOR UPDATE` spanning a user's thinking time is the version people mean when they
say pessimistic locking does not scale — a different design, not a different primitive.

## 8. Why is there no exact total on the list endpoint?

`SELECT count(*)` reads every visible row, because MVCC keeps no authoritative counter —
"how many rows are there" has a different answer per snapshot (**F-45**). At 1,001 rows
that is 2.20 ms and nobody notices, which is why the users endpoint still does it,
labelled. At 1M it is a full scan per page request, and a paginated endpoint that reports
an exact total is often slower than the page it returns.

`GET /api/deals/summary` reports `total_estimated` from `pg_class.reltuples` — the
planner's own estimate, maintained by ANALYZE. It is wrong by design, so the field says
so; `-1` (never analysed) is reported as `null` rather than as 0, because a UI renders 0
as "no results".

## 9. Phase 4's claim was "rate limiting proven correct across replicas". Prove it.

`scripts/redis/limiter-proof.mjs` starts three Express apps, each with the real limiter
middleware and its **own** store object, and drives `limit × 3 + 20` requests
round-robin. With the in-process store it reports roughly `3 × limit` allowed; with the
Redis store, exactly `limit`. The script exits non-zero if either half fails to
reproduce.

That the swap was one file is the Phase 1 payoff: the contract was defined as
`hit(key, limit, windowMs) → LimitDecision` and made async even though the in-process
version had no need to be, so the middleware, the policies, the headers and the
fail-open/fail-closed decision are untouched.

## 10. Why Lua, and why does the clock come from Redis?

The algorithm is read-decide-write: expire old hits, count what is left, decide, and
only then record. The decision depends on the count, so the count must be read and acted
on without another client interleaving.

`MULTI/EXEC` is atomic but cannot branch — it pipelines commands and returns all replies
at the end — so a MULTI version has to `ZADD` unconditionally and remove the entry if it
turns out to be over the limit. That is not equivalent: it briefly counts a rejected
request, and under sustained rejection it keeps extending the window, turning a rate
limit into an escalating ban.

The clock comes from `redis.call('TIME')` because three app replicas have three clocks.
NTP skew of 50 ms means they disagree about where the window starts, and an application
clock that jumps backwards lets a caller reset their own window. Redis is the
serialization point for the counter, so it is the right clock for it.

One more trap: the sorted-set member must be unique per request (**F-48**). Using the
timestamp — the obvious choice — means `ZADD` updates an existing member's score rather
than adding an entry, so two requests in the same millisecond count once. It undercounts
precisely under the load where the limit matters.

## 11. What does refresh-token rotation actually buy?

Phase 1 left a 15-minute access token with no refresh and no revocation. The naive fix —
a longer-lived JWT — makes the original defect worse, because a bearer token cannot be
withdrawn. So the long-lived credential is deliberately not a JWT: it is 32 random bytes
whose only meaning is a row in Redis, which means it can be deleted.

Four properties, each with a mechanism:

- **hashed at rest** — Redis holds SHA-256, never the token, so a dump, a `--bigkeys`
  scan or a backup on the wrong bucket yields nothing usable. SHA-256 rather than bcrypt
  because the input is 256 bits of entropy we generated; the slow-hash argument applies
  to human-chosen passwords.
- **rotated** — every successful refresh invalidates the presented token atomically,
  inside one Lua script, so two concurrent refreshes cannot both mint a child and fork
  the family.
- **reuse detected** — presenting an already-rotated token means two parties hold the
  chain. The response is to revoke the whole *family*, because there is no way to tell
  the thief from the victim and letting the thief keep the newest token is exactly the
  wrong guess.
- **capped** — rotation with a fresh TTL each time is an eternal session. A `live` key is
  set once at login and never extended; rotation reads its remaining PTTL and gives the
  new token exactly that.

The access token now carries a `jti`, and sign-out writes it to a denylist with a TTL
equal to the token's remaining life — so the denylist can never grow past the number of
revocations in one token lifetime. That check fails **open**: failing closed would 401
every authenticated request during a Redis blip, while failing open leaves a revoked
token working for at most its remaining minutes. It is counted, which is the difference
from Arcjet failing open silently (F-07).

## 12. Why is a Redis lock not enough, and what makes it safe here?

**F-50.** A lock with a timeout cannot make an external side effect exclusive. A holder
paused past its TTL — GC, hypervisor migration, a suspended container — resumes believing
it still holds the lock while another process legitimately holds it. Both write; the lock
was working correctly the whole time. Redlock adds nodes and does not address this,
because the flaw is that the lock and the resource are different systems and the resource
never checks.

The fix is a fencing token validated *by the resource*, and this codebase already has
one: `deals.version`. Every write is `WHERE id = $1 AND version = $2`, so a resumed
process holding a stale version updates zero rows and gets a 409. Postgres is the
arbiter. The Redis lock is therefore used only as an optimisation — keeping the publisher
single-writer for ordering — and never for correctness, which is the only role a lock
with a TTL should be given.

## 13. Explain the dual-write problem in one paragraph, then your fix.

Persisting a deal and publishing its event are two systems, and there is no ordering of
the two calls that is correct: publish first and a database failure announces a deal that
does not exist; write first and a broker failure loses the event silently, after the
client already has its 201. `try/catch` does not help because the failure can happen
between them.

The fix: write the event to a table in the **same transaction** as the domain change, so
one atomic commit covers both. A separate publisher polls that table with
`FOR UPDATE SKIP LOCKED` and sends to Kafka, holding the transaction across the send —
so a publisher that dies mid-send releases its rows and the next attempt re-sends them.
At-least-once, by construction, which is why the consumer must deduplicate.

`scripts/events/outbox-drill.mjs` proves it with the broker stopped: every write succeeds,
every event queues, and the backlog drains on its own when Kafka returns. With the broker
up, an outbox and a dual write look identical — stopping it is the only way to see the
difference.

## 14. How is the consumer idempotent, and why is that not just a `SET` in Redis?

Each event is claimed by inserting `(consumer_group, event_id)` into `processed_events`
with `ON CONFLICT DO NOTHING`, **in the same transaction as the handler's own writes**.
Zero rows inserted means "already handled" and the handler is skipped. The claim and the
effect commit together or not at all.

A Redis marker would be a second system again: the consumer could commit its work and
then fail to record that it did, and the redelivery would duplicate the effect. That is
the dual-write problem reappearing one layer down, inside the fix for the dual-write
problem — which is a genuinely easy mistake to make while implementing it.

The primary key is `(consumer_group, event_id)` because two groups must each be able to
process the same event; they do different things with it.

## 15. What stops one bad message from stopping the pipeline?

Kafka delivers a partition in order, so a message that always throws is retried forever
and everything behind it waits — the most common way an event pipeline stops without
anybody noticing that it stopped.

After `CONSUMER_MAX_ATTEMPTS` the event is produced to a real DLQ topic with the failure
in headers, and `handleMessage` **resolves** rather than throwing, which is what lets
kafkajs commit the offset and move on. The payload is forwarded unchanged so it can be
replayed into the main topic; a DLQ that rewrites the body cannot be, which defeats the
only purpose a DLQ has. Unparseable JSON goes straight there — retrying cannot make
invalid JSON valid.

The DLQ error header is built by walking the `cause` chain, not by reading
`error.message`. That is F-36 applied a third time: drizzle wraps handler failures in a
`DrizzleQueryError` whose own message is "Failed query: …", so recording the top-level
message parks the event with a diagnosis that names the statement and not the problem.

## 16. Why one publisher but three consumers?

Different constraints.

`FOR UPDATE SKIP LOCKED` lets N publishers claim disjoint rows safely, but two publishers
can still send row 2 before row 1 and reorder events for one aggregate, which defeats the
partition key. So the publisher is one replica, with a Redis lock covering the seconds
during a rolling deploy when two pods overlap — and `SKIP LOCKED` stays because the lock
is only an optimisation (F-50): Postgres refuses to hand the same row to both regardless.

Consumers scale with partitions, and no further. Kafka assigns each partition to exactly
one consumer in a group, so a fourth replica against three partitions is an idle process.
Scaling consumers means adding partitions first — and raising the partition count
re-hashes keys, so events for an aggregate stop landing in the partition holding their
history. It is not a free knob.

## 17. Three probes. What does each one answer?

- **startup** — "has it finished booting?" Pool pre-warming (F-39) runs before the
  listener opens, so startup is measurably longer than `app.listen`. Without a startup
  probe the liveness probe begins during boot and restarts a pod that was working
  perfectly, which looks exactly like a crash loop.
- **liveness** — "is this process able to serve at all?" In-process state only, no
  dependency check. A liveness probe that touched Postgres would restart every replica
  during a database blip, removing capacity for a problem restarting cannot fix.
- **readiness** — "should traffic come here?" This one does check the database, and flips
  to 503 the moment SIGTERM lands so the endpoints controller removes the pod before the
  listener closes.

Redis is reported by `/ready` but does not gate it. Failing readiness on a Redis outage
would take all three replicas out simultaneously — a cache blip escalated into a total
outage by the health check. The limiter's per-route policy already decides what to do
without Redis (ADR 0002).

## 18. Why is the HPA on CPU when you built a metrics endpoint?

Because a custom-metric HPA needs Prometheus plus `prometheus-adapter`, and that is two
deployments and a `ServiceMonitor` in a phase whose deliverable is a benchmark and a set
of drills (ADR 0008).

CPU is a defensible target *for this workload specifically*: bcrypt at cost 10 is 54.8 ms
per compare (F-05) and every path here is either bcrypt or a short indexed query, so CPU
is the binding constraint and tracks real load. That is not true in general — for an
I/O-bound service CPU stays flat while latency degrades and a CPU HPA never fires.

What is given up is real: requests-per-second reacts before CPU rises, which matters when
new pods take seconds to become ready. And scaling the *consumer* on backlog age is the
correct signal for a worker whose CPU is near zero while its queue grows — which is why
the consumer has no HPA and a fixed replica count equal to the partition count.

## 19. What would you do next?

In order, and each because of something above rather than because it is on a list:

1. **Collect the numbers.** Everything in this document that is a ratio is arithmetic
   until `npm run db:explain`, `npm run redis:proof:limiter` and `npm run bench:v7` have
   run. That is the honest gap.
2. **A retention job for `outbox` and `processed_events`.** Both grow forever. The
   partial index keeps the *queries* fast, which is exactly what would let the problem go
   unnoticed until the disk filled.
3. **Testcontainers integration tests** (Phase 8), which would close the gap the fakes
   leave: the Lua scripts and the real SQL are currently verified by scripts a human runs,
   not by CI.
4. **A consumer-lag metric read from the broker**, so the pipeline has a signal that does
   not depend on the consumer being alive to report it.
5. **Then** the custom-metric HPA, because by that point the metric it would scale on has
   a measured relationship to latency rather than an assumed one.
