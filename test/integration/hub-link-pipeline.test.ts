// Integration test: Hub link + MQTT output (sparkplug mode) pipeline wiring
// PRD refs: §9 Hub Link & Control Plane, §4 Architecture Overview

import { describe, it, expect, beforeEach } from "bun:test";
import { PipelineRuntime, type PipelineOptions } from "@pipeline/runtime";
import { buildPipeline } from "@pipeline/plugin-factory";
import { parseConfig, type AgentConfig } from "@core/config";
import { createMetric, type Metric } from "@core/metric";
import type { Input, Output } from "@core/plugin-types";
import type { Accumulator } from "@core/accumulator";
import type { HubLink } from "../../src/hub/hub-link";

// ---------------------------------------------------------------------------
// Mock input (emits metrics with known names)
// ---------------------------------------------------------------------------

class MockInput implements Input {
  gatherCalls: Accumulator[] = [];
  async gather(acc: Accumulator): Promise<void> {
    this.gatherCalls.push(acc);
    acc.addFields("temperature", { value: 22.5 }, { location: "factory" });
    acc.addFields("pressure", { value: 101.3 });
  }
}

// ---------------------------------------------------------------------------
// Mock Hub link (captures publish calls)
// ---------------------------------------------------------------------------

class MockHubLink {
  publishCalls: Array<{ deviceId: string; metrics: Metric[] }> = [];
  started = false;
  stopped = false;
  registeredDevices: string[] = [];

  registerDevice(info: { deviceId: string }): void {
    this.registeredDevices.push(info.deviceId);
  }

  async start(): Promise<void> { this.started = true; }

  async publishDeviceData(deviceId: string, metrics: Metric[]): Promise<void> {
    this.publishCalls.push({ deviceId, metrics });
  }

  async stop(): Promise<void> { this.stopped = true; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: Hub link pipeline wiring", () => {
  it("_device_id tag injected by accumulator when input has alias", async () => {
    const mockInput = new MockInput();
    const mockHubLink = new MockHubLink();
    const mockOutput: Output = {
      async connect() {},
      async write(batch: Metric[]) {
        // Check that metrics have _device_id tag
        for (const m of batch) {
          expect(m.getTag("_device_id")).toBe("plc_01");
        }
      },
      async close() {},
    };

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mockInput, alias: "plc_01" }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: mockOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      hubLink: mockHubLink as unknown as HubLink,
    });

    await pipeline.start();

    // Hub link should be started and device registered
    expect(mockHubLink.started).toBe(true);
    expect(mockHubLink.registeredDevices).toContain("plc_01");

    // Wait for gather + flush cycle
    await Bun.sleep(200);
    await pipeline.stop();

    // Hub link should be stopped during shutdown
    expect(mockHubLink.stopped).toBe(true);

    // Verify at least one gather happened with _device_id injection
    expect(mockInput.gatherCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("buildPipeline creates HubLink when hub.enabled", () => {
    // Set required env vars for config parsing
    const savedEnv = { ...process.env };
    process.env.MQTT_BROKER = "tcp://broker:1883";

    try {
      const config = parseConfig(`
        [agent]
        interval = "10s"
        flush_interval = "10s"

        [agent.hub]
        enabled = true
        group_id = "factory"
        edge_node_id = "gw-01"
        broker = "\${MQTT_BROKER}"

        [[outputs.stdout]]
      `);

      const options = buildPipeline(config);
      expect(options.hubLink).toBeDefined();
    } finally {
      // Restore env
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  });

  it("buildPipeline does NOT create HubLink when hub not enabled", () => {
    const config = parseConfig(`
      [agent]
      interval = "10s"
      flush_interval = "10s"

      [[outputs.stdout]]
    `);

    const options = buildPipeline(config);
    expect(options.hubLink).toBeUndefined();
  });

  it("MQTT output in sparkplug mode routes metrics through hub link", async () => {
    const mockHubLink = new MockHubLink();
    const mockInput = new MockInput();

    // Create a real MQTT output in sparkplug mode with the mock hub link
    const { MqttOutput, MqttOutputConfigSchema } = await import("@plugins/outputs/mqtt");
    const mqttConfig = MqttOutputConfigSchema.parse({ sparkplug: true });
    const mqttOutput = new MqttOutput(mqttConfig, mockHubLink as unknown as HubLink);

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mockInput, alias: "plc_01" }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: mqttOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      hubLink: mockHubLink as unknown as HubLink,
    });

    await pipeline.start();

    // Wait for gather + flush
    await Bun.sleep(300);
    await pipeline.stop();

    // Metrics should have been routed through hub link's publishDeviceData
    expect(mockHubLink.publishCalls.length).toBeGreaterThanOrEqual(1);

    // All calls should be for device "plc_01" (from input alias)
    for (const call of mockHubLink.publishCalls) {
      expect(call.deviceId).toBe("plc_01");
    }

    // Metrics should NOT have _device_id tag (stripped by MqttOutput)
    for (const call of mockHubLink.publishCalls) {
      for (const metric of call.metrics) {
        expect(metric.hasTag("_device_id")).toBe(false);
      }
    }
  });

  it("multiple inputs with aliases route to correct devices", async () => {
    const mockHubLink = new MockHubLink();

    const inputA: Input = {
      async gather(acc: Accumulator) {
        acc.addFields("temp_a", { value: 20 });
      },
    };
    const inputB: Input = {
      async gather(acc: Accumulator) {
        acc.addFields("temp_b", { value: 30 });
      },
    };

    const { MqttOutput, MqttOutputConfigSchema } = await import("@plugins/outputs/mqtt");
    const mqttConfig = MqttOutputConfigSchema.parse({ sparkplug: true });
    const mqttOutput = new MqttOutput(mqttConfig, mockHubLink as unknown as HubLink);

    const pipeline = new PipelineRuntime({
      inputs: [
        { plugin: inputA, alias: "plc_a" },
        { plugin: inputB, alias: "plc_b" },
      ],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: mqttOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      hubLink: mockHubLink as unknown as HubLink,
    });

    await pipeline.start();

    // Both devices registered
    expect(mockHubLink.registeredDevices).toContain("plc_a");
    expect(mockHubLink.registeredDevices).toContain("plc_b");

    // Wait for gather + flush
    await Bun.sleep(300);
    await pipeline.stop();

    // Should have publish calls for both devices
    const deviceIds = new Set(mockHubLink.publishCalls.map((c) => c.deviceId));
    expect(deviceIds.has("plc_a")).toBe(true);
    expect(deviceIds.has("plc_b")).toBe(true);
  });
});
