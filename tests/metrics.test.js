// ---------------------------------------------------------------------------
// The metrics layer.
//
// Two things are being verified, and the second is the one that matters operationally:
//
//   1. the exposition format is actually valid — cumulative buckets, `+Inf` equal to
//      `_count`, escaped label values, sorted label keys. A malformed payload is silently
//      dropped by Prometheus, so "the endpoint returns 200" is not evidence of anything.
//   2. label cardinality is bounded. `route` must be a route PATTERN; if a request path
//      containing an id ever reaches a label value, every id becomes a time series and the
//      monitoring system is the thing that falls over.
// ---------------------------------------------------------------------------
import request from 'supertest';
import { Registry, Counter, Histogram } from '#metrics/registry.js';
import { routeLabel } from '#metrics/collectors.js';
import app from '#src/app.js';

describe('exposition format', () => {
  it('renders HELP, TYPE and a value', () => {
    const reg = new Registry();
    const c = reg.counter('widgets_total', 'Widgets produced.', ['colour']);
    c.inc({ colour: 'red' }, 3);

    expect(reg.render()).toBe(
      [
        '# HELP widgets_total Widgets produced.',
        '# TYPE widgets_total counter',
        'widgets_total{colour="red"} 3',
        '',
      ].join('\n')
    );
  });

  it('treats label order as insignificant, so one measurement is one series', () => {
    // Otherwise the same observation recorded from two call sites in different key order
    // would appear as two series and every rate() over it would be half the truth.
    const c = new Counter('c_total', 'help', ['a', 'b']);
    c.inc({ a: '1', b: '2' });
    c.inc({ b: '2', a: '1' });

    expect(c.series.size).toBe(1);
    expect(c.render()).toContain('c_total{a="1",b="2"} 2');
  });

  it('rejects an unknown label instead of inventing a series', () => {
    const c = new Counter('c_total', 'help', ['method']);
    // A typo'd label name creates a second series, which reads as a gap in a graph rather
    // than as a bug.
    expect(() => c.inc({ methd: 'GET' })).toThrow(/Unknown label/);
  });

  it('refuses to let a counter go backwards', () => {
    const c = new Counter('c_total', 'help');
    expect(() => c.inc({}, -1)).toThrow(/may not decrease/);
    // `setTotal` mirrors an external total and ignores a decrease rather than applying it: a
    // counter that drops tells Prometheus the process restarted.
    c.setTotal({}, 10);
    c.setTotal({}, 4);
    expect(c.render()).toContain('c_total 10');
  });

  it('escapes label values and help text', () => {
    const c = new Counter('c_total', 'A "quoted"\\odd help', ['path']);
    c.inc({ path: 'a"b\\c' });
    const out = c.render();

    expect(out).toContain('c_total{path="a\\"b\\\\c"} 1');
    expect(out.split('\n')[0]).toBe('# HELP c_total A "quoted"\\\\odd help');
  });

  it('rejects an invalid metric name', () => {
    expect(() => new Counter('9lives', 'help')).toThrow(/Invalid metric name/);
  });
});

describe('histogram', () => {
  it('is cumulative, with +Inf equal to _count', () => {
    const h = new Histogram('h_seconds', 'help', [], [0.1, 1]);
    for (const v of [0.05, 0.5, 5]) h.observe({}, v);
    const lines = h.render().split('\n');

    // 0.05 only; 0.05 + 0.5; all three. A non-cumulative histogram is the most common way to
    // produce a graph that is wrong in a plausible direction.
    expect(lines).toContain('h_seconds_bucket{le="0.1"} 1');
    expect(lines).toContain('h_seconds_bucket{le="1"} 2');
    expect(lines).toContain('h_seconds_bucket{le="+Inf"} 3');
    expect(lines).toContain('h_seconds_count 3');
    expect(lines).toContain('h_seconds_sum 5.55');
  });

  it('keeps labels on every series line', () => {
    const h = new Histogram('h_seconds', 'help', ['route'], [1]);
    h.observe({ route: '/api' }, 0.5);
    const out = h.render();

    expect(out).toContain('h_seconds_bucket{route="/api",le="1"} 1');
    expect(out).toContain('h_seconds_sum{route="/api"} 0.5');
  });
});

describe('route labels are bounded', () => {
  it('uses the mounted route pattern, not the request path', () => {
    expect(routeLabel({ baseUrl: '/api/deals', route: { path: '/:id' } })).toBe('/api/deals/:id');
    expect(routeLabel({ baseUrl: '/api/deals', route: { path: '/' } })).toBe('/api/deals');
    expect(routeLabel({ baseUrl: '', route: { path: '/health' } })).toBe('/health');
  });

  it('collapses anything unmatched into one series', () => {
    // The cardinality guard. Without it, a scanner walking URLs mints a time series per URL,
    // held in this process and again in Prometheus.
    expect(routeLabel({ originalUrl: '/nope/12345', path: '/nope/12345' })).toBe('unmatched');
  });
});

describe('GET /metrics', () => {
  it('serves the Prometheus content type and counts real traffic', async () => {
    await request(app).get('/api').expect(200);

    const res = await request(app).get('/metrics').expect(200);
    // Express reorders the parameters (charset before version), which is fine — the format
    // version is what a scraper reads.
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-type']).toMatch(/version=0\.0\.4/);

    expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/api"[^}]*status="200"\} \d+/);
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text).toContain('http_request_duration_seconds_bucket{');
    // Registered even with no pool configured — the collector simply contributes no series,
    // which is different from the metric not existing.
    expect(res.text).toContain('# TYPE pg_pool_max gauge');
    expect(res.text).toContain('# TYPE rate_limit_rejected_total counter');
  });

  it('never puts a request path into a label', async () => {
    await request(app).get('/definitely-not-a-route/98765').expect(404);

    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).not.toContain('98765');
    expect(res.text).toMatch(/route="unmatched"/);
  });

  it('requires the token when one is configured', async () => {
    process.env.METRICS_TOKEN = 'a-long-enough-metrics-token';
    try {
      await request(app).get('/metrics').expect(401);
      await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token-value')
        .expect(401);
      await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer a-long-enough-metrics-token')
        .expect(200);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  it('is not rate limited', async () => {
    // Same reasoning as the probes: a limiter in front of the endpoint that reports
    // saturation stops the data arriving exactly when it matters.
    const res = await request(app).get('/metrics').expect(200);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });
});
