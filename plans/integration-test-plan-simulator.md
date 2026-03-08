# Integration Test Plan: CollatrEdge vs Factory Simulator

**Goal:** Validate that CollatrEdge correctly collects data from the Collatr Factory Simulator across all three protocols, using the simulator's ground truth as the reference.

**Date:** 2026-03-07
**Status:** DRAFT

---

## Source Material

This plan is derived from the factory simulator PRD, specifically:

- **PRD 01 (Overview):** "Engineers connect CollatrEdge to the simulator and verify that data collection works across all three protocols. The simulator produces known patterns. Tests assert that CollatrEdge captures those patterns correctly."
- **PRD 11 (Success Criteria):** Sections 11.1 (Protocol Connectivity), 11.2 (Data Realism), 11.3 (Anomaly Detection), 11.4 (Continuous Operation), 11.5 (Time Compression)
- **PRD 12 (Evaluation Protocol):** Run configurations A/B/C, ground truth comparison, event-level metrics
- **PRD 13 (Test Strategy):** Cross-protocol consistency, integration test approach
- **PRD Appendix F (Implementation Phases):** Exit criteria for each simulator phase reference CollatrEdge directly
- **CollatrEdge PRD 22 (MVP Acceptance Criteria):** Scenarios 1-5

The simulator PRD explicitly states CollatrEdge integration as a primary use case. The exit criteria for simulator Phases 1-5 all specify CollatrEdge connection tests. This plan formalises those requirements into an executable test suite.

---

## What the Simulator Provides

### Packaging Profile (47 signals)

| Protocol | Signal Count | Key Details |
|----------|-------------|-------------|
| Modbus TCP (:502) | 48 registers | 29 HR (float32/uint32/uint16), 7 IR (int16 x10 + float32), 6 coils, 3 DI, ABCD byte order |
| OPC-UA (:4840) | 32 nodes | Doubles, UInt16/32, subscription-based, source timestamps |
| MQTT (:1883) | 17 topics | 11 coder, 2 env, 3+1 vibration, JSON payloads, mixed QoS/retain |

### Shared Infrastructure
- **Ground truth JSONL:** every signal value, scenario event, state change with simulated timestamp
- **Batch mode:** CSV/Parquet output with deterministic seed for offline comparison
- **Health endpoint:** `GET :8080/health` — profile, signal count, uptime
- **CollatrEdge configs:** `configs/collatr-edge-packaging.toml` ready to use
- **Docker Compose:** `docker compose up` starts simulator + Mosquitto

### Cross-Protocol Overlap (PRD 13.2, PRD 03)

These signals appear on multiple protocols and must produce consistent values:

| Signal | Modbus HR (float32) | Modbus IR (int16 x10) | OPC-UA (Double) |
|--------|---------------------|----------------------|-----------------|
| press.line_speed | HR 100 | — | Press1.LineSpeed |
| press.web_tension | HR 102 | — | Press1.WebTension |
| press.dryer_temp_zone_1 | HR 120 | IR 0 | Press1.Dryer.Zone1.Temperature |
| press.dryer_temp_zone_2 | HR 122 | IR 1 | Press1.Dryer.Zone2.Temperature |
| press.dryer_temp_zone_3 | HR 124 | IR 2 | Press1.Dryer.Zone3.Temperature |
| press.ink_temperature | HR 112 | IR 3 | Press1.Ink.Temperature |
| laminator.nip_temp | HR 400 | IR 4 | Laminator1.NipTemperature |
| laminator.tunnel_temp | HR 404 | IR 5 | Laminator1.TunnelTemperature |
| energy.line_power | HR 600 | IR 10-11 | PackagingLine.Energy.LinePower |

The simulator's signal store is single-writer (engine writes all signals per tick before any protocol adapter reads). All protocols read the same snapshot. Differences should only arise from encoding precision (float32 vs float64, int16 x10 quantisation).

---

## Test Suites

### T1: Protocol Connectivity (PRD 11.1)

**Maps to:** Simulator PRD 11.1, Appendix F Phase 1-2 exit criteria, CollatrEdge PRD Scenario 1
**Duration:** 10 minutes at 1x
**Seed:** Fixed (42)

> "CollatrEdge connects to the simulator via all three protocols and collects data continuously... with zero configuration changes to CollatrEdge beyond specifying the endpoint addresses."

