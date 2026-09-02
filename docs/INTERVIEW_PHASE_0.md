# Phase 0 — interview preparation

Questions a competent interviewer will ask about the benchmarking work, and what
makes a strong answer. Ordered roughly by how likely they are to come up.

---

## 1. "How did you measure that?"

The one question that decides whether your p95 claim counts for anything. The
answer has to be concrete and short:

> Committed k6 scripts, pinned container resources, tagged commit, raw JSON output
> committed alongside the summary. The table in the docs is generated from that raw
> output by a script — it's never hand-typed. Anyone can re-run
> `./benchmarks/scripts/run-baseline.sh` at the `v0-baseline` tag and get the same
> numbers.

The three things that make this credible rather than performative: results are
attributable to one commit (the runner refuses to start on a dirty tree), the
environment is fingerprinted into `environment.json`, and the "before" was
recorded before any optimisation existed.

---

## 2. "Closed model or open model?"

The highest-signal question in load testing, and most candidates cannot answer it.

A **closed model** (k6 `ramping-vus`, JMeter threads) uses a fixed number of
virtual users, each of which waits for its response before issuing the next
request. So when the server slows down, the load generator slows down with it. The
system is never pushed past what it can handle, and the latency distribution looks
better than reality. This is **coordinated omission**: the requests that would have
been slow were never sent, so they never appear in the histogram.

An **open model** (k6 `constant-arrival-rate`) issues requests on a schedule
regardless of whether previous ones finished. When capacity is exceeded, k6 reports
`dropped_iterations` — it could not start iterations on time. That is the honest
saturation signal.

Why ship both: the closed model answers "what do 500 concurrent clients
experience," which is the shape of the resume claim. The open model answers "at
what arrival rate does this system fall over," which is the capacity question. They
are different questions and neither substitutes for the other.

Follow-up you should expect: *"so is your 500-VU number affected by coordinated
omission?"* Correct answer: yes, partially, which is why the saturation probe exists
alongside it — and the 1s think-time in `baseline.js` means VU count corresponds
loosely to real concurrent users rather than to an infinite-rate hammer.

---

## 3. "Why is your baseline p95 so high / low?"

Have the decomposition ready. In this system:

- `/health` — no I/O, measures Express + middleware overhead only.
- `POST /api/auth/sign-in` — dominated by bcrypt. Measured at cost 10:
  114ms to hash, 75ms to compare. At one app CPU that is a hard ceiling around
  13 signins/sec, and it is **not a bug** — it is the security/throughput
  trade-off the cost factor exists to make. Anyone who "optimises" this by
  lowering the cost factor has made the system worse.
- `GET /api/users` — unbounded `SELECT` with no `LIMIT` and no `ORDER BY`
  (`src/services/users.service.js:6-14`). Latency grows linearly with row count.
  This is the real optimisation target.

The point: a blended p95 across those three describes no actual user. That is why
`benchmarks/k6/lib/metrics.js` defines a separate `Trend` per endpoint.

---

## 4. "You disabled the security middleware to benchmark. Isn't that cheating?"

Expect this, because it looks bad until explained.

The as-built middleware calls Arcjet's cloud API on every request. That network
round-trip sits inside the request path, so a baseline taken with it inline is
largely a measurement of someone else's network. If you then optimise your
database and claim the resulting p95 drop, you are partly claiming credit for
having removed a third-party HTTP call.

So the run records **both** variants at every concurrency level, and the report
prints the delta explicitly as an attribution table. The flag is double-guarded —
`BENCH_BYPASS_SECURITY === '1'` *and* `NODE_ENV !== 'production'` — and
`tests/bench-guard.test.js` asserts that production cannot be bypassed for any
flag value. The flag and the dependency are both deleted in Phase 1.

The general principle worth stating: when a measurement has a confound you can't
remove, measure it both ways and publish both.

---

## 5. "What did you find that surprised you?"

Two things, and the second is the better story because it is about your own work.

### The security middleware fails open

`src/middleware/security.middleware.js` checks `decision.isDenied()` and its
`reason.*` predicates. But `@arcjet/node` has a third outcome: when it cannot
reach its API, `protect()` returns a decision whose conclusion is `ERROR`. That is
not `isDenied()`, so control falls through to `next()` and the request is served
with **no** rate limiting, bot detection, or shield.

Verified rather than assumed — probing the decision object directly with no key
and no egress:

```
decision.conclusion = ERROR | isDenied = false | isErrored = true
error reason: Failed to establish tunnel to decide.arcjet.com:443
```

There is no log line and no metric on that path, so in production this degradation
would be invisible.

The reframe this gives you: replacing Arcjet is not about avoiding a dependency,
it is about **owning the failure policy**. Fail-open vs fail-closed is a decision
that belongs to the application and must be explicit, logged, and per-route — a
login endpoint should probably fail closed, a read-only health endpoint should
probably fail open. Any dependency in the request path needs that decision made
deliberately, plus a timeout and a circuit breaker.

### My own benchmark was measuring the wrong thing

The stronger answer, because it shows you review your own work adversarially.

