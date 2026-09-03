# Phase 0 — interview preparation

Questions a competent interviewer will ask about the benchmarking work, and what
makes a strong answer. Ordered roughly by how likely they are to come up.

Every number here is measured and traceable to a committed artifact —
`benchmarks/v0-baseline/SUMMARY.md`, `failure-attribution.txt`,
`pg_stat_statements.txt` — or to a command whose output is quoted inline. Nothing
is estimated.

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

One refinement worth mentioning unprompted, because it shows you thought about
what "same commit" actually needs to mean: the fingerprint records
`git rev-parse HEAD:src` alongside the commit SHA. `HEAD` moves whenever the
harness or the docs change, which would make two genuinely comparable runs look
incomparable. What determines application behaviour is the content of `src/`, so
results with a matching `src` tree can be compared across different commits — and
a differing tree invalidates the comparison no matter what `HEAD` says. That
distinction saved this project once already: the `v0-baseline` tag and the
benchmarked commit differ by two commits, but both have `src` tree `07d128b0`.

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

Why ship both: the closed model answers "what do N concurrent clients
experience," which is the shape of the resume claim. The open model answers "at
what arrival rate does this system fall over," which is the capacity question. They
are different questions and neither substitutes for the other.

Follow-up you should expect: *"so is your 500-VU number affected by coordinated
omission?"* The honest answer is that it's worse than that — the 500-VU row is
**timeout-censored**, which is a different and more serious problem than
coordinated omission, and the report flags it rather than hiding it. See §3.

Second follow-up, and you should raise it before they do: the open-model probe in
this repo is currently measuring the wrong thing. `saturation.js` hits `GET /api`,
a static JSON response, and the runner starts those runs with
`BENCH_BYPASS_SECURITY=1`. So it reports Express routing throughput on the pinned
core — 500 req/s at p95 3.33 ms with zero drops — not the capacity of the real
endpoint mix. That number is still useful as a floor for framework overhead, and
§5 uses it, but calling it "the saturation point" would be wrong. Pointing it at
the same mix as `baseline.js` is a Phase 1 fix.

---

## 3. "Your report says 89% of requests failed. Is your API broken?"

This is the question the numbers invite, and the answer is the strongest single
piece of analysis in Phase 0. Short version:

> Nothing failed. Zero 4xx, zero 5xx, zero 429, zero 403 across all fourteen runs.
> Every failure is k6 status 0 — no HTTP response was received at all — so the app
> never got the chance to return an error. Those requests were withdrawn or reset
> before it answered.

Then the part that makes it credible: **status 0 is not one failure mode, and the
aggregate output cannot tell them apart.** k6's summary export carries no error
code, so a high `http_req_failed` rate is unattributable from it — which is exactly
the question a high failure rate raises. Re-running with `--out json=` captures a
per-request `error_code`, and `npm run bench:attribute` distils those streams into
`failure-attribution.txt`. The split:

| code | meaning | where it lands |
|---|---|---|
| **1220** | `read: connection reset by peer` | hard cluster with a **15001 ms** median — 6,627 samples in the 1000-VU as-built run alone, spanning just 14995–15014 ms |
| **1050** | `request timeout` | k6's own 60 s default |

At 1000 VUs as-built, **83.05%** of all requests ended in 1220. Code 1220 means the
RST came from the *server* side, which is why those requests never reached
Postgres — and that independently explains an anomaly visible in the server-side
capture: k6 sent 11,037 users-list requests across the matrix while
`pg_stat_statements` recorded only 5,090 calls of that shape.


### The censoring point

This is the part most candidates miss entirely. Once requests are being abandoned,
**every latency quantile at or past the abandonment point equals the timeout, not a
response time.** A p95 of 60000.64 ms is not "the server took 60 seconds" — it is
"the client stopped waiting." Quoting it as latency is simply a false statement, and
worse, it will make a later optimisation look like an improvement when all that
changed is where the queue overflowed.

So `report.mjs` marks those rows `†`, refuses to compute a variant delta between two
censored rows (it prints `censored` instead), and adds a `p95 served` column
computed over `http_req_duration{expected_response:true}` — the requests that
actually got an answer, which is the only latency figure on a censored row that
means anything.

