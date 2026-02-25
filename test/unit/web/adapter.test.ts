import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { PipelineWebUIAdapter } from "../../../src/web/adapter";
import type { PipelineStateSource, OpcuaInputInfo } from "../../../src/web/adapter";
import { PipelineRuntime } from "../../../src/pipeline/runtime";
import type { PipelineOptions, PipelineState } from "../../../src/pipeline/runtime";
import { createMetric } from "../../../src/core/metric";
import { resolveNetworkPolicy } from "../../../src/core/network-policy";
import type { Accumulator } from "../../../src/core/accumulator";
import type { Input, Output } from "../../../src/core/plugin-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock that satisfies PipelineOptions for testing. */
function mockOptions(overrides?: Partial<PipelineOptions>): PipelineOptions {
  return {
    inputs: [
      { plugin: { gather: async () => {} }, alias: "modbus_plc01", pluginType: "modbus" },
      { plugin: { gather: async () => {} }, alias: "opcua_server1", pluginType: "opcua" },
    ],
    processors: [
      { plugin: { process: async () => {} }, alias: "rename_fields" },
    ],
    aggregators: [
      { plugin: { add: () => {}, push: () => {}, reset: () => {} }, alias: "basicstats_temp" },
    ],
    outputs: [
      { plugin: { connect: async () => {}, write: async () => {}, close: async () => {} }, alias: "local_store" },
      { plugin: { connect: async () => {}, write: async () => {}, close: async () => {} }, alias: "file_out" },
    ],
    gatherIntervalMs: 1000,
    flushIntervalMs: 1000,
    ...overrides,
  };
}

