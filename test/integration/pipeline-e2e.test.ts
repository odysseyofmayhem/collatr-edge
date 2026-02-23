// Integration test: Full pipeline — config → runtime → data flow → shutdown
// PRD refs: §4 Architecture Overview, §7 Configuration, §8 Pipeline Lifecycle

import { describe, it, expect } from "bun:test";
import { parseConfig, parseDuration } from "@core/config";
import { PipelineRuntime } from "@pipeline/runtime";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";
import type { Input, Processor, Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// TOML config used to drive the pipeline
// ---------------------------------------------------------------------------

const TEST_TOML = `
[agent]
  hostname = "test-rig"
  interval = "50ms"
  flush_interval = "50ms"

[global_tags]
  site = "factory_a"
  line = "3"

[[inputs.mock_sensor]]
  alias = "temp_sensor"
  measurement = "temperature"
  field_name = "celsius"
  field_value = 23.5

[[processors.rename]]
  alias = "field_renamer"
  from = "celsius"
  to = "temp_c"

[[outputs.mock_store]]
  alias = "test_store"
`;

// ---------------------------------------------------------------------------
// Mock plugins — configured from parsed TOML values
// ---------------------------------------------------------------------------

class ConfigDrivenInput implements Input {
  private measurement: string;
  private fieldName: string;
  private fieldValue: number;
  gatherCount = 0;
  closed = false;

  constructor(config: { measurement: string; field_name: string; field_value: number }) {
    this.measurement = config.measurement;
    this.fieldName = config.field_name;
    this.fieldValue = config.field_value;
  }

  async gather(acc: Accumulator): Promise<void> {
    acc.addFields(this.measurement, { [this.fieldName]: this.fieldValue });
    this.gatherCount++;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class RenameProcessor implements Processor {
  private from: string;
  private to: string;
  closed = false;

  constructor(config: { from: string; to: string }) {
    this.from = config.from;
    this.to = config.to;
  }

  async process(metric: Metric, acc: Accumulator): Promise<void> {
    const value = metric.getField(this.from);
    if (value !== undefined) {
      metric.removeField(this.from);
      metric.addField(this.to, value);
    }
    acc.addMetric(metric);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockStoreOutput implements Output {
  written: Metric[] = [];
  connected = false;
  closed = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async write(batch: Metric[]): Promise<void> {
    this.written.push(...batch);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function runFor(pipeline: PipelineRuntime, durationMs: number): Promise<void> {
  await pipeline.start();
  await Bun.sleep(durationMs);
  await pipeline.stop();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: Pipeline E2E (config → runtime → data flow → shutdown)", () => {
  it("config-driven pipeline: TOML → parse → build → start → verify output → shutdown", async () => {
    // 1. Parse the TOML config
    const config = parseConfig(TEST_TOML);

    // Verify config parsed correctly
    expect(config.agent.hostname).toBe("test-rig");
    expect(config.agent.interval).toBe("50ms");
    expect(config.global_tags.site).toBe("factory_a");
    expect(config.inputs.mock_sensor).toBeDefined();
    expect(config.processors.rename).toBeDefined();
    expect(config.outputs.mock_store).toBeDefined();

    // 2. Build plugins from config values
    const inputConfig = config.inputs.mock_sensor![0]!;
    const input = new ConfigDrivenInput({
      measurement: inputConfig.measurement as string,
      field_name: inputConfig.field_name as string,
      field_value: inputConfig.field_value as number,
    });

    const procConfig = config.processors.rename![0]!;
    const processor = new RenameProcessor({
      from: procConfig.from as string,
      to: procConfig.to as string,
    });

    const output = new MockStoreOutput();

    // 3. Build and run pipeline using parsed config durations
    const gatherIntervalMs = parseDuration(config.agent.interval);
    const flushIntervalMs = parseDuration(config.agent.flush_interval);

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: processor }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs,
      flushIntervalMs,
      globalTags: config.global_tags,
    });

    await runFor(pipeline, 300);

    // 4. Verify data flowed through pipeline
    expect(output.connected).toBe(true);
    expect(output.written.length).toBeGreaterThanOrEqual(1);

    // Verify metrics have correct name and config-driven global tags
    const m = output.written[0]!;
    expect(m.name).toBe("temperature");
    expect(m.getTag("site")).toBe("factory_a");
    expect(m.getTag("line")).toBe("3");
  });

  it("rename processor actually renames fields in output metrics", async () => {
    const config = parseConfig(TEST_TOML);

    const inputConfig = config.inputs.mock_sensor![0]!;
    const input = new ConfigDrivenInput({
      measurement: inputConfig.measurement as string,
      field_name: inputConfig.field_name as string,
      field_value: inputConfig.field_value as number,
    });

    const procConfig = config.processors.rename![0]!;
    const processor = new RenameProcessor({
      from: procConfig.from as string,
      to: procConfig.to as string,
    });

    const output = new MockStoreOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: processor }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: parseDuration(config.agent.interval),
      flushIntervalMs: parseDuration(config.agent.flush_interval),
    });

    await runFor(pipeline, 300);

    expect(output.written.length).toBeGreaterThanOrEqual(1);
    const m = output.written[0]!;

    // Original field "celsius" should be gone, renamed to "temp_c"
    expect(m.getField("celsius")).toBeUndefined();
    expect(m.getField("temp_c")).toBe(23.5);
  });

  it("metric count: input produced N metrics, output received N metrics (no loss)", async () => {
    const input = new ConfigDrivenInput({
      measurement: "counter",
      field_name: "value",
      field_value: 1,
    });
    const output = new MockStoreOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 400);

    // Input gathered N times, output should have received exactly N metrics
    expect(input.gatherCount).toBeGreaterThanOrEqual(3);
    expect(output.written.length).toBe(input.gatherCount);
  });

  it("shutdown: all plugins get close() called", async () => {
    const config = parseConfig(TEST_TOML);

    const input = new ConfigDrivenInput({
      measurement: "temp",
      field_name: "c",
      field_value: 20,
    });
    const processor = new RenameProcessor({ from: "c", to: "celsius" });
    const output = new MockStoreOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: processor }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: parseDuration(config.agent.interval),
      flushIntervalMs: parseDuration(config.agent.flush_interval),
    });

    await runFor(pipeline, 200);

    // All plugins had close() called during graceful shutdown
    expect(input.closed).toBe(true);
    expect(processor.closed).toBe(true);
    expect(output.closed).toBe(true);

    // Output received data before shutdown
    expect(output.connected).toBe(true);
    expect(output.written.length).toBeGreaterThanOrEqual(1);
  });
});
