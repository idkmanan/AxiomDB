# Phase 1 — interview preparation

Questions a competent interviewer will ask about the correctness-and-security work,
and what makes a strong answer. Ordered roughly by how likely they are to come up.

**Read this caveat first, because it is also the answer to a question.** Phase 1 has
no performance numbers yet. The v1 matrix has not run — `benchmarks/v1-correctness/`
is empty by design — so every figure quoted below is either a **v0 measurement**,
explicitly labelled, or a **test result**. The throughput improvement implied by
deleting ~75 ms of CPU per request is an *expectation*, not a result, and saying so
unprompted is worth more than a number you cannot regenerate. Phase 0 held exactly
this position for two days.

What Phase 1 can defend today: the defects are fixed, each with a test that fails if
the defect returns, and the ordering of the work came from measurement rather than
instinct.

---

## 1. "You deleted your security dependency. Walk me through that."

The headline of the phase, and the framing matters more than the diff:

> The largest single performance win in this phase is a deletion, and the reason for
> the deletion is a security finding rather than a performance one.

Phase 0 measured Arcjet at roughly **75 ms of CPU per request** — 87.39% of p95 at
5 VUs and 45–67% of throughput at every concurrency level. That alone would justify
removing it. But the finding that actually decided it (F-07) is that
`@arcjet/node` has a third decision outcome beyond allow and deny: when it cannot
reach its API, `protect()` returns a decision whose conclusion is `ERROR`. The
middleware checked `decision.isDenied()` and its `reason.*` predicates, so an errored
decision fell through to `next()` and the request was served with **no** rate
limiting, bot detection, or shield — with no log line and no metric.

Verified by probing the decision object rather than reading the source:

```
decision.conclusion = ERROR | isDenied = false | isErrored = true
error reason: Failed to establish tunnel to decide.arcjet.com:443
```

The benchmark then confirmed it end to end. `ARCJET_KEY` was empty in `.env.bench`,
and the **403 column of the failure table is zero across all fourteen v0 runs** —
while `security.middleware.js:25` configured a `LIVE` sliding window of 5
requests/minute for `guest`. A limiter that let ~27,000 requests through in a run
where it was configured to allow five per minute is not a limiter.

So the reframe, which is the sentence to lead with:

> Replacing it was never about avoiding a dependency. It was about owning the
> failure policy. Fail-open versus fail-closed is an application decision, and it
> has to be explicit, logged, and per-route.

Recorded as [ADR 0002](adr/0002-own-the-failure-policy.md) at the end of Phase 0 and
implemented in [ADR 0003](adr/0003-in-process-limiter-then-redis.md) here.

---

## 2. "What replaced it? And why isn't it Redis, if you want distributed limiting?"

A sliding-window log in process, behind a store interface, with Redis arriving in
Phase 4. Three design choices are worth defending individually, because each one is
the difference between a component that is genuinely swappable and one that is only
described that way.

**A sliding window log, not a fixed window.** A fixed window permits a burst of 2×
the limit across a boundary — `max` requests at 11:59:59 and `max` more at 12:00:00.
More importantly for the roadmap, the log maps one-to-one onto a Redis sorted set:
`ZREMRANGEBYSCORE` to expire, `ZADD` to record, `ZCARD` to count. That is precisely
the Lua script Phase 4 needs, so choosing this algorithm now means Phase 4 changes
one file rather than rethinking the semantics.

**`hit()` is `async` even though nothing in it awaits.** An interface that is
synchronous today has to be rewritten when the store becomes a network call, and "I
had to change every caller" is the usual reason a supposedly pluggable component
turns out not to be.

**The store is bounded and its sweeper is `unref`'d.** An unbounded `Map` keyed by
client IP is a denial-of-service vector against the limiter itself — rotate source
addresses and you grow the map without ever being rate limited. And the sweep
interval is `unref`'d because a background timer that keeps the event loop alive
would block the graceful shutdown added in the same phase. `tests/rate-limit.test.js`
asserts `store.timer.hasRef() === false`, which is a real assertion about shutdown
rather than a restatement of the code.

### The limitation, which you must volunteer

**It is not distributed.** Three replicas hold three independent maps, so the
effective limit is 3× the configured one. That is a correctness defect and it ships
deliberately, because it is the Phase 4 exhibit:

> "I replaced a Map with Redis" is a framework swap. "Here is my limiter holding at
> one replica, here it is allowing three times the configured limit across three
> replicas, and here is the same test passing once the state moved to Redis behind an
> atomic Lua script" is a measured correctness claim.