/** Mutable state source for testing. */
function mockStateSource(initial: PipelineState = "stopped"): PipelineStateSource & { _state: PipelineState; _startedAt: number | null } {
  return {
    _state: initial,
    _startedAt: null,
    get state() { return this._state; },
    get startedAt() { return this._startedAt; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PipelineWebUIAdapter", () => {
  describe("getStatus()", () => {
    it("returns 'stopped' and null startedAt when pipeline not started", () => {
      const stateSource = mockStateSource("stopped");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const status = adapter.getStatus();
      expect(status.state).toBe("stopped");
      expect(status.startedAt).toBeNull();
    });

    it("returns 'running' after pipeline starts", () => {
      const stateSource = mockStateSource("running");
      stateSource._startedAt = Date.now();
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const status = adapter.getStatus();
      expect(status.state).toBe("running");
      expect(status.startedAt).toBeTypeOf("number");
    });

    it("reflects state changes from source", () => {
      const stateSource = mockStateSource("stopped");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      expect(adapter.getStatus().state).toBe("stopped");

      stateSource._state = "starting";
      expect(adapter.getStatus().state).toBe("starting");

      stateSource._state = "running";
      expect(adapter.getStatus().state).toBe("running");

      stateSource._state = "stopping";
      expect(adapter.getStatus().state).toBe("stopping");

      stateSource._state = "stopped";
      expect(adapter.getStatus().state).toBe("stopped");
    });
  });

  describe("getPluginHealth()", () => {
    it("returns correct aliases and types from PipelineOptions", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const health = adapter.getPluginHealth();

      // 2 inputs + 1 processor + 1 aggregator + 2 outputs = 6
      expect(health).toHaveLength(6);

      // Check inputs
      const inputs = health.filter((h) => h.type === "input");
      expect(inputs).toHaveLength(2);
      expect(inputs[0]!.alias).toBe("modbus_plc01");
      expect(inputs[1]!.alias).toBe("opcua_server1");

      // Check processor
      const procs = health.filter((h) => h.type === "processor");
      expect(procs).toHaveLength(1);
      expect(procs[0]!.alias).toBe("rename_fields");

      // Check aggregator
      const aggs = health.filter((h) => h.type === "aggregator");
      expect(aggs).toHaveLength(1);
      expect(aggs[0]!.alias).toBe("basicstats_temp");

      // Check outputs
      const outputs = health.filter((h) => h.type === "output");
      expect(outputs).toHaveLength(2);
      expect(outputs[0]!.alias).toBe("local_store");
      expect(outputs[1]!.alias).toBe("file_out");
    });

    it("reports 'ok' when pipeline is running", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const health = adapter.getPluginHealth();
      for (const h of health) {
        expect(h.status).toBe("ok");
      }
    });

    it("reports 'stopped' when pipeline is not running", () => {
      const stateSource = mockStateSource("stopped");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const health = adapter.getPluginHealth();
      for (const h of health) {
        expect(h.status).toBe("stopped");
      }
    });

    it("tracks lastActivity per input alias via handleMetric", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      // Feed a metric with _device_id tag matching input alias
      const metric = createMetric({
        name: "temperature",
        fields: { value: 23.5 },
        tags: { _device_id: "modbus_plc01" },
      });

      const beforeFeed = Date.now();
      adapter.handleMetric(metric);

      const health = adapter.getPluginHealth();
      const modbusInput = health.find((h) => h.alias === "modbus_plc01");
      expect(modbusInput).toBeDefined();
      expect(modbusInput!.lastActivity).toBeTypeOf("number");
      expect(modbusInput!.lastActivity!).toBeGreaterThanOrEqual(beforeFeed);

      // opcua_server1 has no activity yet
      const opcuaInput = health.find((h) => h.alias === "opcua_server1");
      expect(opcuaInput!.lastActivity).toBeNull();
    });
  });

  describe("getLiveMetrics()", () => {
    it("returns latest metric per unique name after handleMetric calls", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const metric1 = createMetric({
        name: "temperature",
        fields: { value: 23.5 },
        tags: { location: "zone_a" },
        timestamp: 1000000000000000000n,
      });

      const metric2 = createMetric({
        name: "pressure",
        fields: { value: 1013.25 },
        tags: { location: "zone_b" },
        timestamp: 1000000001000000000n,
      });

      adapter.handleMetric(metric1);
      adapter.handleMetric(metric2);

      const metrics = adapter.getLiveMetrics();
      expect(metrics.size).toBe(2);
      expect(metrics.has("temperature")).toBe(true);
      expect(metrics.has("pressure")).toBe(true);

      const temp = metrics.get("temperature")!;
      expect(temp.name).toBe("temperature");
      expect(temp.fields.value).toBe(23.5);
      expect(temp.tags.location).toBe("zone_a");
      expect(temp.timestamp).toBe(1000000000000000000n);
      expect(temp.quality).toBe(1.0);
    });

    it("overwrites older values for the same metric name", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      adapter.handleMetric(createMetric({
        name: "temperature",
        fields: { value: 20.0 },
        timestamp: 1000000000000000000n,
      }));

      adapter.handleMetric(createMetric({
        name: "temperature",
        fields: { value: 25.0 },
        timestamp: 1000000002000000000n,
      }));

      const metrics = adapter.getLiveMetrics();
      expect(metrics.size).toBe(1);
      expect(metrics.get("temperature")!.fields.value).toBe(25.0);
      expect(metrics.get("temperature")!.timestamp).toBe(1000000002000000000n);
    });

    it("returns a copy (mutations don't affect adapter state)", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      adapter.handleMetric(createMetric({
        name: "temperature",
        fields: { value: 20.0 },
      }));

      const copy1 = adapter.getLiveMetrics();
      copy1.delete("temperature");

      const copy2 = adapter.getLiveMetrics();
      expect(copy2.size).toBe(1);
    });

    it("returns empty map when no metrics have flowed", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const metrics = adapter.getLiveMetrics();
      expect(metrics.size).toBe(0);
    });
  });

  describe("getNetworkPolicy()", () => {
    it("returns mode and summary when policy is set", () => {
      const policy = resolveNetworkPolicy({ mode: "local_network" });
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(
        mockOptions({ networkPolicy: policy }),
        stateSource,
      );

      const result = adapter.getNetworkPolicy();
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("local_network");
      expect(result!.summary).toContain("LOCAL NETWORK");
    });

    it("returns null when no policy is configured", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(
        mockOptions({ networkPolicy: undefined }),
        stateSource,
      );

      expect(adapter.getNetworkPolicy()).toBeNull();
    });

    it("returns 'connected' mode info for default policy", () => {
      const policy = resolveNetworkPolicy({ mode: "connected" });
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(
        mockOptions({ networkPolicy: policy }),
        stateSource,
      );

      const result = adapter.getNetworkPolicy()!;
      expect(result.mode).toBe("connected");
      expect(result.summary).toContain("CONNECTED");
    });

    it("returns 'standalone' mode info", () => {
      const policy = resolveNetworkPolicy({ mode: "standalone" });
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(
        mockOptions({ networkPolicy: policy }),
        stateSource,
      );

      const result = adapter.getNetworkPolicy()!;
      expect(result.mode).toBe("standalone");
      expect(result.summary).toContain("STANDALONE");
    });
  });

  describe("getUptime()", () => {
    it("returns 0 when pipeline has not started", () => {
      const stateSource = mockStateSource("stopped");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      expect(adapter.getUptime()).toBe(0);
    });

    it("increases over time after pipeline starts", async () => {
      const stateSource = mockStateSource("running");
      stateSource._startedAt = Date.now() - 100; // started 100ms ago
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const uptime1 = adapter.getUptime();
      expect(uptime1).toBeGreaterThanOrEqual(100);

      await Bun.sleep(50);
      const uptime2 = adapter.getUptime();
      expect(uptime2).toBeGreaterThan(uptime1);
    });
  });

  describe("getMemoryUsage()", () => {
    it("returns positive numbers for heapUsed, heapTotal, and rss", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const mem = adapter.getMemoryUsage();
      expect(mem.heapUsed).toBeGreaterThan(0);
      expect(mem.heapTotal).toBeGreaterThan(0);
      expect(mem.rss).toBeGreaterThan(0);
    });

    it("heapUsed and heapTotal are in a reasonable range relative to rss", () => {
      const stateSource = mockStateSource("running");
      const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

      const mem = adapter.getMemoryUsage();
      // heapUsed can temporarily exceed heapTotal during GC pressure (V8 behaviour),
      // so we only assert they are in a reasonable range relative to rss.
      expect(mem.heapUsed).toBeLessThan(mem.rss);
      expect(mem.heapTotal).toBeLessThan(mem.rss);
    });
  });
});