#### T1.1 — Modbus: all register types collected

Start simulator (packaging, 1x, seed 42). Start Edge with `configs/collatr-edge-packaging.toml`. Run 5 minutes.

Assert per PRD Appendix A register map:
- **Holding registers (FC03):** All 29 HR signals have rows in local store. float32 values (line_speed, web_tension, temps, pressures) are non-zero floats. uint32 counters (impression_count, good_count, waste_count, reel_count) are non-negative integers. uint16 values (machine_state, fault_code) are in expected enum ranges (0-5 for state, 0-255 for fault).
- **Input registers (FC04):** All 7 IR signals collected. int16 x10 values (dryer temps, ink temp, laminator temps) produce reasonable temperatures when scaled (20-200 range). Float32 energy (IR 10-11) matches HR 600 energy reading.
- **Coils (FC01):** All 6 coil signals collected as boolean (0/1). press.running reflects machine_state == 2.
- **Discrete inputs (FC02):** All 3 DI signals collected as boolean (0/1).

#### T1.2 — OPC-UA: all nodes subscribed

Same run as T1.1.

Assert per PRD Appendix B node tree:
- All 32 PackagingLine leaf nodes have rows in local store
- Double nodes produce float values within documented ranges
- UInt16/UInt32 nodes produce integer values
- Source timestamps are present and plausible (within run window)
- Subscription delivery: data changes arrive without explicit polling

#### T1.3 — MQTT: all topics received and parsed

Same run as T1.1.

Assert per PRD Appendix C topic map:
- All 11 coder topics received (state, prints_total, ink_level, printhead_temp, ink_pump_speed, ink_pressure, ink_viscosity_actual, supply_voltage, ink_consumption_ml, nozzle_health, gutter_fault)
- Both env topics received (ambient_temp, ambient_humidity)
- All 3 per-axis vibration topics received (main_drive_x/y/z)
- JSON payload fields correctly extracted: `value` (number), `unit` (string), `quality` (string), `timestamp` (ISO 8601)

#### T1.4 — Web UI shows live data (CollatrEdge PRD Scenario 1)

> "live values appear in the Web UI within 60 seconds"

- Edge web UI at :8080 shows signals updating
- Dashboard has entries for all three protocol sources

---

### T2: Value Accuracy vs Ground Truth (PRD 12, PRD 13.2)

**Maps to:** Simulator PRD 12.2-12.4, PRD 13.2 (cross-protocol consistency)
**Duration:** 10 minutes at 1x
**Seed:** Fixed (42), ground truth logging enabled

> "The simulator produces known patterns. Tests assert that CollatrEdge captures those patterns correctly."

#### T2.1 — Modbus float32 values match ground truth

1. Parse simulator ground truth JSONL
2. Query Edge local store for same signals
3. Pair readings by nearest timestamp (within 2s window)
4. Assert: values match within float32 precision (relative error < 0.001 for values > 1.0)
5. Assert: no systematic bias (mean error across all pairs ~ 0)

Focus: press.line_speed, press.dryer_temp_zone_1, laminator.nip_temp, energy.line_power

#### T2.2 — Counter monotonicity and accuracy

- press.impression_count, press.good_count, press.waste_count are monotonically non-decreasing
- good_count + waste_count ≈ impression_count (PRD 02: press section)
- Final Edge value within 1 poll cycle of simulator's final value

#### T2.3 — Cross-protocol consistency (PRD 13.2)

> "Read the same signal via Modbus, OPC-UA, and MQTT. Verify all three return the same value (accounting for encoding precision differences between float32 Modbus and float64 OPC-UA)."

For each signal in the cross-protocol overlap table above:
- Compare Edge's Modbus-collected value vs Edge's OPC-UA-collected value at overlapping timestamps
- Assert: HR float32 and OPC-UA Double match (same source, different wire encoding)
- Assert: IR int16 x10 is within ±0.1 of the HR/OPC-UA value (quantisation from int16)

#### T2.4 — MQTT payload accuracy

- Compare MQTT-received coder values against ground truth
- Assert: printhead_temp within ±0.5°C of ground truth
- Assert: ink_level is monotonically decreasing (unless consumable refill event in ground truth)
- Assert: vibration values are non-negative floats in documented range (0-50 mm/s)

---

### T3: Data Completeness (PRD 11.1, 11.4)