The generalisable lesson, and the one to say out loud: **a failure rate is not a
finding until you know which failure it was.** "The server erred", "the server reset
the connection", and "the client gave up" have three different fixes, and only one
of them is in your application code.

### Still open, and say so

Which server-side timer sends the 15 s RST is not yet attributed. Ruled out: an
HTTP 408 (there is no HTTP response at all), connection setup
(`http_req_connecting` peaks at 10 ms), and Arcjet (the cluster is present in the
bypassed variant too). Leading hypothesis is accept-queue overflow on a blocked
event loop, since `1+2+4+8 = 15` s is the cumulative SYN-ACK retransmission
backoff. One command inside the app container under load settles it:
`nstat -az | grep -Ei 'ListenOverflow|ListenDrop|TCPAbort'`. Naming your open
questions precisely is a better signal than pretending you have none.

---

## 4. "Where's the knee?"

If they ask this, they know load testing. If they don't, volunteer it — it is the
number that makes every other number in the report legitimate.

The knee is the highest concurrency level that produced zero abandoned requests.
`report.mjs` computes it rather than leaving it to be eyeballed:

- **`v0-nolimit`** — clean through **100 VUs**: 3.89 iter/s, p95 9103 ms. Abandonment
  starts at 500 VUs (39.22%).
- **`v0-asbuilt`** — clean through **50 VUs**: 2.35 iter/s, p95 6407 ms. Abandonment
  starts at 100 VUs (2.79%).

The discipline that follows: **quote the knee row, never the rows above it.** A level
past the knee partly measures how long k6 was willing to wait, so a Phase 1
"improvement" measured there may be nothing but a shift in where the queue
overflows.

### The saturation signature

The more interesting observation is what happens *below* the knee. As-built
throughput across 5, 10, 20 and 50 VUs is 2.11, 2.24, 2.22, 2.35 iter/s — **flat** —
while p95 climbs 695 → 1501 → 2791 → 6407 ms. Bypassed, throughput peaks at
**6.76 iter/s at 10 VUs** and then *declines* to 5.42 and 5.14.

Flat throughput with linearly rising latency is the textbook signature of a system
already at capacity: additional concurrency buys queue depth, not work. Little's
Law, and being able to name it matters — at 10 VUs and 6.76 iter/s the average
iteration is in the system for 1.48 s, of which 1 s is the deliberate think time.
Declining throughput past the peak is worse than flat: that is contention cost,
where added concurrency makes the system do *less* total work.

So the honest reading of the original matrix is not "it broke at 500 users." It is
"capacity was reached at roughly 10 concurrent clients, and 100/500/1000 were
measuring the queue."

---

## 5. "Why is the baseline p95 what it is?" — the CPU budget

Have the decomposition ready, and lead with the contrast that rules out the
framework:

> On the same single core, in the same process, a static route served **500 req/s at
> p95 3.33 ms** with zero dropped iterations, and `/health` measured **4.19 ms p95**
> under real load. The endpoint mix managed **27 req/s**. So none of this is Node or
> Express — the entire gap is work being done per request.

Peak capacity of 6.76 iter/s means **148 ms of one core per iteration**, where one
iteration is `/health` + sign-in + users-list + user-by-id. Against that budget:

| cost | measured | how |
|---|---|---|
| bcrypt compare, cost 10 | **54.8 ms** | 20 serial compares timed on this hardware |
| `JSON.stringify` of the users response | **7.36 ms** | 1001 rows of the real column shape, 200 iterations |
| all three Postgres queries combined | **2.33 ms** | `pg_stat_statements`: 2.20 + 0.07 + 0.06 ms mean |
| Arcjet, per request, as-built | **~75 ms** | 426–475 ms/iteration as-built vs 148 bypassed, over 4 requests |

Two things to draw out of that table. First, **the request mix is exactly 25%
sign-ins**, so one request in four runs a 54.8 ms key derivation — that alone is 37%
of the whole per-iteration budget. bcrypt being slow is **not a bug**; it is the
security/throughput trade-off the cost factor exists to make, and anyone who
"optimises" it by lowering the cost has made the system worse.