The first version of the load script signed in as a random seeded user and then
called `GET /api/users`. All seeded users have role `'user'`. That route is guarded
by `authorize('admin')` at `src/routes/users.routes.js:15`, and `authorize` returns
403 from middleware **before** the controller runs
(`src/middleware/auth.middleware.js:35-40`).

So every `users_list` sample would have measured the cost of a middleware
rejection — a few hundred microseconds — instead of the unbounded `SELECT` at
`src/services/users.service.js:6-14`, which is the single most important
optimisation target in the project. The run would have completed. The numbers would
have looked plausible. And the entire Phase 3 pagination comparison would have been
measured against a baseline that never touched the database.

Fixed with four independent guards: k6's `setup()` authenticates once as a
dedicated admin and throws if it can't; the seeder upserts that admin on every
invocation including the already-seeded path; the runner probes admin sign-in
before starting the 35-minute matrix; and the k6 check now asserts `status === 200`
rather than tolerating 403.

The generalisable lesson: **a load test that silently measures the wrong code path
is more dangerous than one that fails**, because it produces confident numbers. So
assert on the response you expect, not merely on the absence of errors.

### And one that constrains the whole harness

`deploy.resources.limits` in a compose file is honoured by Compose V2 but was
silently ignored by Compose V1, where the equivalent keys were top-level `cpus`
and `mem_limit`. If that had gone unnoticed, "resource-pinned benchmark" would
have been false and every comparison void. The runner now reads
`HostConfig.NanoCpus` and `HostConfig.Memory` back through `docker inspect` and
refuses to continue if either is zero. Trust the observed state, not the config
file.

---

## 6. "Why warm-up, cool-down, and pinned versions?"

- **Warm-up discarded** — the first ~30 seconds of a Node process is JIT
  compilation and a cold Postgres buffer cache. Including it inflates p99 and, worse,
  makes every *later* phase look artificially better because by then you've
  learned to warm up.
- **45s cool-down between runs** — TCP sockets in `TIME_WAIT` and a warm page
  cache from the previous run leak into the next one.
- **`postgres:16.4-alpine`, not `16-alpine`** — a minor version bump between the
  v0 run and the final run would silently invalidate the comparison. Same reason
  the CPU and memory limits are pinned in `.env.bench`: without them you are
  benchmarking the host machine's current mood.
- **`ANALYZE` after seeding** — stale planner statistics produce a bad query plan,
  and you end up benchmarking the planner's mistake instead of the schema.

---

## 7. "Why commit raw benchmark output to the repo?"

Because a number in a README is an assertion and a committed artifact is evidence.
`benchmarks/scripts/report.mjs` regenerates the markdown tables from the raw JSON,
so the docs cannot drift from the data. `.gitignore` excludes only the noisy
per-iteration stream, which is large and adds nothing.

---

## 8. "Why untrack `coverage/` and fix `.gitignore`?"

Small, but it comes up as a code-review question. Two distinct bugs:

- `coverage/` (38 files) and `logs/` were tracked, so every local test run
  produced a dirty tree — which also breaks the "results must be attributable to
  one commit" rule the benchmark runner enforces.
- `.gitignore` had `logs/*` **after** those files were already tracked. Gitignore
  does not apply to tracked paths, so the rule did nothing. Fixing it requires
  `git rm --cached`.
- The pattern `.env.*` also matched `.env.example`, so the template a new
  contributor needs was unstageable. Fixed with a negation — `!.env.example` —
  which only works if it comes *after* the broad rule.

---

## 9. "What's your gitleaks setup actually doing?"

Runs on full history (`fetch-depth: 0`), not just the diff, and is not
`continue-on-error` — a secret fails the build. Adds a custom rule for Postgres
and Redis connection URIs, which the default ruleset does not reliably catch and
which is exactly what leaked here.

The honest part: the two historical commits containing the exposed Neon string are
allowlisted **by exact SHA**, not by pattern, with a comment explaining that the
credential was rotated. Allowlisting by pattern would have suppressed future leaks
too. Removing those two lines reproduces the original finding, which means the
allowlist is auditable.

Verified against six cases — the real leaked string and a realistic secret both
fail the build; the compose placeholder, README placeholder, bench template, and
`${VAR}` indirection all pass.

---

## 10. "What would you do differently?"

Good answers, all true here:

- Benchmarking from the same host that runs the app means the load generator
  competes for CPU with the thing being measured. A separate machine, or at least
  a pinned CPU set, would be better. Worth stating as a known limitation rather
  than hoping nobody asks.
- Only one metric source at v0 — client-side k6 timings. Server-side latency
  histograms (Phase 6) will let you separate queue time from service time, which
  client-side numbers cannot distinguish.
- No p99.9. At these request volumes the p99.9 bucket has too few samples to be
  meaningful, so reporting it would be false precision.

---

## The one-sentence version

> I tagged the unmodified service, measured it under both closed- and open-model
> load at 100/500/1000 concurrent clients with pinned resources, committed the raw
> output, and generated the report from it — so every latency number I quote can be
> reproduced from the repo, and I found a fail-open hole in the security middleware
> while doing it.