**Maps to:** Simulator PRD 11.1 ("collects data continuously"), 11.4 ("zero data gaps")
**Duration:** 30 minutes at 1x

#### T3.1 — Modbus polling completeness

With 1s poll interval over 30 minutes:
- Each Modbus signal: row count >= 1710 (95% of 1800)
- No gap > 3s (3x poll interval)
- Timestamp intervals have stdev < 500ms

#### T3.2 — OPC-UA subscription completeness

With 1s publishing interval:
- Each OPC-UA node: data change count >= 1710 (95% of 1800)
- No gap > 5s (allows for network jitter)

#### T3.3 — MQTT message completeness

Per PRD Appendix C publish rates:
- Vibration (1s rate): >= 1700 messages per topic
- ink_pump_speed, ink_pressure (5s): >= 340 messages
- printhead_temp, ink_viscosity_actual (30s): >= 56 messages
- ink_level, supply_voltage, ink_consumption_ml, env signals (60s): >= 28 messages
- Event-driven (state, prints_total, nozzle_health, gutter_fault): >= 1 message each

#### T3.4 — Local store integrity

After run:
- `PRAGMA integrity_check` = "ok" on all daily files
- No NULL timestamps or fields
- Total metrics consistent across protocols

---

### T4: Sustained Operation (PRD 11.4, CollatrEdge PRD Scenario 3)

**Maps to:** Simulator PRD 11.4 ("7 consecutive days"), CollatrEdge PRD Scenario 3 ("24-hour standalone")
**Duration:** 2 hours at 1x (compressed from 24h acceptance)

> CollatrEdge PRD: "RSS stays ≤200MB, there are zero data gaps in the local store, and no restarts or interventions are required."

#### Method:
##### Start Collatr-Factory-Simulator docker (in collatr-factory-simulator repo):
```shell
docker compose up -d
```

##### Start Collatr-Edge (in collatr-edge repo):
```shell
bun run src/index.ts run --config configs/factory-sim-packaging.toml
```

##### Run test:
```shell
bun run test/integration/check-sustained.ts \
  --edge-jsonl ./data/factory-sim-packaging/metrics.jsonl \
  --data-dir ./data/factory-sim-packaging
```

###### Example output:
```
=== T4: Sustained Operation Check ===
Duration: 7200s (2.0h)

Loading Edge JSONL: ./data/factory-sim-packaging/metrics.jsonl
  Loaded 677057 metrics
  Internal metrics: 1967

--- T4.1: Memory Stability ---
  ✅ Memory data available — 281 samples
  ✅ RSS growth bounded — first=139.1MB, last=149.3MB, max=187.9MB, ratio=1.07x
  ✅ RSS under 200MB — max=187.9MB
  ✅ No monotonic RSS growth — Q1 mean=153.7MB, Q4 mean=160.5MB, growth=4.5%

--- T4.2: Connection Stability ---
  ✅ Zero gather errors — 0 gather errors
  ✅ Zero write errors — 0 write errors
  ✅ Zero dropped metrics — 0 metrics dropped

--- T4.3: Data Rate Stability ---
  ✅ Modbus rate stable (first 5min vs last 5min) — first=2709/min, last=2709/min, diff=0.0%
  ✅ MQTT rate stable (first 5min vs last 5min) — first=266/min, last=259/min, diff=2.5%

--- T4.4: Local Store Integrity ---
  ✅ SQLite files found — 1 file(s)
  ✅ data_2026_03_08.db integrity — ok, size=179252KB

=== Summary ===
Total checks: 11
Passed: 11 ✅
Failed: 0 ❌

RESULT: PASS
```

Testing

#### T4.1 — Memory stability

- RSS at t=5min, t=30min, t=60min, t=120min
- RSS at t=120min <= RSS at t=5min * 2.0
- No monotonic RSS increase trend

#### T4.2 — Connection stability

- Zero unplanned disconnects on any protocol (check Edge logs)
- Zero connection refused / timeout errors after initial connect

#### T4.3 — Data rate stability

- Metrics-per-second at t=5min vs t=115min within 10%
- No growing buffer backlog

#### T4.4 — Local store rotation

- If run crosses UTC midnight, daily file rotation works correctly
- File size grows linearly, not exponentially

---

### T5: Time Compression (PRD 11.5)