Second, the 7.36 ms of serialization *understates* the users-list cost, and you
should say why: node-postgres must also parse 1001 rows off the wire in text
format, and drizzle must map them into objects, before `JSON.stringify` even
starts. Each of those responses ships **167 KiB**. The query itself is
`src/services/users.service.js:6-15` — a `SELECT` with no `LIMIT` and no `ORDER BY`,
returning the entire table on every read. That is the real optimisation target, and
notice that it is expensive in the *application*, not in the database.

The remaining ~86 ms of the 148 ms budget is those row-mapping costs plus the
Express stack — helmet, cors, json, cookieParser, morgan — running four times per
iteration.

Last point: a blended p95 across four endpoints with these wildly different cost
profiles describes no actual user, which is why `benchmarks/k6/lib/metrics.js`
defines a separate `Trend` per endpoint. `/health` at 4.19 ms and sign-in at 164 ms
in the same average is a meaningless number.

---

## 6. "So your API only handles seven users?"

The trap question, and the one where an overclaim will cost you the interview. Two
of the four causes are choices *you* made in the harness, not properties of the
code, and you must volunteer that rather than be caught by it.

`APP_CPUS=1.0` is a deliberate pin so future phases stay comparable — nobody runs a
production API on one core. And a mix that is 25% authentication is nothing like
real traffic, where you would see one sign-in per hundreds of reads. Fix the mix
alone and the bcrypt term nearly vanishes from the average.

So the weak version of the claim and the strong version:

> ❌ "My API collapsed at five concurrent users."
>
> ✅ "On one pinned core, a read-heavy mix with 25% authentication topped out at 6.8
> iterations per second. I can attribute ~75 ms per request to third-party
> middleware, 54.8 ms to bcrypt on a quarter of requests, and the rest to an
> unpaginated query serializing 167 KiB per response — while the same process served
> 500 req/s on a static route."

The first is an anecdote and invites "what was the mix? how much CPU?" with no
answer ready. The second is a capacity analysis.

### Is any of this unusual?

The individual patterns, not at all — and saying so demonstrates perspective rather
than excusing the code. Returning an entire table with no `LIMIT` is close to the
most common performance bug in Express APIs. Putting a password KDF in the hot path
with no throttling in front of it is next. Mounting third-party security middleware
ahead of every route including health checks is routine; plenty of production
services call a bot-detection API on `/health` and never notice. Running a single
instance on a fraction of a CPU is normal for anything on a hobby tier.

What is unusual is having the numbers to prove which one costs what.

---

## 7. "How do you know it wasn't the database?"

The reflex answer to a slow API is "index it" or "the query is slow." Here the
evidence says otherwise, and having ruled it out is worth more than having fixed it.

From `pg_stat_statements.txt`, captured over the whole matrix:

| query | calls | mean |
|---|---:|---:|
| unbounded `select … from users` | 5,090 | **2.20 ms** |
| sign-in lookup by email | 5,100 | **0.07 ms** |
| by-id lookup | 5,084 | **0.06 ms** |

Roughly **11.9 seconds** of total Postgres execution time across runs that were
reporting 15–60 second requests. `EXPLAIN (ANALYZE, BUFFERS)` in
`explain-users-list.txt` shows the users scan at **0.335 ms execution**, 21 shared
buffer hits, entirely cached.

So Postgres contributed about 2 ms to a 15,000 ms request — roughly one hundredth of
one percent. The unbounded `SELECT` is still the right Phase 3 target, but for the
correct reason: the cost is in shipping and serializing 1001 rows in Node, not in
the database reading them. Fixing it with an index would have achieved nothing;
pagination is what helps.

There is a second, sharper form of the same evidence: k6 sent 11,037 users-list
requests and Postgres logged 5,090 calls of that shape. More than half of all
requests never issued SQL at all — and that comparison is conservative, because the
Postgres counters also include the discarded warm-up runs. Same finding as the 1220
resets in §3, arrived at independently from the server side.


---

## 8. "You disabled the security middleware to benchmark. Isn't that cheating?"

Expect this, because it looks bad until explained.

