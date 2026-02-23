// Integration test: OPC-UA input → pipeline → mock output
// PRD refs: Appendix D (OPC-UA Input Plugin Specification), §4 Architecture Overview

import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import {
  OpcuaInput,
  OpcuaConfigSchema,
  type OpcuaClient,
  type OpcuaClientOptions,
  type OpcuaAuthOptions,
  type OpcuaSubscriptionParams,
  type OpcuaMonitoredItemParams,
  type DataChangeEvent,
  type BrowseResultNode,
} from "@plugins/inputs/opcua";
import type { Metric } from "@core/metric";
import type { Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Mock OPC-UA client (minimal for integration — emits data changes on demand)
// ---------------------------------------------------------------------------

class MockOpcuaClient implements OpcuaClient {
  private _isConnected = false;
  private _sessionActive = false;
  private dataChangeHandler: ((event: DataChangeEvent) => void) | null = null;
  monitoredItems: OpcuaMonitoredItemParams[] = [];

  get isConnected(): boolean { return this._isConnected; }
  get sessionActive(): boolean { return this._sessionActive; }

  async connect(_endpointUrl: string, _options: OpcuaClientOptions): Promise<void> {
    this._isConnected = true;
  }
  async createSession(_auth?: OpcuaAuthOptions): Promise<void> {
    this._sessionActive = true;
  }
  async createSubscription(_params: OpcuaSubscriptionParams): Promise<void> {}
  async addMonitoredItem(item: OpcuaMonitoredItemParams): Promise<void> {
    this.monitoredItems.push(item);
  }
  onDataChange(handler: (event: DataChangeEvent) => void): void {
    this.dataChangeHandler = handler;
  }
  onClose(_handler: () => void): void {
    // Not used in integration tests — reconnection tested in unit tests
  }
  async transferSubscriptions(): Promise<boolean> { return false; }
  async browse(_rootNodeId: string, _maxDepth: number, _nodeClasses: string[]): Promise<BrowseResultNode[]> {
    return [];
  }
  async resolveNamespaceUri(_uri: string): Promise<number> { return 0; }
  async closeSession(): Promise<void> { this._sessionActive = false; }
  async disconnect(): Promise<void> {
    this._isConnected = false;
    this._sessionActive = false;
  }

  /** Emit a data change event (simulates OPC-UA server notification). */
  emitDataChange(event: DataChangeEvent): void {
    if (this.dataChangeHandler) {
      this.dataChangeHandler(event);
    }
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
// Tests
// ---------------------------------------------------------------------------

describe("Integration: OPC-UA input → pipeline → output", () => {
  it("OPC-UA subscription → pipeline → output: value changes produce metrics", async () => {
    const mockClient = new MockOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: "opc.tcp://192.168.1.50:4840",
      security_policy: "None",
      security_mode: "None",
      nodes: [
        { node_id: "ns=2;s=Temperature", name: "temperature" },
        { node_id: "ns=2;s=Pressure", name: "pressure" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();

    // Emit data changes (simulating OPC-UA server notifications)
    mockClient.emitDataChange({
      nodeId: "ns=2;s=Temperature",
      value: 23.5,
      dataType: "Double",
      sourceTimestamp: new Date("2026-01-15T10:00:00Z"),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    mockClient.emitDataChange({
      nodeId: "ns=2;s=Pressure",
      value: 101.3,
      dataType: "Double",
      sourceTimestamp: new Date("2026-01-15T10:00:00Z"),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    // Wait for flush cycle to deliver metrics to output
    await Bun.sleep(200);
    await pipeline.stop();

    expect(output.connected).toBe(true);
    expect(output.written.length).toBeGreaterThanOrEqual(2);

    const temps = output.written.filter((m) => m.name === "temperature");
    const pressures = output.written.filter((m) => m.name === "pressure");
    expect(temps.length).toBeGreaterThanOrEqual(1);
    expect(pressures.length).toBeGreaterThanOrEqual(1);

    expect(temps[0]!.getField("value")).toBe(23.5);
    expect(pressures[0]!.getField("value")).toBeCloseTo(101.3, 1);
  });

  it("data types preserved through pipeline (number, string, boolean)", async () => {
    const mockClient = new MockOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: "opc.tcp://192.168.1.50:4840",
      security_policy: "None",
      security_mode: "None",
      nodes: [
        { node_id: "ns=2;s=Speed", name: "speed" },
        { node_id: "ns=2;s=Status", name: "status" },
        { node_id: "ns=2;s=Running", name: "running" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();

    // Number (Double)
    mockClient.emitDataChange({
      nodeId: "ns=2;s=Speed",
      value: 1485.5,
      dataType: "Double",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    // String
    mockClient.emitDataChange({
      nodeId: "ns=2;s=Status",
      value: "running_normal",
      dataType: "String",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    // Boolean
    mockClient.emitDataChange({
      nodeId: "ns=2;s=Running",
      value: true,
      dataType: "Boolean",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    await Bun.sleep(200);
    await pipeline.stop();

    expect(output.written.length).toBeGreaterThanOrEqual(3);

    const speed = output.written.find((m) => m.name === "speed");
    const status = output.written.find((m) => m.name === "status");
    const running = output.written.find((m) => m.name === "running");

    expect(speed).toBeDefined();
    expect(status).toBeDefined();
    expect(running).toBeDefined();

    // Number preserved
    expect(speed!.getField("value")).toBe(1485.5);
    // String preserved
    expect(status!.getField("value")).toBe("running_normal");
    // Boolean preserved
    expect(running!.getField("value")).toBe(true);
  });

  it("quality tags present on output metrics", async () => {
    const mockClient = new MockOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: "opc.tcp://192.168.1.50:4840",
      security_policy: "None",
      security_mode: "None",
      nodes: [
        { node_id: "ns=2;s=Sensor1", name: "sensor_good" },
        { node_id: "ns=2;s=Sensor2", name: "sensor_bad" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();

    // Good quality
    mockClient.emitDataChange({
      nodeId: "ns=2;s=Sensor1",
      value: 42.0,
      dataType: "Double",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    // Bad quality — still emitted per PRD D.3
    mockClient.emitDataChange({
      nodeId: "ns=2;s=Sensor2",
      value: 0.0,
      dataType: "Double",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x80000000,
      quality: "bad",
    });

    await Bun.sleep(200);
    await pipeline.stop();

    expect(output.written.length).toBeGreaterThanOrEqual(2);

    const good = output.written.find((m) => m.name === "sensor_good");
    const bad = output.written.find((m) => m.name === "sensor_bad");

    expect(good).toBeDefined();
    expect(bad).toBeDefined();

    // Quality tags flow through pipeline
    expect(good!.getTag("quality")).toBe("good");
    expect(bad!.getTag("quality")).toBe("bad");

    // Bad-quality value is still emitted (not dropped)
    expect(bad!.getField("value")).toBe(0.0);
  });

  it("global tags applied to OPC-UA metrics", async () => {
    const mockClient = new MockOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: "opc.tcp://192.168.1.50:4840",
      security_policy: "None",
      security_mode: "None",
      nodes: [
        { node_id: "ns=2;s=Temperature", name: "temperature" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      globalTags: { site: "factory_a", line: "3" },
    });

    await pipeline.start();

    mockClient.emitDataChange({
      nodeId: "ns=2;s=Temperature",
      value: 25.0,
      dataType: "Double",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    await Bun.sleep(200);
    await pipeline.stop();

    expect(output.written.length).toBeGreaterThanOrEqual(1);
    const m = output.written[0]!;

    // Global tags applied by pipeline
    expect(m.getTag("site")).toBe("factory_a");
    expect(m.getTag("line")).toBe("3");

    // OPC-UA quality tag also present
    expect(m.getTag("quality")).toBe("good");
  });
});
