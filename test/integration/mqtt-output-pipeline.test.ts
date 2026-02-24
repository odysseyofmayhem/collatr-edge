// Integration test: MQTT output in pipeline
// PRD refs: §9 Hub Link & Control Plane, §6 Plugin System

import { describe, it, expect } from "bun:test";
import { buildPipeline } from "@pipeline/plugin-factory";
import { parseConfig } from "@core/config";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: MQTT output pipeline wiring", () => {
  it("pipeline works normally when hub is disabled (no MQTT connection attempt)", () => {
    const config = parseConfig(`
      [agent]
      interval = "10s"
      flush_interval = "10s"

      [[outputs.stdout]]
    `);

    const options = buildPipeline(config);
    expect(options.hubLink).toBeUndefined();
    expect(options.outputs.length).toBe(1);
  });

  it("pipeline works with stdout output when hub section absent", () => {
    const config = parseConfig(`
      [agent]
      interval = "5s"
      flush_interval = "5s"

      [[outputs.stdout]]
      format = "json"
    `);

    const options = buildPipeline(config);
    expect(options.hubLink).toBeUndefined();
    expect(options.outputs.length).toBe(1);
    expect(options.gatherIntervalMs).toBe(5000);
  });

  it("buildPipeline creates HubLink with correct config from [agent.hub]", () => {
    const saved = { ...process.env };
    process.env.BROKER_URL = "tcp://hub.factory.local:1883";

    try {
      const config = parseConfig(`
        [agent]
        interval = "10s"
        flush_interval = "10s"

        [agent.hub]
        enabled = true
        group_id = "plant_floor"
        edge_node_id = "edge-01"
        broker = "\${BROKER_URL}"
        heartbeat_interval = "15s"

        [[outputs.mqtt]]
        sparkplug = true
      `);

      const options = buildPipeline(config);

      // HubLink created
      expect(options.hubLink).toBeDefined();

      // MQTT output created
      expect(options.outputs.length).toBe(1);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  it("MQTT output in plain mode (not sparkplug) works without hub link", () => {
    const config = parseConfig(`
      [agent]
      interval = "10s"
      flush_interval = "10s"

      [[outputs.mqtt]]
      servers = ["tcp://broker:1883"]
      topic = "data/metrics"
      qos = 0
    `);

    const options = buildPipeline(config);
    expect(options.hubLink).toBeUndefined();
    expect(options.outputs.length).toBe(1);
  });

  it("multiple outputs: stdout + mqtt coexist", () => {
    const config = parseConfig(`
      [agent]
      interval = "10s"
      flush_interval = "10s"

      [[outputs.stdout]]

      [[outputs.mqtt]]
      servers = ["tcp://broker:1883"]
    `);

    const options = buildPipeline(config);
    expect(options.outputs.length).toBe(2);
  });
});