**Maps to:** Simulator PRD 11.5 ("At 10x speed, all signals produce values at 10x their configured rate. The protocol servers keep up. CollatrEdge collects data at the compressed rate without gaps.")

> Note: Edge polls at its own real-time interval. At Nx speed, the simulator produces data N times faster. Edge's 1s poll samples every N simulated seconds. We are testing that Edge keeps up and maintains stable connections, not that it captures every simulated tick.

#### T5.1 — 2x speed

`SIM_TIME_SCALE=2.0`, Edge 1s poll, 15 real minutes.
- Data collected for full duration, no gaps > 5s
- Signal values plausible (changing faster than 1x)

#### T5.2 — 5x speed

`SIM_TIME_SCALE=5.0`, 10 real minutes.
- Continuous collection, no connection errors
- MQTT burst handling: messages arrive at 5x rate, Edge processes without drops

#### T5.3 — 10x speed

`SIM_TIME_SCALE=10.0`, 10 real minutes.
- Stable connections on all protocols
- MQTT at 10x rate: vibration is 10 msg/s per axis — Edge handles burst
- Modbus timeout not exceeded (sim tick is 10ms at 10x, well within 5s timeout)

#### T5.4 — Batch mode offline comparison (PRD 12.5 Run C)

1. Run simulator batch mode: `--batch-output ./output --batch-duration 1h --batch-format csv --seed 42`
2. Run simulator live at 1x with seed 42 for 10 minutes
3. Run Edge against live for those 10 minutes
4. Compare Edge values against batch CSV for the overlapping window
5. Values match within float32 precision at nearest tick boundary

---

### T6: Scenario Data Capture (PRD 11.3)

**Maps to:** Simulator PRD 11.3 (Anomaly Detection table), PRD 05 (Scenario System)
**Duration:** Run long enough for scenarios to fire (use high frequency config or wait)

> Note: We are NOT testing anomaly detection here. We are testing that Edge faithfully captures the data patterns that scenarios produce. The ground truth tells us what happened; we verify Edge saw it.

#### T6.1 — Web break capture (PRD 11.3, PRD 05)

> "Threshold on web tension: Spike > 600 N followed by drop to 0"

- Edge local store contains web_tension spike (> 600N) at the time the ground truth records `scenario_start: web_break`
- press.machine_state transitions from 2 (Running) to 4 (Fault) visible in Edge data
- press.line_speed drops to 0

#### T6.2 — State machine transitions

Over a multi-hour run, Edge captures all machine states that appear in ground truth:
- Idle (0) -> Startup (1) -> Running (2) -> Shutdown (3)
- Shift changes: Running -> Idle gap -> Startup -> Running
- Fault events: Running (2) -> Fault (4)
- OPC-UA Press1.State shows same transitions as Modbus press.machine_state

#### T6.3 — Dryer drift (PRD 11.3)

> "CUSUM on (dryer_temp - setpoint): Sustained positive deviation over 30+ minutes"

- When ground truth logs `scenario_start: dryer_drift`, Edge data shows press.dryer_temp_zone_* values gradually diverging from setpoint values
- Deviation visible by scenario end

#### T6.4 — Counter and consumable events

- Shift change: counters reset or continue per config (visible in Edge data)
- Ink refill (consumable event in ground truth): coder.ink_level jumps back up in MQTT data

---

## Data Sources for Verification

Understanding what each source provides:

### Simulator Outputs

**Ground truth JSONL** (`output/ground_truth.jsonl`):
- **Events only** — scenario_start/end, state_change, signal_anomaly, data_quality, shift_change, consumable, sensor_disconnect, stuck_sensor, etc.
- NOT per-tick signal values. Cannot be used for value accuracy checks.
- Use for: T6 (scenario verification) — tells us WHEN events happened so we can check Edge captured them.

**Batch mode CSV** (`output/signals.csv`):
- **Full signal dump** — one row per signal per tick: `timestamp, signal_id, value, quality`
- timestamp is sim_time (seconds since epoch). signal_id is e.g. `press.line_speed`
- Written every 100ms tick for continuous signals, on-change for event-driven signals
- Use for: T2 (value accuracy) — the definitive reference for what values the simulator produced

### Edge Output

