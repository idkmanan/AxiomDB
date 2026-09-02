// ---------------------------------------------------------------------------
// Shared benchmark configuration.
//
// Everything that affects comparability lives here, so a future phase cannot
// accidentally change the load shape and still call the result a comparison.
// ---------------------------------------------------------------------------

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Concurrency level for this run. The runner script invokes the same script
// three times with VUS=100, 500, 1000 so all three runs are byte-identical code.
export const VUS = Number(__ENV.VUS || 100);

// Steady-state duration. Ramp is added on top by the stages below.
export const DURATION = __ENV.DURATION || '2m';
export const RAMP_UP = __ENV.RAMP_UP || '30s';
export const RAMP_DOWN = __ENV.RAMP_DOWN || '15s';

// Free-text label recorded in the output so a result file is self-describing.
export const RUN_TAG = __ENV.RUN_TAG || 'unlabelled';

// ---------------------------------------------------------------------------
// Thresholds.
//
// These are deliberately LOOSE for the v0 baseline. The point of Phase 0 is to
// record reality, not to pass. A threshold that fails the run would stop the
// measurement we are trying to take. Later phases tighten these into a real
// SLO gate — that progression is itself the story.
//
// http_req_failed is the exception: if more than 95% of requests fail, the
// harness itself is broken and the run is meaningless, so stop early.
// ---------------------------------------------------------------------------
export const thresholds = {
  http_req_failed: [{ threshold: 'rate<0.95', abortOnFail: true, delayAbortEval: '30s' }],
  // Recorded, never enforced at v0. 'p(99)' included because tail latency is
  // where connection-pool and lock contention show up first.
  http_req_duration: ['p(50)>=0', 'p(95)>=0', 'p(99)>=0'],
};

// A single ramp-hold-drain shape, reused by every scenario.
export function stages() {
  return [
    { duration: RAMP_UP, target: VUS },
    { duration: DURATION, target: VUS },
    { duration: RAMP_DOWN, target: 0 },
  ];
}

// Tags attached to every metric so results can be sliced by run afterwards.
export function runTags() {
  return { run_tag: RUN_TAG, vus: String(VUS) };
}
