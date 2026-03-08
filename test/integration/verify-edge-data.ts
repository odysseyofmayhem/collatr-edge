#!/usr/bin/env bun
/**
 * CollatrEdge Integration Test Verification Script
 *
 * Reads Edge JSONL output + simulator batch CSV + ground truth JSONL,
 * runs T1-T3 checks, outputs a PASS/FAIL report.
 *
 * Usage:
 *   bun run test/integration/verify-edge-data.ts [options]
 *
 * Options:
 *   --edge-jsonl <path>     Edge metrics JSONL (default: ./data/factory-sim-packaging/metrics.jsonl)
 *   --batch-csv <path>      Simulator batch CSV (default: ../collatr-factory-simulator/output/signals.csv)
 *   --ground-truth <path>   Ground truth JSONL (default: ../collatr-factory-simulator/output/ground_truth.jsonl)
 *   --duration <seconds>    Expected test duration in seconds (default: 600 = 10 min)
 *   --poll-interval <ms>    Edge poll interval in ms (default: 1000)
 *   --completeness <ratio>  Minimum completeness ratio (default: 0.90)
 *   --accuracy <tolerance>  Relative accuracy tolerance for floats (default: 0.01)
 */

import { existsSync } from "node:fs";
import {
  readEdgeMetrics,
  readBatchCSV,
  readGroundTruth,
  groupByDeviceId,
  groupByName,
  groupBatchBySignal,
  computeStats,
  type EdgeMetric,
  type Stats,
} from "./readers";
import {
  DEVICE_ID,
  SIGNALS,
  EXPECTED_MODBUS_NAMES,
  EXPECTED_OPCUA_NAMES,
  EXPECTED_MQTT_TOPICS,
  CROSS_PROTOCOL_OVERLAP,
  IR_TO_HR_PAIRS,
  MQTT_TOPIC_TO_CSV_ID,
  type SignalDef,
} from "./signal-map";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface Config {
  edgeJsonlPath: string;
  batchCsvPath: string;
  groundTruthPath: string;
  durationSeconds: number;
  pollIntervalMs: number;
  completenessRatio: number;
  accuracyTolerance: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    edgeJsonlPath: "./data/factory-sim-packaging/metrics.jsonl",
    batchCsvPath: "../collatr-factory-simulator/output/signals.csv",
    groundTruthPath: "../collatr-factory-simulator/output/ground_truth.jsonl",
    durationSeconds: 600,
    pollIntervalMs: 1000,
    completenessRatio: 0.90,
    accuracyTolerance: 0.01,
  };

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const val = args[i + 1];
    switch (flag) {
      case "--edge-jsonl": config.edgeJsonlPath = val; break;
      case "--batch-csv": config.batchCsvPath = val; break;
      case "--ground-truth": config.groundTruthPath = val; break;
      case "--duration": config.durationSeconds = parseInt(val, 10); break;
      case "--poll-interval": config.pollIntervalMs = parseInt(val, 10); break;
      case "--completeness": config.completenessRatio = parseFloat(val); break;
      case "--accuracy": config.accuracyTolerance = parseFloat(val); break;
      default:
        console.error(`Unknown argument: ${flag}`);
        process.exit(1);
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;
const failures: string[] = [];

function check(name: string, passed: boolean, detail?: string): void {
  totalChecks++;
  if (passed) {
    passedChecks++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failedChecks++;
    const msg = `${name}${detail ? ` — ${detail}` : ""}`;
    failures.push(msg);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------------
// T1: Signal Enumeration
// ---------------------------------------------------------------------------

function checkSignalEnumeration(
  byDevice: Map<string, EdgeMetric[]>,
  allMetrics: EdgeMetric[],
): void {
  section("T1: Signal Enumeration");

  // Modbus signals
  const modbusMetrics = byDevice.get(DEVICE_ID.MODBUS) ?? [];
  const modbusNames = new Set(modbusMetrics.map((m) => m.name));
  const missingModbus = EXPECTED_MODBUS_NAMES.filter((n) => !modbusNames.has(n));
  check(
    "Modbus signal count",
    missingModbus.length === 0,
    `${modbusNames.size}/${EXPECTED_MODBUS_NAMES.length} signals. ${missingModbus.length > 0 ? `Missing: ${missingModbus.join(", ")}` : ""}`,
  );

  // OPC-UA signals
  const opcuaMetrics = byDevice.get(DEVICE_ID.OPCUA) ?? [];
  const opcuaNames = new Set(opcuaMetrics.map((m) => m.name));
  const missingOpcua = EXPECTED_OPCUA_NAMES.filter((n) => !opcuaNames.has(n));
  check(
    "OPC-UA signal count",
    missingOpcua.length === 0,
    `${opcuaNames.size}/${EXPECTED_OPCUA_NAMES.length} signals. ${missingOpcua.length > 0 ? `Missing: ${missingOpcua.join(", ")}` : ""}`,
  );

  // MQTT topics
  const mqttMetrics = byDevice.get(DEVICE_ID.MQTT) ?? [];
  const mqttTopics = new Set(mqttMetrics.map((m) => m.name));
  const missingMqtt = EXPECTED_MQTT_TOPICS.filter((t) => !mqttTopics.has(t));
  check(
    "MQTT topic count",
    missingMqtt.length === 0,
    `${mqttTopics.size}/${EXPECTED_MQTT_TOPICS.length} topics. ${missingMqtt.length > 0 ? `Missing: ${missingMqtt.join(", ")}` : ""}`,
  );

  // Report unexpected signals
  const allExpected = new Set([
    ...EXPECTED_MODBUS_NAMES,
    ...EXPECTED_OPCUA_NAMES,
    ...EXPECTED_MQTT_TOPICS,
  ]);
  const allNames = new Set(allMetrics.map((m) => m.name));
  // Filter out internal metrics (from [[inputs.internal]])
  const unexpected = [...allNames].filter(
    (n) => !allExpected.has(n) && !n.startsWith("internal"),
  );
  if (unexpected.length > 0) {
    console.log(`  ℹ️  Unexpected metrics: ${unexpected.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// T2: Value Accuracy
// ---------------------------------------------------------------------------

function checkValueAccuracy(
  byDevice: Map<string, EdgeMetric[]>,
  batchBySignal: Map<string, { timestamp: number; value: number | string }[]> | null,
  config: Config,
): void {
  section("T2: Value Accuracy");

  if (!batchBySignal) {
    console.log("  ⚠️  Batch CSV not available — skipping value accuracy checks");
    return;
  }

  // T2.1 — Modbus/OPC-UA value distribution comparison
  const modbusMetrics = byDevice.get(DEVICE_ID.MODBUS) ?? [];
  const opcuaMetrics = byDevice.get(DEVICE_ID.OPCUA) ?? [];
  const modbusByName = groupByName(modbusMetrics);
  const opcuaByName = groupByName(opcuaMetrics);

  console.log("\n  Modbus HR float32 vs batch CSV (distribution comparison):");
  const floatSignals = Object.values(SIGNALS).filter(
    (s) => s.modbusName !== null && s.dataType === "float" && !s.modbusName.endsWith("_ir"),
  );

  for (const sig of floatSignals) {
    const edgeVals = (modbusByName.get(sig.modbusName!) ?? [])
      .map((m) => Number(m.fields.value))
      .filter((v) => !Number.isNaN(v));
    const csvRows = batchBySignal.get(sig.csvId) ?? [];
    const csvVals = csvRows.map((r) => Number(r.value)).filter((v) => !Number.isNaN(v));

    if (edgeVals.length === 0 || csvVals.length === 0) {
      check(`${sig.csvId} accuracy`, false, "No data to compare");
      continue;
    }

    const edgeStats = computeStats(edgeVals);
    const csvStats = computeStats(csvVals);

    // Compare means: allow tolerance based on the scale of the value
    const meanDiff = Math.abs(edgeStats.mean - csvStats.mean);
    const scale = Math.max(Math.abs(csvStats.mean), 1.0);
    const relError = meanDiff / scale;

    check(
      `${sig.csvId} accuracy`,
      relError < config.accuracyTolerance,
      `edge mean=${edgeStats.mean.toFixed(4)}, csv mean=${csvStats.mean.toFixed(4)}, rel_err=${(relError * 100).toFixed(2)}%`,
    );
  }

  // T2.2 — Counter monotonicity
  console.log("\n  Counter monotonicity:");
  const counterSignals = Object.values(SIGNALS).filter(
    (s) => s.isCounter && s.modbusName !== null,
  );

  for (const sig of counterSignals) {
    const vals = (modbusByName.get(sig.modbusName!) ?? [])
      .map((m) => Number(m.fields.value))
      .filter((v) => !Number.isNaN(v));

    if (vals.length < 2) {
      check(`${sig.csvId} monotonicity`, vals.length > 0, `Only ${vals.length} samples`);
      continue;
    }

    let violations = 0;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] < vals[i - 1]) violations++;
    }

    check(
      `${sig.csvId} monotonicity`,
      violations === 0,
      `${vals.length} samples, ${violations} violations`,
    );
  }

  // T2.2 — Counter invariant: good_count + waste_count ≈ impression_count
  const impressions = (modbusByName.get("press.impression_count") ?? [])
    .map((m) => Number(m.fields.value))
    .filter((v) => !Number.isNaN(v));
  const goods = (modbusByName.get("press.good_count") ?? [])
    .map((m) => Number(m.fields.value))
    .filter((v) => !Number.isNaN(v));
  const wastes = (modbusByName.get("press.waste_count") ?? [])
    .map((m) => Number(m.fields.value))
    .filter((v) => !Number.isNaN(v));

  if (impressions.length > 0 && goods.length > 0 && wastes.length > 0) {
    const lastImpressions = impressions[impressions.length - 1];
    const lastGoods = goods[goods.length - 1];
    const lastWastes = wastes[wastes.length - 1];
    const sum = lastGoods + lastWastes;
    const diff = Math.abs(sum - lastImpressions);
    check(
      "Counter invariant (good + waste ≈ impression)",
      diff <= 10,
      `impression=${lastImpressions}, good=${lastGoods}, waste=${lastWastes}, diff=${diff}`,
    );
  }

  // T2.3 — Cross-protocol consistency (Modbus HR vs OPC-UA)
  console.log("\n  Cross-protocol consistency (Modbus HR vs OPC-UA):");
  for (const sigName of CROSS_PROTOCOL_OVERLAP) {
    const sig = SIGNALS[sigName];
    if (!sig || !sig.modbusName || !sig.opcuaName) continue;

    const modbusVals = (modbusByName.get(sig.modbusName) ?? [])
      .map((m) => Number(m.fields.value))
      .filter((v) => !Number.isNaN(v));
    const opcuaVals = (opcuaByName.get(sig.opcuaName) ?? [])
      .map((m) => Number(m.fields.value))
      .filter((v) => !Number.isNaN(v));

    if (modbusVals.length === 0 || opcuaVals.length === 0) continue;

    const modbusStats = computeStats(modbusVals);
    const opcuaStats = computeStats(opcuaVals);
    const meanDiff = Math.abs(modbusStats.mean - opcuaStats.mean);
    const scale = Math.max(Math.abs(modbusStats.mean), 1.0);
    const relErr = meanDiff / scale;

    check(
      `${sigName} cross-protocol`,
      relErr < config.accuracyTolerance,
      `modbus_mean=${modbusStats.mean.toFixed(4)}, opcua_mean=${opcuaStats.mean.toFixed(4)}, rel_err=${(relErr * 100).toFixed(2)}%`,
    );
  }

  // T2.3 — IR int16 x10 vs HR float32
  console.log("\n  Modbus IR (int16 x10) vs HR (float32):");
  for (const pair of IR_TO_HR_PAIRS) {
    const irVals = (modbusByName.get(pair.irName) ?? [])
      .map((m) => Number(m.fields.value))
      .filter((v) => !Number.isNaN(v));
    const hrVals = (modbusByName.get(pair.hrName) ?? [])
      .map((m) => Number(m.fields.value))
      .filter((v) => !Number.isNaN(v));

    if (irVals.length === 0 || hrVals.length === 0) continue;

    const irStats = computeStats(irVals);
    const hrStats = computeStats(hrVals);
    // IR is already scaled (Edge config has scale = 0.1), so values should be close
    const diff = Math.abs(irStats.mean - hrStats.mean);

    check(
      `${pair.irName} vs ${pair.hrName}`,
      diff < 0.15, // ±0.1 from int16 quantisation + float precision
      `ir_mean=${irStats.mean.toFixed(2)}, hr_mean=${hrStats.mean.toFixed(2)}, diff=${diff.toFixed(3)}`,
    );
  }

  // T2.4 — MQTT value accuracy
  console.log("\n  MQTT value accuracy vs batch CSV:");
  const mqttMetrics = byDevice.get(DEVICE_ID.MQTT) ?? [];
  const mqttByTopic = groupByName(mqttMetrics);

  for (const [topic, csvId] of MQTT_TOPIC_TO_CSV_ID) {
    const edgeMetrics = mqttByTopic.get(topic) ?? [];
    const csvRows = batchBySignal.get(csvId) ?? [];

    if (edgeMetrics.length === 0 || csvRows.length === 0) continue;

    // For MQTT, use fields.timestamp (sim time) to pair with CSV
    const edgeVals = edgeMetrics
      .map((m) => Number(m.fields.value))
      .filter((v) => !Number.isNaN(v));
    const csvVals = csvRows
      .map((r) => Number(r.value))
      .filter((v) => !Number.isNaN(v));

    if (edgeVals.length === 0 || csvVals.length === 0) continue;

    const edgeStats = computeStats(edgeVals);
    const csvStats = computeStats(csvVals);
    const meanDiff = Math.abs(edgeStats.mean - csvStats.mean);
    const scale = Math.max(Math.abs(csvStats.mean), 1.0);
    const relErr = meanDiff / scale;

    // MQTT signals have different sampling rates than batch CSV (which writes every tick),
    // so distribution means may differ. Use a wider tolerance.
    const mqttTolerance = config.accuracyTolerance * 5;
    check(
      `MQTT ${csvId}`,
      relErr < mqttTolerance,
      `edge_mean=${edgeStats.mean.toFixed(4)}, csv_mean=${csvStats.mean.toFixed(4)}, rel_err=${(relErr * 100).toFixed(2)}%`,
    );
  }
}

// ---------------------------------------------------------------------------
// T3: Completeness
// ---------------------------------------------------------------------------

function checkCompleteness(
  byDevice: Map<string, EdgeMetric[]>,
  config: Config,
): void {
  section("T3: Completeness");

  const durationMs = config.durationSeconds * 1000;
  const expectedPolls = Math.floor(durationMs / config.pollIntervalMs);
  const minPolls = Math.floor(expectedPolls * config.completenessRatio);

  // T3.1 — Modbus polling completeness
  console.log("\n  Modbus polling completeness:");
  const modbusMetrics = byDevice.get(DEVICE_ID.MODBUS) ?? [];
  const modbusByName = groupByName(modbusMetrics);

  // Check a representative sample of Modbus signals (not all 48 — that's noisy)
  const modbusCheckSignals = [
    "press.line_speed", "press.web_tension", "press.dryer_temp_zone_1",
    "press.machine_state", "press.impression_count",
    "laminator.nip_temp", "slitter.speed", "energy.line_power",
    "press.running", "press.guard_door_open",
  ];

  for (const name of modbusCheckSignals) {
    const metrics = modbusByName.get(name) ?? [];
    const gaps = findGaps(metrics, config.pollIntervalMs * 3);

    check(
      `Modbus ${name}`,
      metrics.length >= minPolls,
      `${metrics.length}/${expectedPolls} samples (min ${minPolls}), ${gaps.length} gaps > 3x interval`,
    );
  }

  // T3.2 — OPC-UA subscription completeness
  console.log("\n  OPC-UA subscription completeness:");
  const opcuaMetrics = byDevice.get(DEVICE_ID.OPCUA) ?? [];
  const opcuaByName = groupByName(opcuaMetrics);

  const opcuaCheckSignals = [
    "press.line_speed", "press.web_tension", "press.machine_state",
    "laminator.nip_temp", "slitter.speed", "energy.line_power",
  ];

  for (const name of opcuaCheckSignals) {
    const metrics = opcuaByName.get(name) ?? [];
    const gaps = findGaps(metrics, 5000); // 5s tolerance for OPC-UA

    check(
      `OPC-UA ${name}`,
      metrics.length >= minPolls,
      `${metrics.length}/${expectedPolls} samples (min ${minPolls}), ${gaps.length} gaps > 5s`,
    );
  }

  // T3.3 — MQTT message completeness
  console.log("\n  MQTT message completeness:");
  const mqttMetrics = byDevice.get(DEVICE_ID.MQTT) ?? [];
  const mqttByTopic = groupByName(mqttMetrics);

  const mqttChecks: Array<{ topic: string; label: string; intervalMs: number; eventDriven: boolean }> = [];
  for (const sig of Object.values(SIGNALS)) {
    if (sig.mqttTopic) {
      mqttChecks.push({
        topic: sig.mqttTopic,
        label: sig.csvId,
        intervalMs: sig.mqttIntervalMs ?? 0,
        eventDriven: sig.mqttEventDriven,
      });
    }
  }

  for (const { topic, label, intervalMs, eventDriven } of mqttChecks) {
    const metrics = mqttByTopic.get(topic) ?? [];

    if (eventDriven) {
      // Event-driven signals: just check we got at least 1
      check(
        `MQTT ${label}`,
        metrics.length >= 1,
        `${metrics.length} messages (event-driven, min 1)`,
      );
    } else if (intervalMs > 0) {
      const expectedMessages = Math.floor(durationMs / intervalMs);
      const minMessages = Math.floor(expectedMessages * config.completenessRatio);
      check(
        `MQTT ${label}`,
        metrics.length >= minMessages,
        `${metrics.length}/${expectedMessages} messages (min ${minMessages})`,
      );
    }
  }
}

/**
 * Find gaps in a sorted metrics array where the timestamp gap exceeds maxGapMs.
 * Returns array of { index, gapMs } for each gap found.
 */
function findGaps(
  metrics: EdgeMetric[],
  maxGapMs: number,
): Array<{ index: number; gapMs: number }> {
  const gaps: Array<{ index: number; gapMs: number }> = [];
  const maxGapNs = BigInt(maxGapMs) * 1_000_000n;

  for (let i = 1; i < metrics.length; i++) {
    const gap = metrics[i].timestamp - metrics[i - 1].timestamp;
    if (gap > maxGapNs) {
      gaps.push({ index: i, gapMs: Number(gap / 1_000_000n) });
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const config = parseArgs();

  console.log("=== CollatrEdge Integration Test Report ===");
  console.log(`Config: configs/factory-sim-packaging.toml`);
  console.log(`Duration: ${config.durationSeconds}s (${(config.durationSeconds / 60).toFixed(0)} min)`);
  console.log(`Completeness threshold: ${(config.completenessRatio * 100).toFixed(0)}%`);
  console.log(`Accuracy tolerance: ${(config.accuracyTolerance * 100).toFixed(1)}%`);

  // Load Edge JSONL
  if (!existsSync(config.edgeJsonlPath)) {
    console.error(`\nERROR: Edge JSONL not found: ${config.edgeJsonlPath}`);
    process.exit(1);
  }
  console.log(`\nLoading Edge JSONL: ${config.edgeJsonlPath}`);
  const allMetrics = readEdgeMetrics(config.edgeJsonlPath);
  console.log(`  Loaded ${allMetrics.length} metrics`);

  const byDevice = groupByDeviceId(allMetrics);
  for (const [deviceId, metrics] of byDevice) {
    console.log(`  ${deviceId}: ${metrics.length} metrics`);
  }

  // Load batch CSV (optional)
  let batchBySignal: Map<string, { timestamp: number; value: number | string; quality: string }[]> | null = null;
  if (existsSync(config.batchCsvPath)) {
    console.log(`\nLoading batch CSV: ${config.batchCsvPath}`);
    const batchRows = readBatchCSV(config.batchCsvPath);
    console.log(`  Loaded ${batchRows.length} rows`);
    batchBySignal = groupBatchBySignal(batchRows);
    console.log(`  ${batchBySignal.size} unique signals`);
  } else {
    console.log(`\n⚠️  Batch CSV not found: ${config.batchCsvPath}`);
    console.log("  Value accuracy checks will be skipped.");
  }

  // Load ground truth (optional, for T6)
  if (existsSync(config.groundTruthPath)) {
    console.log(`\nLoading ground truth: ${config.groundTruthPath}`);
    const events = readGroundTruth(config.groundTruthPath);
    console.log(`  Loaded ${events.length} events`);
  } else {
    console.log(`\n⚠️  Ground truth not found: ${config.groundTruthPath}`);
  }

  // Run checks
  checkSignalEnumeration(byDevice, allMetrics);
  checkValueAccuracy(byDevice, batchBySignal, config);
  checkCompleteness(byDevice, config);

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Total checks: ${totalChecks}`);
  console.log(`Passed: ${passedChecks} ✅`);
  console.log(`Failed: ${failedChecks} ❌`);

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  ❌ ${f}`);
    }
    console.log("\nRESULT: FAIL");
    process.exit(1);
  } else {
    console.log("\nRESULT: PASS");
    process.exit(0);
  }
}

main();
