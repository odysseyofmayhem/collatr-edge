// Integration test: Modbus input → pipeline → mock output
// PRD refs: §4 Architecture Overview

import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import { ModbusInput, type ModbusClient, type ModbusConfig } from "@plugins/inputs/modbus";
import type { Metric, FieldValue } from "@core/metric";
import type { Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Mock Modbus client (same as unit test but minimal for integration)
// ---------------------------------------------------------------------------

class MockModbusClient implements ModbusClient {
  private _slaveId = 1;
  private _isOpen = false;
  private holdingRegisters = new Map<number, Map<number, number>>();

  async connectTCP(_host: string, _options: { port: number }): Promise<void> {
    this._isOpen = true;
  }
  setID(id: number): void { this._slaveId = id; }
  setTimeout(_ms: number): void {}
  get isOpen(): boolean { return this._isOpen; }
  close(): void { this._isOpen = false; }

  setHolding(slaveId: number, address: number, value: number): void {
    if (!this.holdingRegisters.has(slaveId)) this.holdingRegisters.set(slaveId, new Map());
    this.holdingRegisters.get(slaveId)!.set(address, value);
  }

  async readHoldingRegisters(address: number, count: number): Promise<{ data: number[]; buffer: Buffer }> {
    const regs = this.holdingRegisters.get(this._slaveId) ?? new Map();
    const data: number[] = [];
    const bytes: number[] = [];
    for (let i = 0; i < count; i++) {
      const val = regs.get(address + i) ?? 0;
      data.push(val);
      bytes.push((val >> 8) & 0xFF, val & 0xFF);
    }
    return { data, buffer: Buffer.from(bytes) };
  }

  async readInputRegisters(address: number, count: number): Promise<{ data: number[]; buffer: Buffer }> {
    return this.readHoldingRegisters(address, count);
  }

  async readCoils(address: number, count: number): Promise<{ data: boolean[]; buffer: Buffer }> {
    const data = new Array<boolean>(count).fill(false);
    return { data, buffer: Buffer.alloc(Math.ceil(count / 8)) };
  }

  async readDiscreteInputs(address: number, count: number): Promise<{ data: boolean[]; buffer: Buffer }> {
    return this.readCoils(address, count);
  }
}

// ---------------------------------------------------------------------------
// Mock output (captures metrics for verification)
// ---------------------------------------------------------------------------

class MockOutput implements Output {
  written: Metric[] = [];
  connected = false;
  closed = false;

  async connect(): Promise<void> { this.connected = true; }
  async write(batch: Metric[]): Promise<void> { this.written.push(...batch); }
  async close(): Promise<void> { this.closed = true; }
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

describe("Integration: Modbus input → pipeline → output", () => {
  it("metrics have correct register names and values", async () => {
    const mockClient = new MockModbusClient();
    mockClient.setHolding(1, 100, 255);  // temperature: raw 255 * 0.1 = 25.5
    mockClient.setHolding(1, 101, 1024); // pressure: raw 1024

    const config: ModbusConfig = {
      controller: "tcp://192.168.1.100:502",
      connection_mode: "dedicated",
      slave_id: 1,
      byte_order: "ABCD",
      optimization: "batch",
      max_batch_size: 125,
      max_gap: 10,
      timeout: "5s",
      registers: [
        { address: 100, name: "temperature", type: "holding", data_type: "uint16", scale: 0.1, offset: 0 },
        { address: 101, name: "pressure", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
      ],
    };

    const modbusInput = new ModbusInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: modbusInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    expect(output.connected).toBe(true);
    expect(output.written.length).toBeGreaterThanOrEqual(2);

    // Find one of each metric name from the first gather cycle
    const temps = output.written.filter((m) => m.name === "temperature");
    const pressures = output.written.filter((m) => m.name === "pressure");
    expect(temps.length).toBeGreaterThanOrEqual(1);
    expect(pressures.length).toBeGreaterThanOrEqual(1);

    expect(temps[0]!.getField("value")).toBeCloseTo(25.5, 2);
    expect(pressures[0]!.getField("value")).toBe(1024);
  });

  it("global tags and slave_id tag present on output metrics", async () => {
    const mockClient = new MockModbusClient();
    mockClient.setHolding(1, 100, 42);

    const config: ModbusConfig = {
      controller: "tcp://192.168.1.100:502",
      connection_mode: "dedicated",
      slave_id: 1,
      byte_order: "ABCD",
      optimization: "batch",
      max_batch_size: 125,
      max_gap: 10,
      timeout: "5s",
      registers: [
        { address: 100, name: "sensor_val", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
      ],
    };

    const modbusInput = new ModbusInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: modbusInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      globalTags: { site: "factory_a", line: "3" },
    });

    await runFor(pipeline, 300);

    expect(output.written.length).toBeGreaterThanOrEqual(1);
    const m = output.written[0]!;

    // slave_id tag from Modbus input
    expect(m.getTag("slave_id")).toBe("1");

    // Global tags applied by pipeline
    expect(m.getTag("site")).toBe("factory_a");
    expect(m.getTag("line")).toBe("3");
  });

  it("multiple registers produce multiple fields per gather cycle", async () => {
    const mockClient = new MockModbusClient();
    mockClient.setHolding(1, 100, 10);
    mockClient.setHolding(1, 101, 20);
    mockClient.setHolding(1, 102, 30);

    const config: ModbusConfig = {
      controller: "tcp://192.168.1.100:502",
      connection_mode: "dedicated",
      slave_id: 1,
      byte_order: "ABCD",
      optimization: "batch",
      max_batch_size: 125,
      max_gap: 10,
      timeout: "5s",
      registers: [
        { address: 100, name: "reg_a", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
        { address: 101, name: "reg_b", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
        { address: 102, name: "reg_c", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
      ],
    };

    const modbusInput = new ModbusInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: modbusInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    // Each gather cycle should produce 3 metrics (one per register)
    // After multiple cycles, output should have many metrics
    expect(output.written.length).toBeGreaterThanOrEqual(3);

    // All three register names should appear in output
    const names = new Set(output.written.map((m) => m.name));
    expect(names.has("reg_a")).toBe(true);
    expect(names.has("reg_b")).toBe(true);
    expect(names.has("reg_c")).toBe(true);

    // Values are correct
    const regA = output.written.find((m) => m.name === "reg_a")!;
    const regB = output.written.find((m) => m.name === "reg_b")!;
    const regC = output.written.find((m) => m.name === "reg_c")!;
    expect(regA.getField("value")).toBe(10);
    expect(regB.getField("value")).toBe(20);
    expect(regC.getField("value")).toBe(30);

    // Metrics from multiple cycles: should have multiples of 3
    const regACount = output.written.filter((m) => m.name === "reg_a").length;
    const regBCount = output.written.filter((m) => m.name === "reg_b").length;
    expect(regACount).toBe(regBCount); // same number of each per cycle
    expect(regACount).toBeGreaterThanOrEqual(2); // at least 2 gather cycles
  });
});
