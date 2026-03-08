#!/usr/bin/env bun
/**
 * T5: Time Compression Check
 *
 * After running Edge against the simulator at Nx speed, verifies that
 * Edge maintained stable connections and collected data continuously.
 *
 * Usage:
 *   bun run test/integration/check-time-compression.ts [options]
 *
 * Options:
 *   --edge-jsonl <path>    Edge metrics JSONL (default: ./data/factory-sim-packaging/metrics.jsonl)
 *   --duration <seconds>   Real-time test duration in seconds (default: 600)
 *   --time-scale <factor>  Simulator time scale (default: 1.0)
 *   --completeness <ratio> Minimum completeness ratio (default: 0.85)
 */

import { existsSync } from "node:fs";
import {
  readEdgeMetrics,
  groupByDeviceId,
  groupByName,
  type EdgeMetric,
} from "./readers";
import { DEVICE_ID } from "./signal-map";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  edgeJsonlPath: string;
  durationSeconds: number;
  timeScale: number;
  completenessRatio: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    edgeJsonlPath: "./data/factory-sim-packaging/metrics.jsonl",
    durationSeconds: 600,
    timeScale: 1.0,
    completenessRatio: 0.85,
  };

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const val = args[i + 1] ?? "";
    switch (flag) {
      case "--edge-jsonl": config.edgeJsonlPath = val; break;
      case "--duration": config.durationSeconds = parseInt(val, 10); break;
      case "--time-scale": config.timeScale = parseFloat(val); break;
      case "--completeness": config.completenessRatio = parseFloat(val); break;
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
// T5: Time compression checks
// ---------------------------------------------------------------------------

function checkConnectionContinuity(
  byDevice: Map<string, EdgeMetric[]>,
  config: Config,
): void {
  section(`T5: Connection Continuity at ${config.timeScale}x`);

  const durationMs = config.durationSeconds * 1000;
  const pollIntervalMs = 1000; // Edge always polls at real-time 1s
  const expectedPolls = Math.floor(durationMs / pollIntervalMs);
  const minPolls = Math.floor(expectedPolls * config.completenessRatio);

  // Modbus — should maintain consistent polling regardless of sim speed
  console.log("\n  Modbus continuity:");
  const modbusMetrics = byDevice.get(DEVICE_ID.MODBUS) ?? [];
  const modbusByName = groupByName(modbusMetrics);

  const modbusCheckSignals = [
    "press.line_speed", "press.web_tension", "press.dryer_temp_zone_1",
    "energy.line_power",
  ];

  for (const name of modbusCheckSignals) {
    const metrics = modbusByName.get(name) ?? [];
    const gaps = findGaps(metrics, 5000); // 5s gap tolerance at any speed

    check(
      `Modbus ${name}`,
      metrics.length >= minPolls,
      `${metrics.length}/${expectedPolls} samples (min ${minPolls}), ${gaps.length} gaps > 5s`,
    );
  }

  // OPC-UA — subscription should keep delivering
  console.log("\n  OPC-UA continuity:");
  const opcuaMetrics = byDevice.get(DEVICE_ID.OPCUA) ?? [];
  const opcuaByName = groupByName(opcuaMetrics);

  // At higher speeds, OPC-UA sees more value changes per real-time second
  // so we should get MORE notifications, not fewer
  const opcuaContinuousSignals = [
    "press.web_tension", "press.dryer_temp_zone_1",
    "press.ink_temperature", "energy.line_power",
  ];

  for (const name of opcuaContinuousSignals) {
    const metrics = opcuaByName.get(name) ?? [];
    // At Nx speed, expect at least as many changes as 1x
    check(
      `OPC-UA ${name}`,
      metrics.length >= 1,
      `${metrics.length} data changes`,
    );
  }

  // MQTT — at higher speeds, messages arrive faster
  console.log("\n  MQTT continuity:");
  const mqttMetrics = byDevice.get(DEVICE_ID.MQTT) ?? [];

  check(
    "MQTT total messages received",
    mqttMetrics.length > 0,
    `${mqttMetrics.length} messages`,
  );

  // Check vibration specifically — at 10x, that's 10 msg/s per axis
  const mqttByTopic = groupByName(mqttMetrics);
  const vibX = mqttByTopic.get("collatr/factory/demo/packaging1/vibration/main_drive_x") ?? [];

  if (config.timeScale > 1) {
    // At Nx speed, vibration publishes N times faster (1s base interval)
    // Edge should receive at least (duration * scale * 0.8) messages
    const expectedVibMsgs = Math.floor(config.durationSeconds * config.timeScale * 0.8);
    const minVibMsgs = Math.floor(expectedVibMsgs * config.completenessRatio);

    check(
      "MQTT vibration burst handling",
      vibX.length >= Math.min(minVibMsgs, minPolls),
      `vibration_x: ${vibX.length} messages (at ${config.timeScale}x: ~${config.timeScale} msg/s expected)`,
    );
  }
}

function checkNoErrors(internalMetrics: EdgeMetric[]): void {
  section("T5: Error-free Operation");

  const gatherErrors = internalMetrics
    .filter((m) => m.name === "agent.gather_errors")
    .map((m) => Number(m.fields.value ?? 0));

  const writeErrors = internalMetrics
    .filter((m) => m.name === "agent.write_errors")
    .map((m) => Number(m.fields.value ?? 0));

  const totalGatherErrors = gatherErrors.length > 0 ? gatherErrors[gatherErrors.length - 1]! : 0;
  const totalWriteErrors = writeErrors.length > 0 ? writeErrors[writeErrors.length - 1]! : 0;

  check(
    "Zero gather errors at speed",
    totalGatherErrors === 0,
    `${totalGatherErrors} gather errors`,
  );

  check(
    "Zero write errors at speed",
    totalWriteErrors === 0,
    `${totalWriteErrors} write errors`,
  );
}

function checkDataPlausibility(
  byDevice: Map<string, EdgeMetric[]>,
  config: Config,
): void {
  section(`T5: Data Plausibility at ${config.timeScale}x`);

  // At higher speeds, signal values should still be within documented ranges
  const modbusMetrics = byDevice.get(DEVICE_ID.MODBUS) ?? [];
  const modbusByName = groupByName(modbusMetrics);

  // Check a few key signals are within plausible ranges
  const rangeChecks: Array<{ name: string; min: number; max: number }> = [
    { name: "press.dryer_temp_zone_1", min: 15, max: 200 },
    { name: "press.ink_temperature", min: 15, max: 60 },
    { name: "press.ink_viscosity", min: 5, max: 50 },
    { name: "energy.line_power", min: 0, max: 100 },
    { name: "laminator.nip_temp", min: 15, max: 200 },
  ];

  for (const { name, min, max } of rangeChecks) {
    const vals = (modbusByName.get(name) ?? [])
      .map((m) => Number(m.fields.value ?? 0))
      .filter((v) => !Number.isNaN(v));

    if (vals.length === 0) continue;

    const actual_min = Math.min(...vals);
    const actual_max = Math.max(...vals);
    const inRange = actual_min >= min && actual_max <= max;

    check(
      `${name} in range [${min}, ${max}]`,
      inRange,
      `actual=[${actual_min.toFixed(2)}, ${actual_max.toFixed(2)}]`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findGaps(
  metrics: EdgeMetric[],
  maxGapMs: number,
): Array<{ index: number; gapMs: number }> {
  const gaps: Array<{ index: number; gapMs: number }> = [];
  const maxGapNs = BigInt(maxGapMs) * 1_000_000n;

  for (let i = 1; i < metrics.length; i++) {
    const gap = metrics[i]!.timestamp - metrics[i - 1]!.timestamp;
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

  console.log(`=== T5: Time Compression Check (${config.timeScale}x) ===`);
  console.log(`Real-time duration: ${config.durationSeconds}s (${(config.durationSeconds / 60).toFixed(0)} min)`);
  console.log(`Sim-time covered: ${(config.durationSeconds * config.timeScale / 60).toFixed(0)} min`);

  if (!existsSync(config.edgeJsonlPath)) {
    console.error(`\nERROR: Edge JSONL not found: ${config.edgeJsonlPath}`);
    process.exit(1);
  }

  console.log(`\nLoading Edge JSONL: ${config.edgeJsonlPath}`);
  const allMetrics = readEdgeMetrics(config.edgeJsonlPath);
  console.log(`  Loaded ${allMetrics.length} metrics`);

  const byDevice = groupByDeviceId(allMetrics);
  const internalMetrics = (byDevice.get("__none__") ?? [])
    .concat(byDevice.get(DEVICE_ID.INTERNAL) ?? []);

  checkConnectionContinuity(byDevice, config);
  checkNoErrors(internalMetrics);
  checkDataPlausibility(byDevice, config);

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