**Edge JSONL** (`data/factory-sim-packaging/metrics.jsonl`):
- One JSON object per collected metric: `{name, tags, fields, timestamp}`
- `timestamp` is Edge wall-clock in nanoseconds (NOT sim time)
- **MQTT metrics:** `name` is the full topic (`collatr/factory/demo/packaging1/coder/ink_level`). `fields` contains `{timestamp: "ISO sim time", value: N, unit: "...", quality: "..."}`. The `fields.timestamp` IS the simulator's sim time — this is the pairing key.
- **Modbus metrics:** `name` is the configured register name (`press.line_speed`). `fields` contains `{value: N}`. No sim time. Tag `_device_id` identifies the input plugin.
- **OPC-UA metrics:** similar to Modbus, `name` is the configured node name, `fields.value` is the reading.

### Time Alignment Strategy

The simulator runs from a simulated epoch (e.g. `2026-01-01T00:00:00Z`) while Edge records real wall-clock time. These are completely different.

**MQTT:** Use `fields.timestamp` (sim time ISO string) as the pairing key against batch CSV. Direct comparison possible.

**Modbus/OPC-UA:** No sim time in Edge output. Two approaches:
1. **Sequence-based pairing:** At 1x speed with 1s polling, the Nth Modbus poll corresponds to roughly the Nth second of sim time. Pair by ordinal position within each signal.
2. **Value matching:** For float signals, match Edge readings to batch CSV rows by value proximity (within float32 precision). Works when values are sufficiently unique.
3. **Practical approach:** For T2 accuracy checks, use value comparison rather than time pairing. Compare the statistical distribution (mean, stdev, min, max) of Edge values vs batch CSV values for each signal over the test window. Then spot-check specific values.

---

## Verification Tooling

### verify-edge-data.ts