// ---------------------------------------------------------------------------
// PipelineRuntime state tracking and metric sink integration
// ---------------------------------------------------------------------------

describe("PipelineRuntime state and metric sink", () => {
  // Minimal mock plugins for runtime tests
  class TestInput implements Input {
    gatherCount = 0;
    async gather(acc: Accumulator): Promise<void> {
      acc.addFields("test_metric", { value: this.gatherCount++ }, { _device_id: "test_input" });
    }
    async close(): Promise<void> {}
  }

  class TestOutput implements Output {
    written: any[][] = [];
    async connect(): Promise<void> {}
    async write(batch: any[]): Promise<void> {
      this.written.push(batch);
    }
    async close(): Promise<void> {}
  }

  it("state is 'stopped' before start()", () => {
    const runtime = new PipelineRuntime({
      inputs: [],
      processors: [],
      aggregators: [],
      outputs: [],
      gatherIntervalMs: 1000,
      flushIntervalMs: 1000,
    });

    expect(runtime.state).toBe("stopped");
    expect(runtime.startedAt).toBeNull();
  });

  it("state transitions through starting → running → stopping → stopped", async () => {
    const input = new TestInput();
    const output = new TestOutput();

    const runtime = new PipelineRuntime({
      inputs: [{ plugin: input, interval: 100, alias: "test_input" }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output, alias: "test_output" }],
      gatherIntervalMs: 100,
      flushIntervalMs: 100,
    });

    expect(runtime.state).toBe("stopped");

    await runtime.start();
    expect(runtime.state).toBe("running");
    expect(runtime.startedAt).toBeTypeOf("number");

    // Let it run briefly
    await Bun.sleep(150);

    await runtime.stop();
    expect(runtime.state).toBe("stopped");
  });

  it("metric sink receives metrics flowing through the pipeline", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const sinkMetrics: string[] = [];

    const runtime = new PipelineRuntime({
      inputs: [{ plugin: input, interval: 50, alias: "test_input" }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output, alias: "test_output" }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    runtime.registerMetricSink((metric) => {
      sinkMetrics.push(metric.name);
    });

    await runtime.start();

    // Wait for a few gather cycles to produce metrics
    await Bun.sleep(200);

    await runtime.stop();

    // The metric sink should have received metrics
    expect(sinkMetrics.length).toBeGreaterThan(0);
    expect(sinkMetrics[0]).toBe("test_metric");
  });

  it("adapter receives live metrics via metric sink wiring", async () => {
    const input = new TestInput();
    const output = new TestOutput();

    const options: PipelineOptions = {
      inputs: [{ plugin: input, interval: 50, alias: "test_input" }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output, alias: "test_output" }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    };

    const runtime = new PipelineRuntime(options);
    const adapter = new PipelineWebUIAdapter(options, runtime);

    runtime.registerMetricSink((metric) => adapter.handleMetric(metric));

    await runtime.start();

    // Wait for metrics to flow
    await Bun.sleep(200);

    const metrics = adapter.getLiveMetrics();
    expect(metrics.size).toBeGreaterThan(0);
    expect(metrics.has("test_metric")).toBe(true);

    await runtime.stop();
  });

  it("pipelineOptions getter exposes options", () => {
    const options: PipelineOptions = {
      inputs: [{ plugin: { gather: async () => {} }, alias: "inp" }],
      processors: [],
      aggregators: [],
      outputs: [],
      gatherIntervalMs: 1000,
      flushIntervalMs: 1000,
    };
    const runtime = new PipelineRuntime(options);

    expect(runtime.pipelineOptions).toBe(options);
    expect(runtime.pipelineOptions.inputs[0]!.alias).toBe("inp");
  });
});