That is the claim Arcjet could never support, because its state lived somewhere I
could not inspect. Stating the limitation before being asked is the difference
between a known trade-off and an oversight.

---

## 3. "Fail open or fail closed?"

The question ADR 0002 exists to answer, and the correct answer is "it depends on the
route, and it is written down":

| policy | routes | on store failure | why |
|---|---|---|---|
| `auth` | `POST /sign-up`, `POST /sign-in` | **closed** (503 + `Retry-After`) | An unmetered brute-force window is worse than a short outage on two endpoints |
| `authenticated` | `/api/users/*` | **open** (serve, log at `error`) | Availability wins where the downside is an unmetered read |

Note that Arcjet also failed open. The difference is not the direction — it is that
this is chosen per route, logged at `error` level, and counted. Arcjet's was an
accident of which predicate the middleware happened to check.

The part that makes this more than a comment: the in-process store cannot realistically
fail, so both branches would otherwise be untested code that merely looks correct —
which is an exact description of the middleware it replaced. So the test injects a
store whose `hit()` rejects:

```js
const brokenStore = { hit: () => Promise.reject(new Error('store unreachable')) };
```

and asserts 503 on the credential endpoints and 200 on authenticated reads. When
Phase 4 introduces a store that genuinely can fail, the behaviour is already
specified and covered.

---

## 4. "Show me the privilege escalation."

The most instructive defect in the repository, because the code looked careful:

```js
// v0 src/validations/auth.validation.js:7
role: z.enum(['user', 'admin']).default('user')
```

A Zod enum with a safe default reads like considered input validation. It was on the
**sign-up** schema, and `auth.controller.js:19` destructured `role` straight out of
the validated body into `createUser`. So:

```bash
curl -X POST /api/auth/sign-up -d '{"name":"Eve","email":"…","password":"…","role":"admin"}'
```

returned an admin JWT to an anonymous caller. That token satisfied
`authorize('admin')` at `users.routes.js:15`, which was the only guard on the
list-all-users endpoint. The entire RBAC layer was bypassable with one extra JSON
field.

**The fix is not "validate the role harder."** Privilege is not user input, so it does
not belong in a request schema at all. Two independent gates now:

1. `signupSchema` has no `role` field — asserted by
   `expect(Object.keys(signupSchema.shape)).toEqual(['name','email','password'])`.
2. `createUser({ name, password, email })` takes no `role` parameter and writes
   `'user'` unconditionally. v0's signature was
   `({name, password, email, role = 'user'})`, and a safe default is no protection
   when the caller overrides it.

### Why strict rejection rather than silently stripping

`z.strictObject` means an escalation attempt is a **400 naming the offending key**,
not a quiet success. A plain object schema would strip `role` and report success —
which fixes the vulnerability but leaves nothing in the log, nothing for a test to
assert on, and a change a later refactor could undo without anything noticing.
Verified end to end: the request returns 400, `errors` matches `/role/`, and no
`Set-Cookie` is issued.

One nuance worth raising yourself: `updateUserSchema` **does** accept `role`, because
that route is authenticated and the controller rejects a role change from a
non-admin before the service is reached. The lesson was never "role must not appear
in a schema" — it was that it must not appear in an *unauthenticated* one.

---

## 5. "Your session lifetime contradicted itself. What did you do, and is 15 minutes usable with no refresh token?"

The v0 state: `cookies.js:6` set `maxAge` to 15 minutes while `jwt.js:5` set
`JWT_EXPIRES_IN = '1d'`. The browser discarded the cookie after 15 minutes; the token
stayed cryptographically valid for another 23h45m. And `grep -rn "revoke\|denylist"
src/` returned nothing, so there was no revocation path. Anyone who captured that
token had a day, while the short cookie created a false impression of a short
session — which is the worse half of the defect.

The fix is structural rather than numeric: **one** `SESSION_TTL_MS` in
`src/config/env.js`, consumed by both `jwt.js` and `cookies.js`. Two constants cannot
disagree if there is only one constant. A test decodes a freshly signed token and
asserts `(exp - iat) * 1000 === cookies.getOptions().maxAge === config.session.ttlMs`.

Now the honest part, because 15 minutes with no refresh token means users really are
logged out every 15 minutes:

> That is a genuine usability regression and it is the right trade in this order. A
> long-lived bearer token with no revocation path is an invisible defect; a short
> session with no refresh is a visible inconvenience. Phase 4 adds opaque refresh
> tokens in Redis with rotation and reuse detection, plus a JTI denylist for instant
> revocation. Fixing the contradiction first and the ergonomics second is deliberate.

A related piece of honesty that lives in the code: `POST /sign-out` clears a cookie
and nothing else. The JWT stays valid until it expires. The log line says exactly
that — `'Session cookie cleared; bearer token remains valid until expiry'` — because
calling it "sign out" in a README today would overstate it.

### The secret was worse than the lifetime (F-25)

```js
// v0 src/utils/jwt.js:4
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-please-change-in-production';
```

A production deploy that forgot the variable would start cleanly, behave normally,
and sign tokens anyone with this repository could forge — including admin tokens.
`src/config/env.js` now throws in production if `JWT_SECRET` is missing or shorter
than 32 characters, and warns loudly otherwise. Three tests cover it, including that
the debug escape hatch cannot be switched on in production.

Note the shape it shares with F-07: **a security control with a working default is a
security control that will eventually run with the default.** Arcjet failed open when
it could not reach its API; the JWT layer failed open when it could not find its
secret. Same class, two different subsystems, and neither said anything.

---

## 6. "A logger bug that dropped timestamps for months. Why didn't a linter catch it?"

The best answer in this document, because the investigation went somewhere
non-obvious.

The bug:

```js
format: winston.format.combine((
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
)),
```

The extra pair of parentheses makes the argument list a single **comma expression**.
JavaScript evaluates `timestamp()` and `errors()`, discards both, and passes only
`json()` to `combine`. Every log line was emitted with no timestamp, and every logged
`Error` lost its stack. Same bug again on the console transport.

Verified rather than reasoned about, by running both variants against the installed
winston:

```
BAD  (extra parens): {"a":1,"level":"info","message":"hello"}
GOOD (no parens):    {"a":1,"level":"info","message":"hello","timestamp":"…"}
```

Now the interesting part (finding F-22). ESLint has a rule for exactly this mistake —
`no-sequences` — and it **cannot** catch this instance. The rule treats a sequence
wrapped in explicit parentheses as deliberate, and the extra parentheses *are* the
bug. `no-unused-expressions` does not fire either, because the construct sits in a
call argument rather than an expression statement. Confirmed by running both rules
against `f((a(), b(), c()))` in isolation: zero reports.

So the defect is invisible four ways over: invisible in review because the code reads
correctly, invisible at runtime because the app starts and logs appear, invisible to
the linter whose purpose is catching comma expressions, and invisible in the output
because the missing field is one a human skims past.

**Which is the argument for how it is tested.** `tests/logging.test.js` asserts on the
formatted line — parsing the JSON a transport actually wrote and checking for
`timestamp` and `stack`. A mock-based test (`expect(logger.info).toHaveBeenCalledWith(…)`)
passes identically with the bug present and absent, because the bug is in the
formatter and not the call. The suite also **reproduces** the defect deliberately, so
the evidence lives in the tests rather than only in a commit message.

The generalisable version: **when a bug is invisible to your tooling, the test has to
assert on the observable output, not on the interaction.**

---

## 7. "How do you know your error handler doesn't leak anything?"

v0 had no error handler at all — `grep -rn "err, req, res, next" src/` returned
nothing — so every `next(e)` reached Express's built-in final handler, which writes
the stack trace into the response body whenever `NODE_ENV` is not `'production'`.
That leaks absolute file paths, dependency versions and internal structure to anyone
who can provoke an error.

The design separates two concerns that usually get tangled: `classify(err)` decides
the status, and the handler decides what the client may see. `classify` is exported so
it is unit-testable without an HTTP round trip.

The assertions worth quoting are the **negative** ones. The strongest test throws an
error whose message contains a connection string and asserts the response body is
*exactly* `{error, requestId}`:

```js
const secret = new Error('connection string postgres://user:hunter2@db/app failed');
expect(res.body).toEqual({ error: 'Internal Server Error', requestId: expect.any(String) });
expect(JSON.stringify(res.body)).not.toMatch(/hunter2/);
expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js:\d+/);
```

Four details worth raising unprompted:

- **5xx bodies never carry `classify`'s message.** Even when the classifier has a
  specific string, a 5xx gets a fixed `'Internal Server Error'`. Only 4xx messages
  reach the client, because those describe the caller's own mistake rather than our
  internals.