The as-built middleware calls Arcjet on every request. A baseline taken with it
inline is partly a measurement of somebody else's product, so if you then optimise
your database and claim the resulting p95 drop, you are claiming credit for having
removed a third-party dependency. So the run records **both** variants at every
concurrency level and the report prints the delta as an explicit attribution table.
The flag is double-guarded — `BENCH_BYPASS_SECURITY === '1'` *and*
`NODE_ENV !== 'production'` — and `tests/bench-guard.test.js` asserts production
cannot be bypassed for any flag value. Both the flag and the dependency are deleted
in Phase 1.

The general principle: **when a measurement has a confound you cannot remove,
measure it both ways and publish both.**

### What the two variants actually revealed

Worth getting right, because the naive assumption is wrong. The intuition is
"network round-trip, so it adds latency." The measurement says it adds **CPU**, and
that it *caps throughput* rather than merely inflating percentiles:

| VUs | p95 as-built | p95 bypassed | Arcjet share of p95 | throughput lost |
|---:|---:|---:|---:|---:|
| 5 | 695.18 ms | 87.68 ms | **87.39%** | 45.24% |
| 10 | 1501.58 ms | 292.09 ms | **80.55%** | 66.86% |
| 50 | 6407.28 ms | 3590.53 ms | 43.96% | 54.34% |

Requests/s is pinned near 9 as-built against 15–27 bypassed regardless of
concurrency, which is what identifies it as a serialised CPU cost on a single core
rather than concurrent I/O wait — concurrent network waits would overlap and
throughput would scale. Consistent with `@arcjet/analyze-wasm` performing local WASM
analysis per request, though that mechanism is inferred rather than proven and you
should label it that way.

Two caveats to state before anyone finds them. First, an earlier draft of this
document put Arcjet's share of p95 at 43% — that figure was computed between two
timeout-censored rows and is invalid; the uncensored low-VU rows above are the
correct attribution. Second, look at `/health`, which does no I/O whatsoever:
**4.19 ms bypassed, 404.69 ms as-built.** That is the cost with every other variable
removed.

---

## 9. "What did you find that surprised you?"

Four things. The second is the best story because it is about your own work.

### The security middleware fails open — and was enforcing nothing

`src/middleware/security.middleware.js` checks `decision.isDenied()` and its
`reason.*` predicates. But `@arcjet/node` has a third outcome: when it cannot reach
its API, `protect()` returns a decision whose conclusion is `ERROR`. That is not
`isDenied()`, so control falls through to `next()` and the request is served with
**no** rate limiting, bot detection, or shield.

Verified rather than assumed — probing the decision object directly with no key and
no egress:

```
decision.conclusion = ERROR | isDenied = false | isErrored = true
error reason: Failed to establish tunnel to decide.arcjet.com:443
```

There is no log line and no metric on that path, so in production this degradation
would be invisible.

The benchmark then confirmed it end to end: `ARCJET_KEY` is empty in `.env.bench`,
and the **403 column of the failure table is zero for all fourteen runs** — while
line 25 of that middleware configures a `LIVE` sliding window of 5 requests/minute
for `guest`. A rate limiter that let 27,000 requests through in a run where it was
configured to allow five per minute is not a rate limiter.

The corollary is worth stating because it is counter-intuitive: **supplying a
working key would not have improved these runs, it would have ended them.** Every VU
shares one source IP, so at 5 req/min per IP the entire matrix becomes 403s.

The reframe: replacing Arcjet is not about avoiding a dependency, it is about
**owning the failure policy**. Fail-open vs fail-closed belongs to the application
and must be explicit, logged, and per-route — a login endpoint should probably fail
closed, a health endpoint should probably fail open. Any dependency in the request
path needs that decision made deliberately, plus a timeout and a circuit breaker.

### My own benchmark was measuring the wrong thing

The stronger answer, because it shows you review your own work adversarially.

The first version of the load script signed in as a random seeded user and then
called `GET /api/users`. All seeded users have role `'user'`. That route is guarded
by `authorize('admin')` at `src/routes/users.routes.js:15`, and `authorize` returns
403 from middleware **before** the controller runs
(`src/middleware/auth.middleware.js:35-40`).

So every `users_list` sample would have measured the cost of a middleware
rejection — a few hundred microseconds — instead of the unbounded `SELECT`, which is
the single most important optimisation target in the project. The run would have
completed. The numbers would have looked plausible. And the entire Phase 3
pagination comparison would have been measured against a baseline that never touched
the database.

