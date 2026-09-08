# Acquisitions Project Documentation

Welcome to the documentation hub for the Acquisitions project — a high-performance Node.js API for managing deals and notifications.

## Quick Navigation

### 📚 Getting Started
- [Benchmarking Guide](./getting-started/benchmarking-guide.md) - How to reproduce latency numbers and benchmark methodology

### 📋 Project Management
- [Project Lifecycle](./project-management/lifecycle.md) - Running record of how the project evolved through phases
- [Upgrade Plan](./project-management/upgrade-plan.md) - Initial audit and upgrade plan (2026-09-01)

### 🏗️ Architecture Decision Records (ADRs)
- [ADR Index](./adr/README.md) - All architectural decisions documented
  - [0001: Baseline Before Optimising](./adr/0001-baseline-before-optimising.md)
  - [0002: Own the Failure Policy](./adr/0002-own-the-failure-policy.md)
  - [0003: In-Process Limiter Then Redis](./adr/0003-in-process-limiter-then-redis.md)
  - [0004: One Database Driver](./adr/0004-one-database-driver.md)
  - [0005: Drop TypeScript](./adr/0005-drop-typescript.md)
  - [0006: Hand-Written Metrics](./adr/0006-hand-written-metrics.md)
  - [0007: Outbox Not Dual Write](./adr/0007-outbox-not-dual-write.md)
  - [0008: HPA on CPU](./adr/0008-hpa-on-cpu.md)

### 💬 Interview Documentation
- [Interview Phase 0](./interview/phase-0.md) - Initial phase requirements and design
- [Interview Phase 1](./interview/phase-1.md) - Authentication and user management implementation
- [Interview Phases 3-7](./interview/phases-3-to-7.md) - Deals, notifications, events, and deployment phases

### 📊 Benchmarks
- [Benchmark Results Index](./benchmarks/README.md) - Performance analysis across versions
  - [v0-baseline](./benchmarks/v0-baseline/) - Initial baseline measurements
  - [v3-postgres](./benchmarks/v3-postgres/) - PostgreSQL optimization results

### ☸️ Kubernetes
- [Kubernetes Deployment](./kubernetes/README.md) - Container orchestration and deployment configuration

## Project Overview

See the main [README.md](../README.md) at the repository root for project overview, current status, and quick start instructions.