- **The request id is the trade that makes this debuggable.** The client gets an id
  and no stack; the log gets the id, the stack, and the `cause`. A report of "I got a
  500 at 14:32" is then answerable. This is also why the logger fix had to come
  first — with the comma-expression bug present, that log entry had no stack and no
  timestamp.
- **`res.headersSent` delegates to Express.** Writing a JSON error body after a
  partial response corrupts it; aborting the connection is the only correct move.
- **Status mapping catches things v0 reported as 500s.** Malformed JSON is a 400
  (verified against the real app), a 200 KB body is a 413, `ECONNREFUSED` is a 503
  because a retry may succeed, and Postgres `23505` is a 409 — which is the signup
  race finally returning the status `auth.controller.js:32` always intended.
- **An out-of-range `statusCode` is ignored.** `res.status(200)` on an error path
  would report success and `res.status(99)` is not a valid status; both fall back to
  500.

---

## 8. "Graceful shutdown — why is there a delay before you close the listener?"

If they ask this, they have operated something. The ordering is the whole answer, and
step 2 is the one almost everyone omits:

```
1. mark not-ready          -> /ready returns 503 immediately
2. wait readinessDelayMs   -> give the load balancer time to notice
3. server.close()          -> stop accepting NEW connections, keep serving in-flight
4. wait for drain          -> up to drainTimeoutMs
5. close pool + limiter sweeper
6. exit
```

Closing the listener the instant SIGTERM arrives **still drops requests**, because the
load balancer has not yet been told to stop routing and will keep sending them at a
closing socket. Failing readiness first and then pausing is what makes the drain
actually drain.

v0 had none of this: `src/server.js` was seven lines, `app.listen` and a
`console.log`, and `grep -rn "SIGTERM\|SIGINT\|server.close" src/` returned nothing.
Under a Kubernetes rolling deploy every in-flight request is severed mid-response —
the client sees a connection reset, not a 500 it can interpret. At the v0 knee
(~2.4 iterations/s as-built, p95 6.4 s) a deploy could cut a request that had been
running for several seconds.

Three supporting details:

- **`/health` and `/ready` are different endpoints and that distinction is
  load-bearing.** Liveness answers "is this process able to serve" from in-process
  state with no dependency check; readiness answers "should traffic come here" and
  does check Postgres. A liveness probe that fails when the database is down gets the
  container killed and restarted, which does nothing for a database outage except
  remove capacity. That is how a dependency blip becomes a full outage.
- **SIGINT takes the same path as SIGTERM.** So stopping the dev server with Ctrl-C
  exercises the drain code every time, rather than that code first running during a
  production deploy. Shutdown logic that has never executed is not shutdown logic.
- **`stop_grace_period` was set in both compose files.** It has to exceed
  `readinessDelayMs + drainTimeoutMs` or the orchestrator sends SIGKILL mid-drain and
  the whole sequence is decorative — including step 5, which is what leaves Postgres
  holding connections. The Kubernetes equivalent is
  `terminationGracePeriodSeconds`, in Phase 7.

Also worth mentioning because it is the kind of thing that bites later: the
rate limiter's sweep interval is `unref`'d. A background timer with a ref would keep
the event loop alive and the process would never exit after step 6.

---

## 9. "You paginated the list endpoint. Why offset and not keyset? And why no index?"

The second question is the one that separates a measured answer from a reflex. The
reflex fix for a slow list endpoint is an index, and here an index would have
achieved **nothing** — which Phase 0 proved before any code changed:

| what | v0 measurement |
|---|---|
| rows per response | 1,001 |
| bytes per response | **167 KiB** |
| `JSON.stringify` of that response | **7.36 ms** |
| the query itself, in Postgres | **2.20 ms** mean, 5,090 calls |
| `EXPLAIN (ANALYZE, BUFFERS)` execution | **0.335 ms**, 21 shared-buffer hits, fully cached |

Postgres contributed roughly 2 ms to requests that were reporting 15,000 ms. The cost
was Node parsing 1,001 rows off the wire in text format, drizzle mapping them into
objects, and `JSON.stringify` serialising them. **Pagination is the fix because it
reduces the number of rows, not the cost of finding them.**

**Why offset, not keyset.** Keyset (`WHERE id > :cursor`) is O(page) while `OFFSET n`
makes the database walk and discard n rows. At 1,001 rows that difference is
unmeasurable. Phase 3 introduces the write-heavy entity at 1M+ rows, where it becomes
measurable and gets the before/after it deserves. Shipping keyset now would mean
claiming an improvement I could not demonstrate — which is the one thing this project
is organised to avoid.