Bun/TypeScript script in `test/integration/` (runs on Lee's dev machine alongside Docker). Same language as Edge — no Python dependency in the Edge repo.

**Run:** `bun run test/integration/verify-edge-data.ts`

**Inputs:**
1. Batch mode CSV: `../collatr-factory-simulator/output/signals.csv` (run separately with same seed)
2. Ground truth JSONL: `../collatr-factory-simulator/output/ground_truth.jsonl` (from live or batch run, via volume mount)
3. Edge JSONL: `./data/factory-sim-packaging/metrics.jsonl` (from live Edge run)

**Checks performed:**

1. **Signal enumeration (T1):** List all unique signal names in Edge JSONL. Compare against expected set (from batch CSV signal_id column + MQTT topic mapping). Flag missing signals.

2. **Value accuracy — MQTT (T2.4):** Parse Edge MQTT metrics. Extract `fields.timestamp` (sim time) and `fields.value`. Match to batch CSV rows by signal_id + nearest sim_time. Report per-signal mean/max absolute error.

3. **Value accuracy — Modbus/OPC-UA (T2.1, T2.3):** Parse Edge Modbus/OPC-UA metrics by `_device_id` tag. Compare value distributions (mean, stdev, min, max, percentiles) against batch CSV for same signal_id. Report statistical comparison. Spot-check: first/last values should be close.

4. **Cross-protocol consistency (T2.3):** For signals in the overlap table, compare Edge's Modbus-collected values vs Edge's OPC-UA-collected values at same wall-clock timestamps. Report max discrepancy.

5. **Completeness (T3):** Per-signal metric count in Edge JSONL. Compare against expected count (run duration / poll interval). Report gaps (sequences of missing readings).

6. **Counter checks (T2.2):** Verify monotonicity of counter signals. Check good_count + waste_count ~ impression_count.

7. **Scenario verification (T6):** Read ground truth JSONL for scenario events. For each scenario_start, check Edge data contains the expected signal pattern in a time window around that event (using wall-clock correlation — scenario_start sim_time maps to approximately the same offset from run start).

**Output:** PASS/FAIL summary with per-signal detail table.

### Signal Name Mapping

Edge metric names differ from batch CSV signal_ids:

| Batch CSV signal_id | Edge Modbus name | Edge OPC-UA name | Edge MQTT topic |
|---------------------|-----------------|-----------------|-----------------|
| press.line_speed | press.line_speed | press.line_speed | — |
| coder.ink_level | — | — | collatr/factory/demo/packaging1/coder/ink_level |
| vibration.main_drive_x | — | — | collatr/factory/demo/packaging1/vibration/main_drive_x |
| env.ambient_temp | — | — | collatr/factory/demo/packaging1/env/ambient_temp |

The verification script needs a mapping table from batch CSV signal_ids to Edge metric names. Modbus/OPC-UA names match directly. MQTT names need the topic prefix mapping.

---

## Execution Order

| Priority | Suite | Wall Clock | Blocking? |
|----------|-------|-----------|-----------|
| 1 | T1 (connectivity) | 10 min | Yes — nothing works if protocols don't connect |
| 2 | T2 (accuracy) | 10 min | Yes — core correctness |
| 3 | T3 (completeness) | 30 min | Yes — data quality |
| 4 | T6 (scenarios) | ~30 min | No — validates capture fidelity |
| 5 | T5 (time compression) | ~45 min | No — performance envelope |
| 6 | T4 (sustained) | 2 hours | No — stability/endurance |

---

## Decisions (2026-03-07, Lee)

1. **Edge deployment:** Bare process on dev machine host. Simulator in Docker on same host.
2. **Automation:** T1-T3 fully scripted (verify-edge-data.py). T4-T6 semi-automated (scripted checks after manual runs). Automated parts can optionally be driven via Claude Code using `/plans` directory format.
3. **CI:** Not yet. Manual integration test before releases. Revisit after test suite proven reliable.
4. **F&B profile:** Packaging first. F&B as a second pass (adds CDAB, multi-slave, OPC-UA-only signals).
5. **Network topology:** Collapsed mode first (default `docker compose up`). Realistic mode as a second pass.

## Directory Layout

Tests run from the `collatr-edge` repo directory. The simulator repo is adjacent:

```
~/Projects/DoublyGood/
├── collatr-edge/                    # CWD for test execution
│   ├── plans/                       # This plan + Claude Code task files
│   ├── test/integration/            # Verification scripts
│   ├── configs/                     # Edge TOML configs (smoke-test-public.toml)
│   └── data/factory-sim-packaging/  # Edge output (created at runtime)
│       ├── data_YYYY_MM_DD.db       # Local store SQLite
│       └── metrics.jsonl            # File output for verification
│
└── collatr-factory-simulator/       # Relative: ../collatr-factory-simulator/
    ├── docker-compose.yml
    ├── config/                      # Simulator YAML configs (mounted read-only)
    ├── configs/                     # CollatrEdge TOML configs for simulator
    │   └── collatr-edge-packaging.toml
    └── output/                      # Simulator output (needs volume mount)
        ├── ground_truth.jsonl       # Events log
        └── signals.csv              # Batch mode signal dump
```

---

## Prerequisites

1. Docker + Docker Compose on Lee's dev machine
2. Factory simulator image built (`docker compose build` in `../collatr-factory-simulator/`)
3. CollatrEdge compiled and runnable (`bun run src/cli.ts` or compiled binary)
4. Bun runtime for verification scripts (already available — Edge uses Bun)
5. Network: localhost — Edge on host reaches simulator Docker ports (502, 4840, 1883)

## Required: Simulator docker-compose.yml Change

**Problem:** The simulator's `docker-compose.yml` has no volume mount for the output directory. The ground truth JSONL is written to `/app/ground_truth.jsonl` (live mode) or `/app/output/` (batch mode) inside the container — inaccessible to host-side verification scripts.

**Fix:** Add an output volume mount to the `factory-simulator` service in `docker-compose.yml`:

```yaml
  factory-simulator:
    # ... existing config ...
    volumes:
      - ./config:/app/config:ro
      - ./output:/app/output           # ADD THIS — ground truth + batch output
    environment:
      # ... existing env ...
      # Override ground truth path to use the mounted output dir:
      # (or pass --ground-truth-path /app/output/ground_truth.jsonl via command)
```

Also need to ensure the live-mode ground truth writes to `/app/output/` not `/app/` (CWD). Options:
1. Pass `--ground-truth-path /app/output/ground_truth.jsonl` via Docker command override
2. Change the CLI default from `./ground_truth.jsonl` to `./output/ground_truth.jsonl`
3. Add a `SIM_GROUND_TRUTH_PATH` environment variable

Option 1 is simplest and doesn't require code changes. Add to docker-compose.yml:

```yaml
  factory-simulator:
    # ...
    command: ["--ground-truth-path", "/app/output/ground_truth.jsonl"]
```

This appends to the ENTRYPOINT. The output directory `/app/output` already exists in the image and is writable by the `simulator` user.