Fixed with four independent guards: k6's `setup()` authenticates once as a dedicated
admin and throws if it can't; the seeder upserts that admin on every invocation
including the already-seeded path; the runner probes admin sign-in before starting
the matrix; and the k6 check asserts `status === 200` rather than tolerating 403.

The generalisable lesson: **a load test that silently measures the wrong code path is
more dangerous than one that fails**, because it produces confident numbers. Assert
on the response you expect, not merely on the absence of errors.

### My report was easy to misread, which is its own defect

The first generated summary showed `failed 88.75%` next to `5xx 0.00%` and left the
status-0 count in a different table. Both numbers were correct and the conclusion a
reader drew from them was wrong — the natural reading was "the app is erroring", and
the first hypothesis it produced was an expired third-party account. Nobody had
mis-measured anything; the presentation did the damage.

Fixes were to the report, not the app: censored quantiles marked `†`, a `p95 served`
column, a dedicated failure-attribution table splitting status 0 from 4xx/5xx/429/403,
a computed knee section, and refusal to print a variant delta between two censored
rows. **A benchmark report is a user interface, and a number that is technically true
but reliably misread is a defect in it.**

### And one that constrains the whole harness

`deploy.resources.limits` in a compose file is honoured by Compose V2 but was
silently ignored by Compose V1, where the equivalent keys were top-level `cpus` and
`mem_limit`. If that had gone unnoticed, "resource-pinned benchmark" would have been
false and every comparison void. The runner now reads `HostConfig.NanoCpus` and
`HostConfig.Memory` back through `docker inspect` and refuses to continue if either
is zero. Trust the observed state, not the config file.

---

## 10. "Why warm-up, cool-down, and pinned versions?"

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

## 11. "Why commit raw benchmark output to the repo?"

Because a number in a README is an assertion and a committed artifact is evidence.
`benchmarks/scripts/report.mjs` regenerates the markdown tables from the raw JSON, so
the docs cannot drift from the data.

The judgement call worth explaining is *which* artifacts. Committed: 17 raw result
JSONs plus the five derived artifacts, **168 KB total** — small enough that there is
no argument for leaving it out, and it is exactly what `report.mjs` reads, so the
tables are regenerable by anyone. Excluded: the **9.8 MB** of per-request
`--out json` sample streams, distilled first into the 4 KB
`failure-attribution.txt` so the evidence survives the deletion. Also removed:
`--summary-export`, which was writing 14 files totalling 168 KB that **nothing ever
read** — `report.mjs:31` explicitly filtered them out while `baseline.js`'s own
`handleSummary` already wrote the same aggregates plus the `meta` block the report
needs.

The principle: commit what a reviewer needs to reproduce your claim, distil what is
merely large, and delete what nothing consumes.

---

## 12. "Talk me through your `.gitignore` and `.gitattributes`."

Small, but it comes up as a code-review question, and there were three distinct
bugs.

- `coverage/` (38 files) and `logs/` were tracked, so every local test run produced
  a dirty tree — which also breaks the "results must be attributable to one commit"
  rule the benchmark runner enforces.
- `.gitignore` had `logs/*` **after** those files were already tracked. Gitignore
  does not apply to tracked paths, so the rule did nothing. Fixing it requires
  `git rm --cached`.
- The pattern `.env.*` also matched `.env.example`, so the template a new
  contributor needs was unstageable. Fixed with a negation — `!.env.example` — which
  only works if it comes *after* the broad rule.

The visible consequence of the first bug is a good concrete detail. `f2cedf5`
committed jest's `lcov-report`, which is **218,208 bytes of HTML**, so GitHub's
language bar read **HTML 80.8%, JavaScript 14.8%** for a backend API with no
frontend. `be01992` removed the files, but Linguist caches per repository and the bar
persisted. The arithmetic confirms the diagnosis rather than guessing at it: 218 KB
of HTML at 80.8% implies a ~270 KB total, putting CSS at ~5.4 KB against the 6,070
bytes actually present and JavaScript at ~40 KB against 26,976 bytes of coverage JS
plus ~13 KB of `src/`. Every slice matches the tree as it was at `f2cedf5`.