**The missing `ORDER BY` was a correctness bug independent of performance.** Without
it Postgres may return rows in any order, so paging would skip and duplicate rows as
the heap changed underneath. Ordering by the primary key is free — it is an
index-ordered scan.

**The cap is the security-relevant part.** Without `maxLimit`, `?limit=1000000`
reintroduces the unbounded query as a *caller-controlled* denial of service. That is
a more common bug than the missing `LIMIT` it replaces, precisely because the
pagination looks present. Tested: `limit=1000000` is a 400, and so are `0`, `-1`,
`abc`, `1.5` and `1e9`.

Two smaller things in the same change:

- `count(*)` runs alongside the page, and it is the expensive half — a full scan,
  because MVCC gives Postgres no single authoritative row count. Trivial at 1,001
  rows, not trivial at 1M, so Phase 3 replaces it on the new entity with either a
  `pg_class.reltuples` estimate or a cursor response with no total at all.
- The projection is explicit and a test asserts `password` is absent from it.
  `db.select()` with no projection returns every column including the bcrypt hash.

---

## 10. "You changed the benchmark between phases. Isn't that cheating?"

Expect this, because it is the correct instinct. The answer is that two rules were in
direct conflict and the resolution is stated in writing.

`BENCHMARKING.md` freezes the k6 scripts across phases: a comparison is only a
comparison while the instrument is constant. But finding F-17 said the mix was wrong
— `baseline.js` runs exactly **25% authentication**, and no read-heavy workload looks
like that. bcrypt at cost 10 measures 54.8 ms per compare, so a quarter of requests
running a key derivation made bcrypt 37% of the per-iteration CPU budget and depressed
every throughput number in the v0 matrix.

Both rules cannot hold. The resolution:

> `baseline.js` stays frozen as the before/after instrument. The corrected mix becomes
> a **second** script, `realistic.js`, whose own series starts at v1. Two numbers with
> different meanings, each internally comparable — rather than one number that quietly
> changed meaning between phases.

Changing the mix in place would have invalidated the committed v0 matrix and required
a ~75 minute re-run of Phase 0 before Phase 1 could claim anything. `report.mjs`
enforces the separation: it reads the `mix` field from each result file and **refuses
to pair rows from different instruments**.

### The one edit to the frozen file, which you should disclose

`baseline.js` was changed by exactly one line, to read its output directory from the
environment instead of a hardcoded `benchmarks/v0-baseline/results`. The distinction
this rests on:

> What is frozen is the *measured behaviour* — the request mix, the load shape, the
> thresholds, the tags. Where the resulting file lands is not part of the measurement.

An auditor should diff the file between the two runs and find only that line. Stating
it before someone finds it is the whole point; the alternative is a reviewer
discovering an undisclosed edit to a file the docs call frozen.

A verification that supports the claim: `report.mjs` regenerated
`benchmarks/v0-baseline/SUMMARY.md` from the committed v0 JSON after the harness
rework with **zero changes to any measured figure** — only the Reproduce block moved
to the new script names.

---

## 11. "Your rate limits are raised during the benchmark. Isn't that the same cheating you accused Arcjet of?"

A sharp question, and the answer is a distinction plus two guardrails.

Every k6 VU shares one source IP and one admin user. The production auth limit is 10
requests per minute per IP. So a matrix run with production limits becomes almost
entirely 429s — and **rejections are fast**, so the report would show a dramatic
latency improvement that was really the limiter refusing to work.

This is precisely the trap Phase 0 documented as the F-16 corollary:

> Supplying a working Arcjet key would not have improved those runs, it would have
> ended them. At 5 requests/minute per IP, every VU shares one source address and the
> whole matrix becomes 403s.

The distinction from disabling it: **the limiter still executes on every request.** Its
CPU cost is still inside every measurement. Only the *rejection* is taken out of the
way. That is different in kind from Phase 0's `BENCH_BYPASS_SECURITY`, which removed
the middleware from the router entirely — and which is why that flag was deleted rather
than repurposed.

Then two guardrails, because a configuration comment is not a guarantee:

1. **Before the matrix**, `run-phase.sh` reads `RATE_LIMIT_AUTH_MAX` and
   `RATE_LIMIT_ADMIN_MAX` back **out of the running container** and refuses to start if
   either is below a floor. Not out of `.env.bench` — what matters is what the process
   has, not what a file says.
