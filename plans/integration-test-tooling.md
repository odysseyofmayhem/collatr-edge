# Integration Test Tooling — Task Plan

**Goal:** Build the scripts and tooling to run CollatrEdge against the factory simulator and verify correctness.
**Scope:** T1-T3 automated verification (connectivity, accuracy, completeness). T4-T6 semi-automated.
**Language:** Bun/TypeScript (same as Edge)
**Location:** `test/integration/`

---

## Prerequisites Verified

- [x] OPC-UA input plugins fully supported via TOML config (`[[inputs.opcua]]` → `OpcuaInput` + `RealOpcuaClient`)
- [x] Simulator seed: `--seed 42` CLI arg, or `random_seed: 42` in YAML config
- [x] Simulator output volume: `./output:/app/output` mounted in docker-compose.yml
- [x] Simulator health port: 8081 on host (avoids Edge WebUI on 8080)
- [x] CollatrEdge config: `../collatr-factory-simulator/configs/collatr-edge-packaging.toml`

## Seed Configuration for Docker Compose

To run the simulator with a fixed seed, override the command in docker-compose.yml or at runtime:

```bash
# Runtime override (no file change needed):
docker compose run --rm -p 502:502 -p 4840:4840 -p 8081:8080 -p 1883:1883 \
  factory-simulator --seed 42 --ground-truth-path /app/output/ground_truth.jsonl

# Or add to docker-compose.yml command:
command: ["--seed", "42", "--ground-truth-path", "/app/output/ground_truth.jsonl"]
```

Default (no seed) = time-based random. For reproducible testing, always pass `--seed`.

---

## Task Breakdown

### Task 0: Edge TOML Config for Simulator

**File:** `configs/factory-sim-packaging.toml` (in Edge repo)

Create a local Edge config file based on `../collatr-factory-simulator/configs/collatr-edge-packaging.toml` with adjustments:
- Output paths relative to Edge repo CWD (`./data/factory-sim-packaging/`)
- WebUI on port 8080 (simulator health on 8081, no conflict)
- File output enabled for JSONL verification log
- All three protocols configured (Modbus :502, OPC-UA :4840, MQTT :1883)

Why a local copy: the simulator repo's config has output paths relative to the simulator directory. We need paths relative to Edge's CWD. Also lets us add test-specific tweaks without changing the simulator repo.

### Task 1: Run Script

**File:** `test/integration/run-sim-test.sh`

Shell script that orchestrates a test run:

1. Check Docker is running, simulator image is built
2. Clean previous test output (`data/factory-sim-packaging/`, `../collatr-factory-simulator/output/`)
3. Start simulator via docker compose (with seed 42) in `../collatr-factory-simulator/`
4. Wait for health endpoint (`curl http://localhost:8081/health`)
5. Start Edge (`bun run src/cli.ts run --config configs/factory-sim-packaging.toml`) in background
6. Wait for specified duration (default 10 minutes, configurable via arg)
7. Stop Edge (SIGTERM)
8. Stop simulator (`docker compose down`)
9. Run verification: `bun run test/integration/verify-edge-data.ts`
10. Report PASS/FAIL exit code

Usage: `./test/integration/run-sim-test.sh [duration_minutes]`

### Task 2: Signal Name Mapping

**File:** `test/integration/signal-map.ts`

TypeScript module defining the mapping between:
- Batch CSV `signal_id` (e.g. `press.line_speed`)
- Edge Modbus metric name (e.g. `press.line_speed`)
- Edge OPC-UA metric name (e.g. `press.line_speed`)
- Edge MQTT metric name (e.g. `collatr/factory/demo/packaging1/coder/ink_level`)

Also defines:
- Expected signal count per protocol
- Expected MQTT publish rates per topic (for completeness checks)
- Cross-protocol overlap table (signals available on multiple protocols)
- Counter signal names (for monotonicity checks)

Source: Simulator PRD Appendices A, B, C.

### Task 3: Data Readers

**File:** `test/integration/readers.ts`

Functions to parse the three data sources:

```typescript
// Read Edge JSONL output
function readEdgeMetrics(path: string): EdgeMetric[]

// Read simulator batch CSV (timestamp, signal_id, value, quality)
function readBatchCSV(path: string): SimSignalRow[]

// Read simulator ground truth JSONL (events only)
function readGroundTruth(path: string): GroundTruthEvent[]
```

