#!/usr/bin/env bun
/**
 * T4: Sustained Operation Check
 *
 * After a long run (1-2+ hours), checks memory stability, connection
 * stability, data rate stability, and local store integrity.
 *
 * Usage:
 *   bun run test/integration/check-sustained.ts [options]
 *
 * Options:
 *   --edge-jsonl <path>   Edge metrics JSONL (default: ./data/factory-sim-packaging/metrics.jsonl)
 *   --data-dir <path>     Edge data directory (default: ./data/factory-sim-packaging)
 *   --duration <seconds>  Expected test duration in seconds (default: 7200 = 2h)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
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
  dataDir: string;
  durationSeconds: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    edgeJsonlPath: "./data/factory-sim-packaging/metrics.jsonl",
    dataDir: "./data/factory-sim-packaging",
    durationSeconds: 7200,
  };

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const val = args[i + 1] ?? "";
    switch (flag) {
      case "--edge-jsonl": config.edgeJsonlPath = val; break;
      case "--data-dir": config.dataDir = val; break;
      case "--duration": config.durationSeconds = parseInt(val, 10); break;
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
// T4.1: Memory stability
// ---------------------------------------------------------------------------

function checkMemoryStability(internalMetrics: EdgeMetric[]): void {
  section("T4.1: Memory Stability");

  // Find agent.memory_usage metrics
  const memMetrics = internalMetrics.filter((m) => m.name === "agent.memory_usage");

  if (memMetrics.length < 2) {
    check("Memory data available", false, `Only ${memMetrics.length} memory samples`);
    return;
  }

  check("Memory data available", true, `${memMetrics.length} samples`);

  // Extract RSS values over time
  const rssValues: Array<{ timestampNs: bigint; rss: number }> = [];
  for (const m of memMetrics) {
    const rss = Number(m.fields.rss ?? 0);
    if (rss > 0) {
      rssValues.push({ timestampNs: m.timestamp, rss });
    }
  }

  if (rssValues.length < 2) {
    check("RSS data available", false, "Insufficient RSS readings");
    return;
  }

  const firstRss = rssValues[0]!.rss;
  const lastRss = rssValues[rssValues.length - 1]!.rss;
  const maxRss = Math.max(...rssValues.map((v) => v.rss));
  const firstMB = (firstRss / 1024 / 1024).toFixed(1);
  const lastMB = (lastRss / 1024 / 1024).toFixed(1);
  const maxMB = (maxRss / 1024 / 1024).toFixed(1);

  // T4.1a: RSS at end <= 2x RSS at start
  check(
    "RSS growth bounded",
    lastRss <= firstRss * 2.0,
    `first=${firstMB}MB, last=${lastMB}MB, max=${maxMB}MB, ratio=${(lastRss / firstRss).toFixed(2)}x`,
  );

  // T4.1b: RSS stays under 200MB (PRD threshold)
  check(
    "RSS under 200MB",
    maxRss <= 200 * 1024 * 1024,
    `max=${maxMB}MB`,
  );

  // T4.1c: No monotonic increase trend
  // Check by comparing first-quarter mean to last-quarter mean
  const quarter = Math.floor(rssValues.length / 4);
  if (quarter > 0) {
    const firstQ = rssValues.slice(0, quarter);
    const lastQ = rssValues.slice(-quarter);
    const firstQMean = firstQ.reduce((s, v) => s + v.rss, 0) / firstQ.length;
    const lastQMean = lastQ.reduce((s, v) => s + v.rss, 0) / lastQ.length;
    const growth = (lastQMean - firstQMean) / firstQMean;

    check(
      "No monotonic RSS growth",
      growth < 0.5, // Allow up to 50% growth between quarters
      `Q1 mean=${(firstQMean / 1024 / 1024).toFixed(1)}MB, Q4 mean=${(lastQMean / 1024 / 1024).toFixed(1)}MB, growth=${(growth * 100).toFixed(1)}%`,
    );
  }
}

// ---------------------------------------------------------------------------
// T4.2: Connection stability
// ---------------------------------------------------------------------------

function checkConnectionStability(internalMetrics: EdgeMetric[]): void {
  section("T4.2: Connection Stability");

  // Check gather_errors and write_errors from internal metrics
  const gatherErrors = internalMetrics
    .filter((m) => m.name === "agent.gather_errors")
    .map((m) => Number(m.fields.value ?? 0));

  const writeErrors = internalMetrics
    .filter((m) => m.name === "agent.write_errors")
    .map((m) => Number(m.fields.value ?? 0));

  // These are cumulative counters — check the final value
  const totalGatherErrors = gatherErrors.length > 0 ? gatherErrors[gatherErrors.length - 1]! : 0;
  const totalWriteErrors = writeErrors.length > 0 ? writeErrors[writeErrors.length - 1]! : 0;

  check(
    "Zero gather errors",
    totalGatherErrors === 0,
    `${totalGatherErrors} gather errors`,
  );

  check(
    "Zero write errors",
    totalWriteErrors === 0,
    `${totalWriteErrors} write errors`,
  );

  // Check metrics_dropped
  const droppedMetrics = internalMetrics
    .filter((m) => m.name === "agent.metrics_dropped")
    .map((m) => Number(m.fields.value ?? 0));
  const totalDropped = droppedMetrics.length > 0 ? droppedMetrics[droppedMetrics.length - 1]! : 0;

  check(
    "Zero dropped metrics",
    totalDropped === 0,
    `${totalDropped} metrics dropped`,
  );
}

// ---------------------------------------------------------------------------
// T4.3: Data rate stability
// ---------------------------------------------------------------------------

function checkDataRateStability(
  byDevice: Map<string, EdgeMetric[]>,
  durationSeconds: number,
): void {
  section("T4.3: Data Rate Stability");

  // Compare Modbus metrics-per-minute in first 5 minutes vs last 5 minutes
  const modbusMetrics = byDevice.get(DEVICE_ID.MODBUS) ?? [];

  if (modbusMetrics.length < 100) {
    check("Sufficient data for rate analysis", false, `Only ${modbusMetrics.length} Modbus metrics`);
    return;
  }

  const firstTs = modbusMetrics[0]!.timestamp;
  const lastTs = modbusMetrics[modbusMetrics.length - 1]!.timestamp;
  const windowNs = 5n * 60n * 1_000_000_000n; // 5 minutes in ns

  const firstWindow = modbusMetrics.filter((m) => m.timestamp - firstTs < windowNs);
  const lastWindow = modbusMetrics.filter((m) => lastTs - m.timestamp < windowNs);

  if (firstWindow.length === 0 || lastWindow.length === 0) {
    check("Rate windows available", false, "Could not extract 5-minute windows");
    return;
  }

  const firstRate = firstWindow.length / 5; // per minute
  const lastRate = lastWindow.length / 5;
  const rateDiff = Math.abs(firstRate - lastRate) / Math.max(firstRate, 1);

  check(
    "Modbus rate stable (first 5min vs last 5min)",
    rateDiff < 0.10, // Within 10%
    `first=${firstRate.toFixed(0)}/min, last=${lastRate.toFixed(0)}/min, diff=${(rateDiff * 100).toFixed(1)}%`,
  );

  // Same for MQTT
  const mqttMetrics = byDevice.get(DEVICE_ID.MQTT) ?? [];
  if (mqttMetrics.length > 50) {
    const mqttFirstTs = mqttMetrics[0]!.timestamp;
    const mqttLastTs = mqttMetrics[mqttMetrics.length - 1]!.timestamp;
    const mqttFirst = mqttMetrics.filter((m) => m.timestamp - mqttFirstTs < windowNs);
    const mqttLast = mqttMetrics.filter((m) => mqttLastTs - m.timestamp < windowNs);

    if (mqttFirst.length > 0 && mqttLast.length > 0) {
      const mqttFirstRate = mqttFirst.length / 5;
      const mqttLastRate = mqttLast.length / 5;
      const mqttRateDiff = Math.abs(mqttFirstRate - mqttLastRate) / Math.max(mqttFirstRate, 1);

      check(
        "MQTT rate stable (first 5min vs last 5min)",
        mqttRateDiff < 0.10,
        `first=${mqttFirstRate.toFixed(0)}/min, last=${mqttLastRate.toFixed(0)}/min, diff=${(mqttRateDiff * 100).toFixed(1)}%`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// T4.4: Local store integrity
// ---------------------------------------------------------------------------

function checkLocalStoreIntegrity(dataDir: string): void {
  section("T4.4: Local Store Integrity");

  if (!existsSync(dataDir)) {
    check("Data directory exists", false, dataDir);
    return;
  }

  const dbFiles = readdirSync(dataDir).filter((f) => f.endsWith(".db"));

  if (dbFiles.length === 0) {
    check("SQLite files found", false, "No .db files in data directory");
    return;
  }

  check("SQLite files found", true, `${dbFiles.length} file(s)`);

  for (const dbFile of dbFiles) {
    const dbPath = join(dataDir, dbFile);
    const stat = statSync(dbPath);

    try {
      const db = new Database(dbPath, { readonly: true });
      const result = db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
      const integrity = result?.integrity_check ?? "unknown";
      db.close();

      check(
        `${dbFile} integrity`,
        integrity === "ok",
        `${integrity}, size=${(stat.size / 1024).toFixed(0)}KB`,
      );
    } catch (err) {
      check(`${dbFile} integrity`, false, `Error: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const config = parseArgs();

  console.log("=== T4: Sustained Operation Check ===");
  console.log(`Duration: ${config.durationSeconds}s (${(config.durationSeconds / 3600).toFixed(1)}h)`);

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
  console.log(`  Internal metrics: ${internalMetrics.length}`);

  checkMemoryStability(internalMetrics);
  checkConnectionStability(internalMetrics);
  checkDataRateStability(byDevice, config.durationSeconds);
  checkLocalStoreIntegrity(config.dataDir);

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