2. **After every run**, it parses the result JSON and refuses the run if
   `rejected_rate_limited` is non-zero or any 403 was counted. Checking the outcome
   rather than the configuration is the same discipline as reading resource limits back
   from `HostConfig.NanoCpus` instead of trusting the compose file (finding F-11).

There is a related check in the same spirit: for any phase after v0 the runner asserts
`GET /api/users` returns under 32 KB before starting, and the k6 check asserts the same
per request. v0 shipped 167 KiB. "The number got better" and "the fix shipped" are
different claims, and only the second one is worth making.

---

## 12. "Your CI was green with 37 lint errors in main. How?"

A good code-review question with a specific, slightly embarrassing answer:

```yaml
- name: Run lint
  run: npm run lint
  continue-on-error: true      # swallows the failure
- name: Check format
  run: npm run format:check
  continue-on-error: true      # swallows the failure
- name: Annotate lint failures
  if: failure()                # can therefore never be true
  run: ... exit 1
```

`continue-on-error` stops a failing step from marking the job as failed, so
`failure()` never evaluated true and the one step that would have failed the build
was **unreachable**. The workflow always passed.

> A gate that cannot fail is worse than no gate, because it is reported as passing.

Removing `continue-on-error` is also what made the annotation step reachable for the
first time. The 37 pre-existing errors were then cleared — most were indentation and
missing semicolons in the test file, plus four `preserve-caught-error` violations
where a caught error was rethrown without `{ cause }`, which is the same class of
information loss as the logger dropping stacks.

### The second-order problem it exposed (F-26)

The moment both gates became blocking, a latent conflict mattered: eslint and prettier
were **both** policing formatting. `eslint.config.js` set `indent`, `quotes` and
`semi`; `.prettierrc` set the same things; and `eslint-config-prettier` sat in
devDependencies **unused**. Harmless while lint could not fail — and once it could,
`npm run lint:fix` and `npm run format` could undo each other, which is not a
conflict you want a contributor to discover from a red CI run on their PR.

Split cleanly: prettier owns layout, eslint owns correctness, and
`eslint-config-prettier/flat` is applied last so it switches off every stylistic rule
prettier handles. Then eslint gained rules that are actually about correctness,
including `no-sequences` and `no-unused-expressions` — added even though F-22 proved
they cannot catch the specific bug that motivated them, because they catch the
adjacent cases.

Two smaller judgement calls in `.prettierignore`, both worth being able to justify:
`*.md` is excluded because the docs are hand-wrapped prose and `PROJECT_LIFECYCLE.md`
is append-only by its own rule, so reformatting past phases is the one edit that file
forbids; and `benchmarks/k6/baseline.js` is excluded because it is the frozen
instrument, and a formatter that rewrites it on a whim is one more way for it to
drift.

---

## 13. "What did you find that surprised you?"

Six things. The last ones are the best answers because they are about my own work in
this phase.

### The dev script could never have worked (F-23)

F-09 recorded that `scripts/dev.sh:39` ran `npm run db:migrate` from the host before
`docker compose up`, so migrations raced the database container. Fixing the ordering
turned out not to be enough. `.env.development:11` pointed `DATABASE_URL` at
`@postgres:5432` — a compose **service hostname**:

```
$ getent hosts postgres
(no output — not resolvable from the host)
```

So a host-side migration could not reach the dev database at *any* point in the
sequence. And `drizzle.config.js:1` loads plain `dotenv/config`, which reads `.env` —
not `.env.development` — so which URL a host-side migration actually used depended on
an untracked file that may not exist. It worked for whoever wrote it, on a machine
with a warm volume and the right `.env`, and would fail on every clean clone. Now
migrations run in a one-shot container **on the compose network**, which is also the
direction Phase 7 goes with an init container.

### Every validation failure logged nothing useful (F-21)

Six call sites logged `validationResult.error.errors`. Zod 4 renamed that to
`.issues`:

```
$ node -e "…z.object({a:z.string()}).safeParse({}).error…"
has .issues: true
has .errors: UNDEFINED      (zod 4.4.3)
```

So every one recorded `{ errors: undefined }` — that a request failed validation, and
nothing about why, which is the single most useful thing to know when a client reports
that your API rejects its payload. It survived because `formatValidationError` already
used `.issues`, so the HTTP response was correct and only the log was blind. A
silent-but-correct response is exactly the condition under which nobody investigates.

### A script that told you the wrong container name (F-24)