`.gitattributes` fixes it permanently and forces a recalculation:
`coverage/** linguist-vendored` so a stray commit can never skew it again,
`benchmarks/v0-baseline/results/** linguist-generated` so 17 machine-written JSONs
collapse in diffs instead of inviting line-by-line review (with `SUMMARY.md` and
`failure-attribution.txt` deliberately excluded from that rule — those are the
human-facing artifacts), and `drizzle/** linguist-generated` because drizzle-kit
writes those migrations.

It also sets `* text=auto eol=lf` with explicit `eol=lf` on `*.sh` and the
Dockerfile. This repo is meant to be forked, and a shell script checked out with CRLF
on Windows fails with an obscure `\r: command not found`. Verified with
`git add --renormalize .` that it produces zero changes to existing files, so it
costs nothing today and prevents that failure later.

Worth stating what was deliberately *not* done: the 218 KB of HTML is still in
history, so every clone downloads it. Removing it needs `git filter-repo` and a force
push, which rewrites every commit SHA and breaks existing clones. For 362 KB total
that trade is not worth making, and it has no effect on the language bar since
Linguist only reads the current tree.

---

## 13. "What's your gitleaks setup actually doing?"

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

## 14. "What would you do differently?"

Good answers, all true here:

- The open-model probe measures the wrong thing. `saturation.js` hits a static route
  with security bypassed, so it reports Express routing throughput rather than the
  capacity of the real mix, and consequently never drops an iteration even at 500
  rps. Pointing it at `baseline.js`'s mix is the fix.
- The load mix is 25% authentication, which no real workload resembles. It makes
  bcrypt dominate a *read-heavy* benchmark and depresses every throughput number.
  A realistic ratio would be one sign-in per few hundred reads.
- Benchmarking from the same host that runs the app means the load generator
  competes for CPU with the thing being measured. A separate machine, or at least
  a pinned CPU set, would be better. Worth stating as a known limitation rather
  than hoping nobody asks.
- Only one metric source at v0 — client-side k6 timings. Server-side latency
  histograms (Phase 6) will let you separate queue time from service time, which
  client-side numbers cannot distinguish, and would have identified the 15 s RST
  in §3 immediately.
- The `v0-baseline` tag was created two commits before the run it labels. `src/` is
  identical across both, which is why the results still stand, but "tag before
  measuring" was a stated rule and it slipped. The `src` tree hash in the
  fingerprint is the guard that makes it detectable.
- No p99.9. At these request volumes the p99.9 bucket has too few samples to be
  meaningful, so reporting it would be false precision.

---

## Phase 1 priorities, in evidence order

Not an interview question, but the thing every interviewer asks next — and the
ordering is the point, because it comes from measurement rather than instinct:

1. **Remove Arcjet.** ~75 ms of CPU per request, ~3× throughput (2.2 → 6.8 iter/s),
   and it was enforcing nothing. Replace with self-built rate limiting that owns its
   failure policy explicitly.
2. **Set `max` on the pg pool.** `src/config/database.js:11-13` constructs
   `new Pool()` with no `max`, so node-postgres defaults to 10 connections against
   `PG_MAX_CONNECTIONS=200`, and `connectionTimeoutMillis` defaults to 0 — wait
   forever for a slot.
3. **Paginate the users list.** 1001 rows and 167 KiB per response, where the cost is
   Node-side serialization rather than the 2.20 ms query.
4. **Fix the benchmark mix and the saturation scenario** before claiming any of the
   above as an improvement.

The framing worth keeping: **the largest single win in Phase 1 is deleting a
dependency, not adding one.** That is an unusual thing to be able to say with numbers
behind it, and it is the most interesting sentence in this document.

---

## The one-sentence version

> I tagged the unmodified service and measured it under closed- and open-model load
> across seven concurrency levels with pinned CPU and memory, in two variants so the
> third-party middleware in the request path could be attributed separately. The
> honest result is that capacity is ~6.8 iterations/s on one core — I can account for
> it to the millisecond: ~75 ms/request of Arcjet, 54.8 ms of bcrypt on a quarter of
> requests, and an unpaginated query shipping 167 KiB — and the 89% "failure" rate at
> high concurrency is entirely client abandonment, split by error code into server
> resets at 15 s and client timeouts at 60 s, with zero HTTP errors anywhere in the
> matrix.