// ---------------------------------------------------------------------------
// getCertificateInfo() — OPC-UA certificate management (Task 9.6)
// ---------------------------------------------------------------------------

describe("PipelineWebUIAdapter.getCertificateInfo()", () => {
  let certTempDir: string;

  beforeEach(async () => {
    certTempDir = await mkdtemp(join(tmpdir(), "collatr-adapter-cert-"));
  });

  afterEach(async () => {
    await rm(certTempDir, { recursive: true, force: true });
  });

  function generateTestCert(dir: string): { certPath: string; keyPath: string } {
    const certPath = join(dir, "test-cert.pem");
    const keyPath = join(dir, "test-key.pem");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=collatr-edge-test" 2>/dev/null`,
    );
    return { certPath, keyPath };
  }

  it("returns null clientCert and empty inputs when no OPC-UA inputs provided", () => {
    const stateSource = mockStateSource("running");
    const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

    const info = adapter.getCertificateInfo();
    expect(info.clientCert).toBeNull();
    expect(info.inputs).toEqual([]);
  });

  it("returns clientCert info when certificate file exists", () => {
    const { certPath, keyPath } = generateTestCert(certTempDir);
    const opcuaInputs: OpcuaInputInfo[] = [{
      alias: "opcua1",
      endpoint: "opc.tcp://192.168.1.50:4840",
      certificatePath: certPath,
      privateKeyPath: keyPath,
    }];

    const stateSource = mockStateSource("running");
    const adapter = new PipelineWebUIAdapter(
      mockOptions(), stateSource, null, opcuaInputs,
    );

    const info = adapter.getCertificateInfo();
    expect(info.clientCert).not.toBeNull();
    expect(info.clientCert!.exists).toBe(true);
    expect(info.clientCert!.path).toBe(certPath);
    expect(info.clientCert!.thumbprint).toBeTruthy();
    expect(info.clientCert!.thumbprint).toContain(":"); // colon-separated hex
    expect(info.clientCert!.subject).toContain("CN=collatr-edge-test");
    expect(info.clientCert!.validFrom).toBeTruthy();
    expect(info.clientCert!.validTo).toBeTruthy();
  });

  it("returns exists=false when certificate file does not exist", () => {
    const opcuaInputs: OpcuaInputInfo[] = [{
      alias: "opcua1",
      endpoint: "opc.tcp://192.168.1.50:4840",
      certificatePath: join(certTempDir, "nonexistent.pem"),
    }];

    const stateSource = mockStateSource("running");
    const adapter = new PipelineWebUIAdapter(
      mockOptions(), stateSource, null, opcuaInputs,
    );

    const info = adapter.getCertificateInfo();
    expect(info.clientCert).not.toBeNull();
    expect(info.clientCert!.exists).toBe(false);
    expect(info.clientCert!.thumbprint).toBeUndefined();
  });

  it("returns OPC-UA inputs with connection state based on pipeline state", () => {
    const opcuaInputs: OpcuaInputInfo[] = [
      { alias: "siemens", endpoint: "opc.tcp://192.168.10.50:4840" },
      { alias: "kepware", endpoint: "opc.tcp://192.168.10.51:4840" },
    ];

    const stateSource = mockStateSource("running");
    const adapter = new PipelineWebUIAdapter(
      mockOptions(), stateSource, null, opcuaInputs,
    );

    const info = adapter.getCertificateInfo();
    expect(info.inputs).toHaveLength(2);
    // No metrics have flowed, so state is "unknown" when running
    expect(info.inputs[0]!.connectionState).toBe("unknown");
    expect(info.inputs[0]!.alias).toBe("siemens");
    expect(info.inputs[0]!.endpoint).toBe("opc.tcp://192.168.10.50:4840");
  });

  it("reports 'connected' when metrics have flowed for an alias", () => {
    const opcuaInputs: OpcuaInputInfo[] = [
      { alias: "siemens", endpoint: "opc.tcp://192.168.10.50:4840" },
    ];

    const stateSource = mockStateSource("running");
    const adapter = new PipelineWebUIAdapter(
      mockOptions(), stateSource, null, opcuaInputs,
    );

    // Simulate metrics flowing for the "siemens" alias
    adapter.handleMetric(createMetric({
      name: "temperature",
      fields: { value: 23.5 },
      tags: { _device_id: "siemens" },
    }));

    const info = adapter.getCertificateInfo();
    expect(info.inputs[0]!.connectionState).toBe("connected");
  });

  it("reports 'disconnected' when pipeline is stopped", () => {
    const opcuaInputs: OpcuaInputInfo[] = [
      { alias: "siemens", endpoint: "opc.tcp://192.168.10.50:4840" },
    ];

    const stateSource = mockStateSource("stopped");
    const adapter = new PipelineWebUIAdapter(
      mockOptions(), stateSource, null, opcuaInputs,
    );

    const info = adapter.getCertificateInfo();
    expect(info.inputs[0]!.connectionState).toBe("disconnected");
  });

  it("getTrustStorePath returns path derived from cert directory", () => {
    const { certPath, keyPath } = generateTestCert(certTempDir);
    const opcuaInputs: OpcuaInputInfo[] = [{
      alias: "opcua1",
      endpoint: "opc.tcp://host:4840",
      certificatePath: certPath,
      privateKeyPath: keyPath,
    }];

    const stateSource = mockStateSource("running");
    const adapter = new PipelineWebUIAdapter(
      mockOptions(), stateSource, null, opcuaInputs,
    );

    const trustPath = adapter.getTrustStorePath();
    expect(trustPath).toBeTruthy();
    expect(trustPath).toContain("trusted-servers.json");
    expect(trustPath).toContain(certTempDir);
  });

  it("getTrustStorePath returns null when no OPC-UA inputs have certs", () => {
    const stateSource = mockStateSource("running");
    const adapter = new PipelineWebUIAdapter(mockOptions(), stateSource);

    expect(adapter.getTrustStorePath()).toBeNull();
  });
});