`scripts/prod.sh` printed `docker logs acquisition-app-prod` while
`docker-compose.prod.yml:39` declares `acquisitions-app-prod`. Every command it
suggested would have failed with "No such container". It also ran migrations *after*
starting the app, and waited with `sleep 5` under the message "Waiting for Neon Local
to be ready" — a service that stack does not contain. Small, but it is the first thing
a forker runs.

### A setting that looked enforced, and one that looked mandatory (F-29, F-30)

Found while rewriting the README **against the code** rather than against the
previous README, which is the only reason they surfaced.

`CORS_ORIGIN` was documented in three env templates and read by nothing:
`src/app.js` called `cors()` with no options, so the effective policy was
`Access-Control-Allow-Origin: *`. `COOKIE_SECRET` was the mirror image — required by
three templates and checked for by `scripts/prod.sh`, while `cookieParser()` was
constructed with no secret, so no cookie was ever signed.

The fixes deliberately differ. `CORS_ORIGIN` is now read, with `credentials` enabled
only for an explicit allow-list, because a wildcard plus credentials is rejected by
browsers. `COOKIE_SECRET` was **deleted**: the session cookie holds a JWT that already
carries its own signature, so signing the cookie would add a second integrity check
over the same bytes. Making a no-op real is not automatically better than removing it.

The shared lesson is about what dead configuration teaches a reader: one setting
looked enforced and was not, the other looked mandatory and did nothing, and both
train someone to treat the setup checklist as noise — after which the entry that does
matter gets skipped. Worth pairing with a detail people get wrong: `sameSite=strict`
means the browser will not send the session cookie cross-site whatever CORS says, so
the allow-list governs who may *read responses*, not who may *authenticate*.

### And two I introduced myself, in this phase (F-28, F-31)

The request-logging middleware that replaced morgan read `req.path` from a `'finish'`
listener. Express **rewrites** `req.url` and `req.baseUrl` as a request descends into a
mounted router and restores them as the stack unwinds — so the value depends on where
the response was produced. Observed directly in two log lines during verification: the
same router logged `path: '/sign-up'` when the controller answered inside the router,
and `'/api/auth/sign-in'` when `next(e)` unwound to the app-level error handler first.

The field was unstable in a way that correlated with whether the request had errored,
which is the worst possible correlation for a field you would group by when
investigating errors. Fixed by reading `req.originalUrl`, which is never rewritten.

The second one (F-31) is the more useful story, because of **how** it was found. Two
defects in my own error path:

- `requestId` was mounted after `express.json()`, so a malformed body threw before it
  ran. `req.id` was undefined, and `JSON.stringify` silently drops undefined fields —
  so the 400 went out with no correlation id at all. That is precisely the case where
  a client most needs one.
- `classify()` checked `err.status` before its SyntaxError branch, and body-parser
  already sets `status = 400`. So the explicit-status branch matched first and passed
  `err.message` straight through: the parser's own text, which can quote a fragment of
  the offending body.

What makes it worth telling: **the test for this passed.** It asserted status 400 and
no stack frame — the two things that were already right. Booting the process and
sending `{"email":` found both defects in one command:

```
before: {"error":"Unexpected end of JSON input","message":"Unexpected end of JSON input"}
after:  {"error":"Malformed JSON in request body","requestId":"80263f6d-…"}
```

> A test written from the same mental model as the code inherits its blind spots.

And the pattern across both: every defect I introduced in this phase was in the
**observability layer**, where being wrong is silent by construction. That is the same
category as Phase 0's F-12, where the measurement was correct and the report produced
a false diagnosis.

---

## 14. "What's still broken?"

Volunteer this list. Everything on it is deliberate, and each item names the phase
that closes it:

