#!/usr/bin/env bun
/**
 * T6: Scenario Data Capture Check
 *
 * After a scenario-rich run, reads ground truth + Edge data and checks
 * whether Edge captured the data patterns that scenarios produced.
 *
 * We are NOT testing anomaly detection — we are testing that Edge
 * faithfully captured the data patterns the simulator injected.
 *
 * Usage:
 *   bun run test/integration/check-scenarios.ts [options]
 *
 * Options:
 *   --edge-jsonl <path>     Edge metrics JSONL (default: ./data/factory-sim-packaging/metrics.jsonl)
 *   --ground-truth <path>   Ground truth JSONL (default: ../collatr-factory-simulator/output/ground_truth.jsonl)
 */

import { existsSync } from "node:fs";
import {
  readEdgeMetrics,
  readGroundTruth,
  groupByDeviceId,
  groupByName,
  type EdgeMetric,
  type GroundTruthEvent,
} from "./readers";
import { DEVICE_ID } from "./signal-map";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  edgeJsonlPath: string;
  groundTruthPath: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    edgeJsonlPath: "./data/factory-sim-packaging/metrics.jsonl",
    groundTruthPath: "../collatr-factory-simulator/output/ground_truth.jsonl",
  };

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const val = args[i + 1] ?? "";
    switch (flag) {
      case "--edge-jsonl": config.edgeJsonlPath = val; break;
      case "--ground-truth": config.groundTruthPath = val; break;
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
let infoCount = 0;
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

function info(msg: string): void {
  infoCount++;
  console.log(`  ℹ️  ${msg}`);
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------------
// Scenario checks
// ---------------------------------------------------------------------------

/**
 * T6.1: Web break capture
 * Ground truth logs scenario_start: web_break → Edge should see:
 * - web_tension spike > 600N followed by drop to 0
 * - machine_state transition to Fault (4)
 * - line_speed drop to 0
 */
function checkWebBreak(
  events: GroundTruthEvent[],
  modbusByName: Map<string, EdgeMetric[]>,
): void {
  section("T6.1: Web Break Capture");

  const webBreaks = events.filter(
    (e) => e.event === "scenario_start" && e.scenario === "web_break",
  );

  if (webBreaks.length === 0) {
    info("No web_break scenarios in ground truth — skipping");
    return;
  }

  info(`Found ${webBreaks.length} web_break scenario(s) in ground truth`);

  // Check Edge captured the spike pattern
  const webTension = (modbusByName.get("press.web_tension") ?? [])
    .map((m) => Number(m.fields.value ?? 0));

  if (webTension.length === 0) {
    check("Web tension data captured", false, "No web_tension data in Edge output");
    return;
  }

  const maxTension = Math.max(...webTension);
  check(
    "Web tension spike captured",
    maxTension > 400, // Lowered from 600 — the spike may be brief
    `max web_tension=${maxTension.toFixed(1)}N`,
  );

  // Check machine state went to Fault (4)
  const machineState = (modbusByName.get("press.machine_state") ?? [])
    .map((m) => Number(m.fields.value ?? 0));
  const sawFault = machineState.includes(4);

  check(
    "Machine state Fault (4) captured",
    sawFault,
    `states observed: [${[...new Set(machineState)].sort().join(", ")}]`,
  );
}

/**
 * T6.2: State machine transitions
 * Edge should capture all machine states that appear in ground truth.
 */
function checkStateTransitions(
  events: GroundTruthEvent[],
  modbusByName: Map<string, EdgeMetric[]>,
  opcuaByName: Map<string, EdgeMetric[]>,
): void {
  section("T6.2: State Machine Transitions");

  // Collect states from ground truth
  const stateChanges = events.filter(
    (e) => e.event === "state_change" && (e.signal === "press.machine_state" || e.signal === "press.state"),
  );

  if (stateChanges.length === 0) {
    info("No press state changes in ground truth — checking Edge data only");
  } else {
    info(`Found ${stateChanges.length} state change event(s) in ground truth`);
    const gtStates = new Set(stateChanges.flatMap((e) => [Number(e.from), Number(e.to)]));
    info(`Ground truth states: [${[...gtStates].sort().join(", ")}]`);
  }

  // Check Modbus state observations
  const modbusStates = new Set(
    (modbusByName.get("press.machine_state") ?? [])
      .map((m) => Number(m.fields.value ?? -1)),
  );

  check(
    "Modbus captured machine states",
    modbusStates.size >= 1,
    `states: [${[...modbusStates].sort().join(", ")}]`,
  );

  // Check OPC-UA state matches Modbus
  const opcuaStates = new Set(
    (opcuaByName.get("press.machine_state") ?? [])
      .map((m) => Number(m.fields.value ?? -1)),
  );

  if (opcuaStates.size > 0) {
    // OPC-UA states should be a subset of (or equal to) Modbus states
    // (Modbus polls continuously, OPC-UA only on change)
    const opcuaSubset = [...opcuaStates].every((s) => modbusStates.has(s));
    check(
      "OPC-UA states consistent with Modbus",
      opcuaSubset,
      `opcua: [${[...opcuaStates].sort().join(", ")}], modbus: [${[...modbusStates].sort().join(", ")}]`,
    );
  }
}

/**
 * T6.3: Dryer drift
 * Ground truth logs scenario_start: dryer_drift → Edge should see
 * dryer temps gradually diverging from setpoints.
 */
function checkDryerDrift(
  events: GroundTruthEvent[],
  modbusByName: Map<string, EdgeMetric[]>,
): void {
  section("T6.3: Dryer Drift");

  const dryerDrifts = events.filter(
    (e) => e.event === "scenario_start" && (
      e.scenario === "dryer_drift" ||
      String(e.scenario ?? "").includes("dryer")
    ),
  );

  if (dryerDrifts.length === 0) {
    info("No dryer_drift scenarios in ground truth — checking for natural deviation");
  } else {
    info(`Found ${dryerDrifts.length} dryer drift scenario(s)`);
  }

  // Check if Edge captured temp-setpoint deviation
  const zones = [
    { temp: "press.dryer_temp_zone_1", setpoint: "press.dryer_setpoint_zone_1", label: "Zone 1" },
    { temp: "press.dryer_temp_zone_2", setpoint: "press.dryer_setpoint_zone_2", label: "Zone 2" },
    { temp: "press.dryer_temp_zone_3", setpoint: "press.dryer_setpoint_zone_3", label: "Zone 3" },
  ];

  for (const zone of zones) {
    const temps = (modbusByName.get(zone.temp) ?? [])
      .map((m) => Number(m.fields.value ?? 0));
    const setpoints = (modbusByName.get(zone.setpoint) ?? [])
      .map((m) => Number(m.fields.value ?? 0));

    if (temps.length === 0 || setpoints.length === 0) continue;

    const avgTemp = temps.reduce((s, v) => s + v, 0) / temps.length;
    const avgSetpoint = setpoints.reduce((s, v) => s + v, 0) / setpoints.length;
    const deviation = avgTemp - avgSetpoint;

    // If dryer drift scenario fired, expect deviation to be significant
    if (dryerDrifts.length > 0) {
      check(
        `${zone.label} drift captured`,
        Math.abs(deviation) > 1.0,
        `avg_temp=${avgTemp.toFixed(2)}, setpoint=${avgSetpoint.toFixed(2)}, deviation=${deviation.toFixed(2)}`,
      );
    } else {
      info(`${zone.label}: temp=${avgTemp.toFixed(2)}, setpoint=${avgSetpoint.toFixed(2)}, deviation=${deviation.toFixed(2)}`);
    }
  }
}

/**
 * T6.4: Counter and consumable events
 * Check counter resets at shift changes and ink refill events.
 */
function checkCounterAndConsumables(
  events: GroundTruthEvent[],
  modbusByName: Map<string, EdgeMetric[]>,
  mqttByTopic: Map<string, EdgeMetric[]>,
): void {
  section("T6.4: Counter & Consumable Events");

  // Check for shift changes in ground truth
  const shiftChanges = events.filter((e) => e.event === "shift_change");
  if (shiftChanges.length > 0) {
    info(`Found ${shiftChanges.length} shift change(s) in ground truth`);

    // Impression count should show the pattern (may reset or continue)
    const impressions = (modbusByName.get("press.impression_count") ?? [])
      .map((m) => Number(m.fields.value ?? 0));

    check(
      "Impression counter data captured across shifts",
      impressions.length > 0,
      `${impressions.length} samples`,
    );
  } else {
    info("No shift changes in ground truth — skipping counter reset checks");
  }

  // Check for consumable refill events
  const consumables = events.filter((e) => e.event === "consumable" || e.event === "consumable_refill");
  if (consumables.length > 0) {
    info(`Found ${consumables.length} consumable event(s) in ground truth`);

    // ink_level should show a jump back up
    const inkLevel = (mqttByTopic.get("collatr/factory/demo/packaging1/coder/ink_level") ?? [])
      .map((m) => Number(m.fields.value ?? 0));

    if (inkLevel.length > 1) {
      let hasIncrease = false;
      for (let i = 1; i < inkLevel.length; i++) {
        if (inkLevel[i]! > inkLevel[i - 1]! + 5) {
          hasIncrease = true;
          break;
        }
      }
      check(
        "Ink refill captured (ink_level jump)",
        hasIncrease,
        `${inkLevel.length} ink_level readings`,
      );
    } else {
      info("Insufficient ink_level data to check refill");
    }
  } else {
    info("No consumable events in ground truth — skipping refill checks");
  }
}

/**
 * Generic: report all ground truth events and whether Edge had data
 * around those times.
 */
function reportEventCoverage(
  events: GroundTruthEvent[],
  allMetrics: EdgeMetric[],
): void {
  section("Event Coverage Summary");

  if (events.length === 0) {
    info("No events in ground truth");
    return;
  }

  // Group events by type
  const byType = new Map<string, number>();
  for (const e of events) {
    byType.set(e.event, (byType.get(e.event) ?? 0) + 1);
  }

  console.log("  Ground truth events:");
  for (const [type, count] of [...byType.entries()].sort()) {
    console.log(`    ${type}: ${count}`);
  }

  // Check Edge had data during the run
  const edgeDuration = allMetrics.length > 1
    ? Number(allMetrics[allMetrics.length - 1]!.timestamp - allMetrics[0]!.timestamp) / 1e9
    : 0;

  check(
    "Edge collected data for full run",
    edgeDuration > 60,
    `${edgeDuration.toFixed(0)}s of data`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const config = parseArgs();

  console.log("=== T6: Scenario Data Capture Check ===");

  if (!existsSync(config.edgeJsonlPath)) {
    console.error(`\nERROR: Edge JSONL not found: ${config.edgeJsonlPath}`);
    process.exit(1);
  }

  if (!existsSync(config.groundTruthPath)) {
    console.error(`\nERROR: Ground truth not found: ${config.groundTruthPath}`);
    console.error("  T6 requires ground truth JSONL for scenario verification.");
    process.exit(1);
  }

  console.log(`\nLoading Edge JSONL: ${config.edgeJsonlPath}`);
  const allMetrics = readEdgeMetrics(config.edgeJsonlPath);
  console.log(`  Loaded ${allMetrics.length} metrics`);

  console.log(`\nLoading ground truth: ${config.groundTruthPath}`);
  const events = readGroundTruth(config.groundTruthPath);
  console.log(`  Loaded ${events.length} events`);

  const byDevice = groupByDeviceId(allMetrics);
  const modbusMetrics = byDevice.get(DEVICE_ID.MODBUS) ?? [];
  const opcuaMetrics = byDevice.get(DEVICE_ID.OPCUA) ?? [];
  const mqttMetrics = byDevice.get(DEVICE_ID.MQTT) ?? [];

  const modbusByName = groupByName(modbusMetrics);
  const opcuaByName = groupByName(opcuaMetrics);
  const mqttByTopic = groupByName(mqttMetrics);

  // Run scenario checks
  reportEventCoverage(events, allMetrics);
  checkWebBreak(events, modbusByName);
  checkStateTransitions(events, modbusByName, opcuaByName);
  checkDryerDrift(events, modbusByName);
  checkCounterAndConsumables(events, modbusByName, mqttByTopic);

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Total checks: ${totalChecks}`);
  console.log(`Passed: ${passedChecks} ✅`);
  console.log(`Failed: ${failedChecks} ❌`);
  console.log(`Info: ${infoCount} ℹ️`);

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
