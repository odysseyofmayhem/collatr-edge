// Integration test: OPC-UA real client adapter — full pipeline with in-process server
// PRD refs: Appendix D (OPC-UA Input Plugin Specification), §8 Pipeline Lifecycle
// ──────────────────────────────────────────────────────────────────────────────
// These tests verify the end-to-end path:
//   config → OpcuaInput + RealOpcuaClient → PipelineRuntime → MockOutput
// using a real in-process node-opcua OPCUAServer. This proves that the
// RealOpcuaClient adapter correctly bridges OpcuaInput to node-opcua.
// ──────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { OpcuaInput, OpcuaConfigSchema } from "@plugins/inputs/opcua";
import { RealOpcuaClient } from "@core/opcua-client";
import { PipelineRuntime } from "@pipeline/runtime";
import type { Metric } from "@core/metric";
import type { Output } from "@core/plugin-types";
import { OPCUAServer, Variant, DataType } from "node-opcua";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Test server setup — shared across tests in this file
// ---------------------------------------------------------------------------

let server: InstanceType<typeof OPCUAServer>;
let endpointUrl: string;

const TEST_NAMESPACE_URI = "http://collatr-edge.test/UA/Integration";

// Mutable backing values for dynamic test nodes
let intValue = 42;
let floatValue = 3.14;
let doubleValue = 23.5;
let boolValue = true;

// Variable references for mutating during tests
let intVar: any;
let floatVar: any;
let doubleVar: any;
let boolVar: any;

beforeAll(async () => {
  server = new OPCUAServer({
    port: 0,
    resourcePath: "/integration",
  });

  await server.initialize();

  const addressSpace = server.engine.addressSpace!;
  const ns = addressSpace.registerNamespace(TEST_NAMESPACE_URI);
  const objectsFolder = addressSpace.rootFolder.objects;

  // Create a folder for test data (mirrors smoke test "Dynamic" pattern)
  const dynamicFolder = ns.addFolder(objectsFolder, { browseName: "Dynamic" });

  intVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "RandomInt32",
    dataType: "Int32",
    minimumSamplingInterval: 100,
    value: {
      get: () => new Variant({ dataType: DataType.Int32, value: intValue }),
    },
  });

  floatVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "RandomFloat",
    dataType: "Float",
    minimumSamplingInterval: 100,
    value: {
      get: () => new Variant({ dataType: DataType.Float, value: floatValue }),
    },
  });

  doubleVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "RandomDouble",
    dataType: "Double",
    minimumSamplingInterval: 100,
    value: {
      get: () => new Variant({ dataType: DataType.Double, value: doubleValue }),
    },
  });

  boolVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "Running",
    dataType: "Boolean",
    minimumSamplingInterval: 100,
    value: {
      get: () => new Variant({ dataType: DataType.Boolean, value: boolValue }),
    },
  });

  await server.start();

  const serverPort = server.endpoints[0]!.port;
  endpointUrl = `opc.tcp://localhost:${serverPort}/integration`;
}, 15_000);

afterAll(async () => {
  if (server) {
    await server.shutdown();
  }
}, 10_000);

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
// Utility: wait for a condition with timeout
// ---------------------------------------------------------------------------