| still wrong | why it was left | phase |
|---|---|---|
| The limiter is per-process, so N replicas allow N× the limit | It is the Phase 4 exhibit — proving it wrong across 3 replicas is a measured correctness claim, not a framework swap | 4 |
| No refresh token; a session really ends after 15 minutes | Fixing the lifetime contradiction had to come before the ergonomics | 4 |
| `POST /sign-out` clears a cookie; the JWT stays valid | No revocation path exists yet; the log line says exactly this | 4 |
| Sign-in timing oracle — a nonexistent address answers sooner than a wrong password, because no bcrypt compare runs | Needs a dummy compare against a fixed hash; belongs with the credential-path rebuild | 4 |
| Signup is still check-then-insert. `23505` is now translated to a 409, but the race is real | It is the isolation-level worked example; spending it early wastes it | 3 |
| `updateUser`/`deleteUser` read-modify-write with no version column | Same — it is the lost-update demonstration | 3 |
| The Neon HTTP driver branch survives outside development | Removing it changes what the v1 benchmark measures beyond the four changes being attributed. Phase 1 added a loud warning instead — the switch was silent, which is why F-06 exists | 3 |
| No coverage threshold in CI | A threshold pinned to today's figure is a ratchet, not a standard. It lands with the Testcontainers suite | 8 |
| Which server-side timer sends the 15 s RST (F-14) is still unattributed | Ruled out: HTTP 408, connection setup, Arcjet. Leading hypothesis is accept-queue overflow — `1+2+4+8 = 15` s is the SYN-ACK retransmission backoff. One command settles it: `nstat -az \| grep -Ei 'ListenOverflow\|ListenDrop\|TCPAbort'` | 6 |

---

## 15. "What would you do differently?"

- **The Phase 1 scope conflict should have been settled in Phase 0.** `UPGRADE_PLAN.md`
  assigned pool sizing and pagination to Phase 3; the measurements put them ahead of
  most of the correctness work. Resolving that at the start of Phase 1 rather than
  writing the plan and then contradicting it cost a decision round-trip. The plan was
  written before the data existed, which is the honest reason — but it is also an
  argument for phasing more loosely until the first measurement lands.
- **68 tests and not one of them touches a database.** That is deliberate for now —
  the suite runs in four seconds and needs no services — but it means the pagination
  query, the pool configuration and the `23505` translation are verified against mocks
  rather than against Postgres. Testcontainers in Phase 8 is where that becomes real,
  and until then "tested" means something narrower than it sounds.
- **The v1 matrix has not run.** So this phase currently claims correctness and not
  speed. I would rather have run it before writing this document, and the honest
  position is that the throughput expectation is arithmetic from the v0 attribution
  (~75 ms of CPU per request removed from a 148 ms per-iteration budget), not a
  measurement.
- **`realistic.js` duplicates `baseline.js`'s journey rather than sharing it.** That
  is the right call — a frozen instrument must not import code a later phase can edit
  — but it means the two mixes can drift apart silently. A test that asserts both
  scripts hit the same set of endpoints would close that, and does not exist yet.
- **The rate limiter has no metrics endpoint.** `rateLimitStats` counts rejections and
  store failures, and nothing exposes them. Phase 6 wires it to Prometheus; until then
  the only evidence a limiter fired is a log line.

---

## Phase 2 priorities

Not an interview question, but the thing they ask next. Phase 2 is the TypeScript
migration, and Phase 1 was shaped to make it cheaper:

1. **`src/config/env.js` becomes the typed config loader.** It already centralises
   session, pool, pagination, shutdown and rate-limit values and validates them at
   import time — deliberately hand-checked rather than schema-validated, because
   Phase 2 can type it instead of duplicating the validation.
2. **`AppError` and `classify()` get a discriminated union** for the error kinds, so
   the status mapping is exhaustive by the compiler rather than by review.
3. **The store interface gets an actual interface.** `MemorySlidingWindowStore` and
   the Phase 4 Redis store then satisfy one contract the compiler checks, which is
   the difference between a swappable component and a hopeful one.
4. **Strict mode, ESM and the `#alias/*` subpath imports all stay.** The migration is
   about types, not about restructuring, and mixing the two would make the diff
   unreviewable.

---

## The one-sentence version

> Phase 0 measured where the time went, so Phase 1 was ordered by cost rather than by
> instinct — and the largest single win was deleting a dependency: a hosted security
> layer that cost ~75 ms of CPU per request and, because it treated an unreachable
> provider as "allow", was enforcing nothing at all. I replaced it with a
> sliding-window limiter that owns its failure policy explicitly per route, returns 429
> with `Retry-After` instead of 403, and is mounted after authentication so per-role
> limits actually apply — then fixed the privilege escalation that let any anonymous
> caller sign up as admin, unified a session lifetime that disagreed with itself by
> 23 hours, removed a JWT secret that defaulted to a string committed in the
> repository, added a global error handler that puts a request id on the wire and the
> stack in the log, and made CI actually able to fail. Every one has a test that fails
> if the defect returns, and the benchmark harness now refuses to accept a run where
> the limiter fired — because a matrix full of fast rejections would have looked
> exactly like an improvement.














