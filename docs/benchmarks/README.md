# Benchmark Results

This directory contains benchmark analysis and performance measurements across different versions of the Acquisitions API.

## Benchmark Versions

### [v0-baseline](./v0-baseline/)
Initial baseline measurements before optimization work.

**Contents:**
- [Summary](./v0-baseline/summary.md) - Overall performance summary
- Query execution plans
- pg_stat_statements analysis
- Failure attribution analysis

**Key Metrics:**
- Baseline latency measurements
- Initial bottleneck identification
- Pre-optimization resource usage

### [v3-postgres](./v3-postgres/)
PostgreSQL optimization results including keyset pagination and query improvements.

**Contents:**
- [Explain Summary](./v3-postgres/explain-summary.md) - Query optimization summary
- Keyset pagination analysis (first page, deep pagination, owner-scoped)
- Offset pagination comparison
- Pipeline summary query analysis
- Transaction isolation anomaly testing

**Key Improvements:**
- Keyset pagination for efficient deep pagination
- Optimized queries with proper indexes
- Reduced database round trips

## How to Run Benchmarks

See the [Benchmarking Guide](../getting-started/benchmarking-guide.md) for detailed instructions on reproducing these results.

## Navigation

Return to [Documentation Index](../README.md)
