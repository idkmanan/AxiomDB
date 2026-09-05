#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Phase 0 baseline runner — now a thin wrapper.
#
#   ./benchmarks/scripts/run-baseline.sh
#
# The implementation moved to run-phase.sh in Phase 1, when a second phase needed
# the same guardrails. This file is kept, rather than deleted, because it is cited
# by name in committed artifacts that must stay accurate:
#
#   benchmarks/v0-baseline/SUMMARY.md   (the "Reproduce" block)
#   BENCHMARKING.md
#   PROJECT_LIFECYCLE.md               (append-only — cannot be rewritten)
#   docs/INTERVIEW_PHASE_0.md §1       ("anyone can re-run …")
#
# A reproduction command that no longer exists turns committed evidence into a
# broken link, which is a worse outcome than one extra file.
#
# NOTE ON WHAT THIS NO LONGER REPRODUCES. The v0 matrix ran two variants per level
# via BENCH_BYPASS_SECURITY, and Phase 1 deleted that flag along with Arcjet. So
# this reproduces the v0 METHOD against the current code, not the v0 numbers — for
# those, check out the `v0-baseline` tag first:
#
#   git checkout v0-baseline && ./benchmarks/scripts/run-baseline.sh
# ---------------------------------------------------------------------------
set -euo pipefail
exec env PHASE=v0 "$(dirname "${BASH_SOURCE[0]}")/run-phase.sh" "$@"