function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Condition not met within ${timeoutMs}ms`));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: OPC-UA real client → pipeline → output", () => {
  it("data flows from in-process OPC-UA server through pipeline to output", async () => {
    const client = new RealOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: endpointUrl,
      security_policy: "None",
      security_mode: "None",
      auth_method: "anonymous",
      subscription: { publishing_interval: "200ms" },
      nodes: [
        { node_id: intVar.nodeId.toString(), name: "random_int32" },
        { node_id: floatVar.nodeId.toString(), name: "random_float" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, client);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 100,
      flushIntervalMs: 200,
    });

    await pipeline.start();

    // Wait for data changes to flow through the pipeline
    await waitForCondition(() => output.written.length >= 2, 5000);

    await pipeline.stop();

    expect(output.connected).toBe(true);
    expect(output.closed).toBe(true);

    // Verify metrics arrived with correct measurement names
    const intMetrics = output.written.filter((m) => m.name === "random_int32");
    const floatMetrics = output.written.filter((m) => m.name === "random_float");
    expect(intMetrics.length).toBeGreaterThanOrEqual(1);
    expect(floatMetrics.length).toBeGreaterThanOrEqual(1);

    // Verify field values are numeric
    const intVal = intMetrics[0]!.getField("value");
    expect(typeof intVal).toBe("number");
    expect(intVal).toBe(42); // intValue = 42

    const fltVal = floatMetrics[0]!.getField("value");
    expect(typeof fltVal).toBe("number");
    expect(fltVal).toBeCloseTo(3.14, 1);

    // Verify quality tag is present
    expect(intMetrics[0]!.getTag("quality")).toBe("good");
    expect(floatMetrics[0]!.getTag("quality")).toBe("good");

    // Verify timestamps are present (source timestamp from OPC-UA server)
    expect(intMetrics[0]!.timestamp).toBeGreaterThan(0n);
  }, 15_000);

  it("all four data types flow correctly through pipeline", async () => {
    const client = new RealOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: endpointUrl,
      security_policy: "None",
      security_mode: "None",
      auth_method: "anonymous",
      subscription: { publishing_interval: "200ms" },
      nodes: [
        { node_id: intVar.nodeId.toString(), name: "test_int" },
        { node_id: floatVar.nodeId.toString(), name: "test_float" },
        { node_id: doubleVar.nodeId.toString(), name: "test_double" },
        { node_id: boolVar.nodeId.toString(), name: "test_bool" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, client);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 100,
      flushIntervalMs: 200,
    });

    await pipeline.start();
    await waitForCondition(() => {
      const names = new Set(output.written.map((m) => m.name));
      return names.has("test_int") && names.has("test_float") &&
             names.has("test_double") && names.has("test_bool");
    }, 5000);
    await pipeline.stop();

    // Verify all four measurement names arrived
    const names = new Set(output.written.map((m) => m.name));
    expect(names.has("test_int")).toBe(true);
    expect(names.has("test_float")).toBe(true);
    expect(names.has("test_double")).toBe(true);
    expect(names.has("test_bool")).toBe(true);

    // Verify values have correct types
    const intMetric = output.written.find((m) => m.name === "test_int")!;
    expect(typeof intMetric.getField("value")).toBe("number");

    const floatMetric = output.written.find((m) => m.name === "test_float")!;
    expect(typeof floatMetric.getField("value")).toBe("number");

    const doubleMetric = output.written.find((m) => m.name === "test_double")!;
    expect(typeof doubleMetric.getField("value")).toBe("number");

    const boolMetric = output.written.find((m) => m.name === "test_bool")!;
    expect(typeof boolMetric.getField("value")).toBe("boolean");
  }, 15_000);

  it("value mutations produce updated metrics in output", async () => {
    // Reset to known value
    intValue = 100;

    const client = new RealOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: endpointUrl,
      security_policy: "None",
      security_mode: "None",
      auth_method: "anonymous",
      subscription: { publishing_interval: "200ms" },
      nodes: [
        { node_id: intVar.nodeId.toString(), name: "mutation_test" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, client);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 100,
      flushIntervalMs: 200,
    });

    await pipeline.start();

    // Wait for initial data
    await waitForCondition(() => output.written.length >= 1, 5000);

    // Mutate the server value
    intValue = 999;
    intVar.touchValue(new Date());

    // Wait for mutation to flow through
    await waitForCondition(
      () => output.written.some((m) => m.getField("value") === 999),
      5000,
    );

    await pipeline.stop();

    const mutatedMetric = output.written.find((m) => m.getField("value") === 999);
    expect(mutatedMetric).toBeDefined();
    expect(mutatedMetric!.name).toBe("mutation_test");
  }, 15_000);

  it("global tags applied to real OPC-UA metrics", async () => {
    const client = new RealOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: endpointUrl,
      security_policy: "None",
      security_mode: "None",
      auth_method: "anonymous",
      nodes: [
        { node_id: intVar.nodeId.toString(), name: "tagged_metric" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, client);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 100,
      flushIntervalMs: 200,
      globalTags: { site: "test_factory", line: "7" },
    });

    await pipeline.start();
    await waitForCondition(() => output.written.length >= 1, 5000);
    await pipeline.stop();

    const m = output.written[0]!;
    expect(m.getTag("site")).toBe("test_factory");
    expect(m.getTag("line")).toBe("7");
    expect(m.getTag("quality")).toBe("good");
  }, 15_000);

  it("clean shutdown: no errors, output closed", async () => {
    const client = new RealOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: endpointUrl,
      security_policy: "None",
      security_mode: "None",
      auth_method: "anonymous",
      nodes: [
        { node_id: intVar.nodeId.toString(), name: "shutdown_test" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, client);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 100,
      flushIntervalMs: 200,
    });

    await pipeline.start();
    await waitForCondition(() => output.written.length >= 1, 5000);

    // Stop should complete without throwing
    await pipeline.stop();

    expect(output.closed).toBe(true);
    // Client should be disconnected after stop
    expect(client.isConnected).toBe(false);
  }, 15_000);
});

describe("Integration: OPC-UA browse mode with real server", () => {
  it("browse discovers nodes and writes TOML output file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "collatr-opcua-browse-"));
    const outputFile = join(tempDir, "discovered-nodes.toml");

    try {
      const client = new RealOpcuaClient();
      const config = OpcuaConfigSchema.parse({
        endpoint: endpointUrl,
        security_policy: "None",
        security_mode: "None",
        auth_method: "anonymous",
        browse: {
          enabled: true,
          root_node_id: "ns=0;i=85", // ObjectsFolder
          max_depth: 3,
          node_classes: ["Variable", "Object"],
          output_file: outputFile,
        },
        nodes: [
          { node_id: intVar.nodeId.toString(), name: "browse_test" },
        ],
      });

      const opcuaInput = new OpcuaInput(config, client);
      const output = new MockOutput();

      const pipeline = new PipelineRuntime({
        inputs: [{ plugin: opcuaInput }],
        processors: [],
        aggregators: [],
        outputs: [{ plugin: output }],
        gatherIntervalMs: 100,
        flushIntervalMs: 200,
      });

      await pipeline.start();
      // Wait briefly for browse + subscription setup
      await waitForCondition(() => output.written.length >= 1, 5000);
      await pipeline.stop();

      // Verify output file was written
      const content = await readFile(outputFile, "utf-8");
      expect(content.length).toBeGreaterThan(0);

      // Verify TOML-comment format
      expect(content).toContain("# Discovered OPC-UA nodes from");
      expect(content).toContain("# [[inputs.opcua.nodes]]");
      expect(content).toContain("#   node_id =");
      expect(content).toContain("#   name =");

      // Verify our test nodes were discovered (names are lowercased by formatBrowseOutput)
      expect(content).toContain("randomint32");
      expect(content).toContain("randomfloat");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("Integration: OPC-UA security auto-negotiation", () => {
  it("auto security policy falls back to None for unsecured server", async () => {
    // The in-process server only supports SecurityPolicy.None.
    // Auto-negotiation should try higher policies first (fail), then
    // fall back to None and succeed.
    const client = new RealOpcuaClient();
    const config = OpcuaConfigSchema.parse({
      endpoint: endpointUrl,
      security_policy: "auto",
      security_mode: "auto",
      auth_method: "anonymous",
      nodes: [
        { node_id: intVar.nodeId.toString(), name: "auto_security" },
      ],
    });

    const opcuaInput = new OpcuaInput(config, client);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: opcuaInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 100,
      flushIntervalMs: 200,
    });

    // Should not throw — auto-negotiation falls back to None
    await pipeline.start();
    await waitForCondition(() => output.written.length >= 1, 8000);
    await pipeline.stop();

    // Data flows despite auto-negotiation
    expect(output.written.length).toBeGreaterThanOrEqual(1);
    const m = output.written[0]!;
    expect(m.name).toBe("auto_security");
    expect(typeof m.getField("value")).toBe("number");
  }, 20_000);
});