Types:
```typescript
interface EdgeMetric {
  name: string;
  tags: Record<string, string>;
  fields: Record<string, string | number | boolean>;
  timestamp: bigint; // nanoseconds, wall-clock
}

interface SimSignalRow {
  timestamp: number; // sim_time seconds
  signalId: string;
  value: number | string;
  quality: string;
}

interface GroundTruthEvent {
  simTime: string; // ISO 8601
  event: string;
  [key: string]: unknown;
}
```

### Task 4: Verification Checks

**File:** `test/integration/verify-edge-data.ts`

Main verification script. Reads all data sources, runs checks, outputs report.

#### Check 1: Signal Enumeration (T1)

- List all unique metric names in Edge JSONL
- Group by protocol using `_device_id` tag (Modbus inputs, OPC-UA inputs, MQTT consumer)
- Compare against expected signal set from signal-map.ts
- Report: present, missing, unexpected

#### Check 2: Value Accuracy — MQTT (T2.4)

- For MQTT metrics, extract `fields.timestamp` (sim time ISO string) and `fields.value`
- If batch CSV is available: match by signal_id + nearest sim_time
- Report per-signal: count, mean error, max error

#### Check 3: Value Accuracy — Modbus/OPC-UA (T2.1, T2.3)

- Group Edge metrics by signal name
- Compute statistics: count, min, max, mean, stdev
- If batch CSV available: compare distributions (means within tolerance, ranges overlap)
- Report per-signal statistical comparison

#### Check 4: Cross-Protocol Consistency (T2.3)

- For signals in the overlap table, find Edge readings from different protocols at similar wall-clock timestamps
- Compare values: HR float32 vs OPC-UA Double (should be identical)
- Compare values: IR int16 x10 vs HR float32 (should be within ±0.1)
- Report: max discrepancy per signal pair

#### Check 5: Completeness (T3)

- Per-signal metric count vs expected (duration / poll interval * 0.95)
- Gap analysis: find sequences where timestamp gap > 3x expected interval
- Report: count, expected, actual, gap_count, max_gap

#### Check 6: Counter Monotonicity (T2.2)

- For counter signals (impression_count, good_count, waste_count, reel_count)
- Verify monotonically non-decreasing
- Check good_count + waste_count ≈ impression_count (within 10)
- Report: violations

#### Check 7: Local Store Integrity (T3.4)

- Open Edge SQLite daily files via `bun:sqlite`
- Run PRAGMA integrity_check
- Report: pass/fail per file

#### Output Format

```
=== CollatrEdge Integration Test Report ===
Config: configs/factory-sim-packaging.toml
Duration: 10 minutes
Seed: 42

--- T1: Signal Enumeration ---
Modbus:  48/48 signals ✅
OPC-UA:  32/32 signals ✅
MQTT:    17/17 topics  ✅
Missing: none

--- T2: Value Accuracy ---
[per-signal table with mean/max error]

--- T3: Completeness ---
[per-signal count and gap analysis]

--- Overall ---
PASS (or FAIL with details)
```

### Task 5: Semi-Automated Checks (T4-T6)

**File:** `test/integration/check-sustained.ts`
**File:** `test/integration/check-scenarios.ts`

Lighter scripts for manual runs:

**check-sustained.ts:** After a longer run (1-2 hours), checks:
- Memory stability (reads Edge process RSS from log if available, or from metrics.jsonl internal metrics)
- Data rate stability (compare metric rates at start vs end)
- Local store growth (file sizes)

**check-scenarios.ts:** After a scenario-rich run, reads ground truth + Edge data and checks:
- Were scenario events captured? (web break spike, state transitions)
- Reports which scenarios fired and whether Edge data contains expected patterns

---

## Implementation Order

| Task | What | Depends On | Effort |
|------|------|-----------|--------|
| 0 | Edge TOML config | — | 15 min |
| 2 | Signal name mapping | — | 30 min |
| 3 | Data readers | 2 | 1 hour |
| 4 | Verification checks | 2, 3 | 2-3 hours |
| 1 | Run script | 0, 4 | 30 min |
| 5 | Semi-automated checks | 3 | 1 hour |

Total: ~5-6 hours of implementation.

Tasks 0, 2, 3, 4 can be built and tested against sample data without the simulator running. Task 1 is the orchestration wrapper. Task 5 is lower priority.

---

## Files Created

```
collatr-edge/
├── configs/
│   └── factory-sim-packaging.toml        # Task 0
└── test/integration/
    ├── run-sim-test.sh                    # Task 1
    ├── signal-map.ts                      # Task 2
    ├── readers.ts                         # Task 3
    ├── verify-edge-data.ts                # Task 4
    ├── check-sustained.ts                 # Task 5
    └── check-scenarios.ts                 # Task 5
```
