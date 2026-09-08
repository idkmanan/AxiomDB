// ---------------------------------------------------------------------------
// A metrics registry, in about 150 lines, with no dependencies.
//
// WHY NOT `prom-client`. It is the obvious choice and it would be a reasonable one. Two
// reasons it is not the choice here, and the first is the honest one:
//
//   1. This sandbox has no npm registry access, so a dependency added here could not be
//      installed, imported or TESTED before being committed. A metrics layer nobody has
//      run is worse than one that is 150 lines of code you can read.
//   2. The Prometheus exposition format is a stable, documented text format — counters,
//      gauges and cumulative-bucket histograms. Owning it removes a dependency from the
//      request path and makes the cardinality rules (see `collectors.js`) explicit rather
//      than something a library hides.
//
// The trade, stated so it is not discovered later: no exemplars, no native histograms, no
// summary quantiles, no cluster aggregation, and `prom-client`'s default process metrics
// have to be picked by hand. If this project later wants any of that, swapping in
// `prom-client` is a contained change — `registry.metrics()` is the only surface the HTTP
// layer touches.
//
// WHAT THE FORMAT REQUIRES, and the parts people get wrong:
//   * a histogram's buckets are CUMULATIVE (`le="0.5"` counts everything ≤ 0.5), and the
//     final bucket must be `+Inf` and must equal `_count`
//   * counters only go up; a counter that resets tells Prometheus a process restarted
//   * label values need escaping, and unbounded label values are how a metrics endpoint
//     takes down the monitoring system it reports to
// ---------------------------------------------------------------------------

/** Escape a HELP string: newlines and backslashes only. */
const escapeHelp = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** Escape a label value: backslash, double quote, newline. */
const escapeLabel = (s) =>
  String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * A stable key for a label set, and a stable rendering of it.
 *
 * Sorted by label name so `{a="1",b="2"}` and `{b="2",a="1"}` are one series rather than
 * two — otherwise the same measurement recorded from two call sites in different key order
 * would silently double.
 */
function labelKey(labels) {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return '';
  return names.map((n) => `${n}="${escapeLabel(labels[n])}"`).join(',');
}

class Metric {
  constructor(name, help, labelNames = []) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
      throw new Error(`Invalid metric name: ${name}`);
    }
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    /** @type {Map<string, {labels: object, value: number}>} */
    this.series = new Map();
  }

  /** Reject unknown labels loudly: a typo'd label name creates a second series that looks
   *  like a gap in a graph rather than a bug. */
  validate(labels) {
    for (const name of Object.keys(labels)) {
      if (!this.labelNames.includes(name)) {
        throw new Error(`Unknown label "${name}" for metric ${this.name}`);
      }
    }
  }

  entry(labels) {
    this.validate(labels);
    const key = labelKey(labels);
    let e = this.series.get(key);
    if (!e) {
      e = { labels, value: 0 };
      this.series.set(key, e);
    }
    return e;
  }

  reset() {
    this.series.clear();
  }
}

export class Counter extends Metric {
  inc(labels = {}, amount = 1) {
    if (amount < 0) throw new Error(`Counters may not decrease (${this.name})`);
    this.entry(labels).value += amount;
  }

  /**
   * Mirror an absolute total that is maintained somewhere else.
   *
   * Exists for counters that already live in the module that owns the behaviour —
   * `rateLimitStats` in src/middleware/rate-limit.middleware.js is the case — so the
   * limiter does not have to import the metrics layer to be observable. A decrease is
   * ignored rather than applied: a counter that goes backwards tells Prometheus the
   * process restarted, and inventing that is worse than missing a data point.
   */
  setTotal(labels = {}, value) {
    const e = this.entry(labels);
    if (value > e.value) e.value = value;
  }

  render() {
    return renderSimple(this, 'counter');
  }
}

export class Gauge extends Metric {
  set(labels = {}, value) {
    this.entry(labels).value = value;
  }

  inc(labels = {}, amount = 1) {
    this.entry(labels).value += amount;
  }

  dec(labels = {}, amount = 1) {
    this.entry(labels).value -= amount;
  }

  /** A gauge whose value is read at scrape time — for anything already counted elsewhere
   *  (pool counters, `process.memoryUsage()`), where keeping a copy in sync would be a
   *  second source of truth. */
  collect(fn) {
    this.collector = fn;
    return this;
  }

  render() {
    if (this.collector) this.collector(this);
    return renderSimple(this, 'gauge');
  }
}

export class Histogram extends Metric {
  /**
   * @param {number[]} buckets upper bounds in the metric's own unit (seconds here)
   */
  constructor(
    name,
    help,
    labelNames = [],
    buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {
    super(name, help, labelNames);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  entry(labels) {
    this.validate(labels);
    const key = labelKey(labels);
    let e = this.series.get(key);
    if (!e) {
      e = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, e);
    }
    return e;
  }

  observe(labels = {}, value) {
    const e = this.entry(labels);
    e.sum += value;
    e.count += 1;
    // Cumulative: increment every bucket whose bound the value fits under. Linear because
    // the bucket list is short; a binary search here would be optimising the wrong thing.
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) e.counts[i] += 1;
    }
  }

  render() {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    for (const e of this.series.values()) {
      const base = labelKey(e.labels);
      const withLe = (le) => (base ? `{${base},le="${le}"}` : `{le="${le}"}`);
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket${withLe(formatBucket(this.buckets[i]))} ${e.counts[i]}`);
      }
      // `+Inf` is mandatory and must equal `_count`, otherwise the histogram is malformed
      // and Prometheus reports a lower total than was observed.
      lines.push(`${this.name}_bucket${withLe('+Inf')} ${e.count}`);
      lines.push(`${this.name}_sum${base ? `{${base}}` : ''} ${e.sum}`);
      lines.push(`${this.name}_count${base ? `{${base}}` : ''} ${e.count}`);
    }
    return lines.join('\n');
  }
}

/** Bucket bounds render as plain decimals; `1` must not become `1e+0`. */
const formatBucket = (b) => (Number.isInteger(b) ? String(b) : String(b));

function renderSimple(metric, type) {
  const lines = [
    `# HELP ${metric.name} ${escapeHelp(metric.help)}`,
    `# TYPE ${metric.name} ${type}`,
  ];
  for (const e of metric.series.values()) {
    const base = labelKey(e.labels);
    lines.push(`${metric.name}${base ? `{${base}}` : ''} ${e.value}`);
  }
  return lines.join('\n');
}

export class Registry {
  constructor() {
    /** @type {Map<string, Metric>} */
    this.metrics = new Map();
  }

  register(metric) {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Metric ${metric.name} is already registered`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name, help, labelNames) {
    return this.register(new Counter(name, help, labelNames));
  }

  gauge(name, help, labelNames) {
    return this.register(new Gauge(name, help, labelNames));
  }

  histogram(name, help, labelNames, buckets) {
    return this.register(new Histogram(name, help, labelNames, buckets));
  }

  /** The exposition text. A trailing newline is required by the format. */
  render() {
    const blocks = [];
    for (const metric of this.metrics.values()) blocks.push(metric.render());
    return `${blocks.join('\n')}\n`;
  }

  reset() {
    for (const m of this.metrics.values()) m.reset();
  }
}

export const registry = new Registry();
export default registry;
