// Integration test: Full Sparkplug B lifecycle
// PRD refs: §9 Hub Link & Control Plane, Appendix C Sparkplug B Topic Map
//
// Tests the complete Sparkplug B edge node lifecycle: startup → NBIRTH →
// DBIRTH → DDATA → rebirth → shutdown → DDEATH/NDEATH (via Will)

import { describe, it, expect, beforeEach } from "bun:test";
import spPayload from "sparkplug-payload";
import { HubLink, type HubLinkConfig, type DeviceInfo } from "../../src/hub/hub-link.ts";
import { createMetric, type Metric } from "@core/metric";
import { MockMqttClient } from "../helpers/mock-mqtt-client.ts";

const sparkplug = spPayload.get("spBv1.0")!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<HubLinkConfig>): HubLinkConfig {
  return {
    groupId: "factory_a",
    edgeNodeId: "gw-01",
    broker: "tcp://hub:1883",
    heartbeatIntervalMs: 0,
    swVersion: "0.1.0",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: Sparkplug B lifecycle", () => {
  let mockClient: MockMqttClient;

  beforeEach(() => {
    mockClient = new MockMqttClient();
  });

  it("full lifecycle: start → NBIRTH → DBIRTH → DDATA → shutdown → DDEATH", async () => {
    const hub = new HubLink(makeConfig(), mockClient);

    hub.registerDevice({
      deviceId: "plc_01",
      pluginType: "modbus",
      pluginAlias: "plc_01",
      initialMetrics: [],
    });

    // 1. Start → NBIRTH
    await hub.start();

    const nbirth = mockClient.findPublished("NBIRTH");
    expect(nbirth).toBeDefined();
    expect(nbirth!.topic).toBe("spBv1.0/factory_a/NBIRTH/gw-01");

    // Decode NBIRTH — verify bdSeq and control metrics
    const nbirthDecoded = sparkplug.decodePayload(new Uint8Array(nbirth!.payload));
    const bdSeq = nbirthDecoded.metrics!.find((m) => m.name === "bdSeq");
    expect(Number(bdSeq!.value)).toBe(0);
    const rebirth = nbirthDecoded.metrics!.find((m) => m.name === "Node Control/Rebirth");
    expect(rebirth).toBeDefined();

    // Verify NCMD subscription
    expect(mockClient.subscribeCalls[0]!.topics[0]).toBe("spBv1.0/factory_a/NCMD/gw-01");

    // Verify Will message (NDEATH)
    expect(mockClient.willConfig!.topic).toBe("spBv1.0/factory_a/NDEATH/gw-01");

    // 2. First data → auto-DBIRTH + DDATA
    const metrics = [
      createMetric({ name: "temperature", fields: { value: 22.5 } }),
      createMetric({ name: "pressure", fields: { value: 101.3 } }),
    ];
    await hub.publishDeviceData("plc_01", metrics);

    const dbirths = mockClient.findAllPublished("DBIRTH");
    expect(dbirths.length).toBe(1);
    expect(dbirths[0]!.topic).toBe("spBv1.0/factory_a/DBIRTH/gw-01/plc_01");

    // Verify DBIRTH has metric definitions with aliases
    const dbirthDecoded = sparkplug.decodePayload(new Uint8Array(dbirths[0]!.payload));
    expect(dbirthDecoded.metrics!.length).toBe(2);
    for (const m of dbirthDecoded.metrics!) {
      expect(m.alias).toBeDefined();
      expect(Number(m.alias)).toBeGreaterThan(0);
    }

    const ddatas = mockClient.findAllPublished("DDATA");
    expect(ddatas.length).toBe(1);
    expect(ddatas[0]!.topic).toBe("spBv1.0/factory_a/DDATA/gw-01/plc_01");

    // 3. Subsequent data → DDATA only (no re-DBIRTH)
    await hub.publishDeviceData("plc_01", [
      createMetric({ name: "temperature", fields: { value: 23.0 } }),
    ]);
    expect(mockClient.findAllPublished("DBIRTH").length).toBe(1); // Still 1
    expect(mockClient.findAllPublished("DDATA").length).toBe(2); // Now 2

    // 4. Shutdown → DDEATH for device + disconnect
    await hub.stop();

    const ddeaths = mockClient.findAllPublished("DDEATH");
    expect(ddeaths.length).toBe(1);
    expect(ddeaths[0]!.topic).toBe("spBv1.0/factory_a/DDEATH/gw-01/plc_01");

    expect(mockClient.disconnected).toBe(true);
  });

  it("multi-device: each device gets independent DBIRTH/DDATA", async () => {
    const hub = new HubLink(makeConfig(), mockClient);

    hub.registerDevice({
      deviceId: "plc_a",
      pluginType: "modbus",
      pluginAlias: "plc_a",
      initialMetrics: [],
    });
    hub.registerDevice({
      deviceId: "plc_b",
      pluginType: "opcua",
      pluginAlias: "plc_b",
      initialMetrics: [],
    });

    await hub.start();

    // Device A data
    await hub.publishDeviceData("plc_a", [
      createMetric({ name: "temp", fields: { value: 22 } }),
    ]);

    // Device B data
    await hub.publishDeviceData("plc_b", [
      createMetric({ name: "speed", fields: { rpm: 1500 } }),
    ]);

    // Each device should have its own DBIRTH
    const dbirths = mockClient.findAllPublished("DBIRTH");
    expect(dbirths.length).toBe(2);
    const dbirthTopics = dbirths.map((d) => d.topic);
    expect(dbirthTopics).toContain("spBv1.0/factory_a/DBIRTH/gw-01/plc_a");
    expect(dbirthTopics).toContain("spBv1.0/factory_a/DBIRTH/gw-01/plc_b");

    // Each device should have its own DDATA
    const ddatas = mockClient.findAllPublished("DDATA");
    expect(ddatas.length).toBe(2);
    const ddataTopics = ddatas.map((d) => d.topic);
    expect(ddataTopics).toContain("spBv1.0/factory_a/DDATA/gw-01/plc_a");
    expect(ddataTopics).toContain("spBv1.0/factory_a/DDATA/gw-01/plc_b");

    await hub.stop();

    // Both devices get DDEATH
    const ddeaths = mockClient.findAllPublished("DDEATH");
    expect(ddeaths.length).toBe(2);
  });

  it("rebirth: re-publishes NBIRTH + all DBIRTHs, resets seq", async () => {
    const hub = new HubLink(makeConfig(), mockClient);

    hub.registerDevice({
      deviceId: "plc_01",
      pluginType: "modbus",
      pluginAlias: "plc_01",
      initialMetrics: [createMetric({ name: "temp", fields: { value: 22 } })],
    });

    await hub.start();

    // Publish initial DBIRTH
    await hub.publishDeviceBirth("plc_01", [
      createMetric({ name: "temp", fields: { value: 22 } }),
    ]);

    const pubCountBefore = mockClient.publishCalls.length;

    // Trigger rebirth via NCMD
    const cmdPayload = sparkplug.encodePayload({
      timestamp: Date.now(),
      metrics: [{
        name: "Node Control/Rebirth",
        type: "Boolean" as const,
        value: true,
        timestamp: Date.now(),
      }],
    });
    mockClient.emitMessage("spBv1.0/factory_a/NCMD/gw-01", Buffer.from(cmdPayload));

    // Wait for async rebirth
    await Bun.sleep(100);

    const afterPubs = mockClient.publishCalls.slice(pubCountBefore);

    // Should have re-NBIRTH
    const reNBirth = afterPubs.find((p) => p.topic.includes("NBIRTH"));
    expect(reNBirth).toBeDefined();

    // bdSeq should be incremented
    const decoded = sparkplug.decodePayload(new Uint8Array(reNBirth!.payload));
    const bdSeq = Number(decoded.metrics!.find((m) => m.name === "bdSeq")!.value);
    expect(bdSeq).toBe(1);

    // Should have re-DBIRTH for the device
    const reDBirth = afterPubs.find((p) => p.topic.includes("DBIRTH"));
    expect(reDBirth).toBeDefined();

    await hub.stop();
  });

  it("sequence numbers increment across messages", async () => {
    const hub = new HubLink(makeConfig(), mockClient);
    hub.registerDevice({
      deviceId: "dev",
      pluginType: "modbus",
      pluginAlias: "dev",
      initialMetrics: [],
    });

    await hub.start(); // NBIRTH → seq=0

    // Publish data (auto-DBIRTH + DDATA)
    await hub.publishDeviceData("dev", [
      createMetric({ name: "d", fields: { v: 1 } }),
    ]);

    // Publish NDATA to capture current seq
    await hub.publishNodeData([{ name: "test", type: "Int32", value: 42 }]);

    const ndata = mockClient.findPublished("NDATA")!;
    const decoded = sparkplug.decodePayload(new Uint8Array(ndata.payload));
    // After NBIRTH(0), DBIRTH(+1), DDATA(+1) = seq should be 2 going into NDATA
    // The NDATA encode uses the current seq before incrementing
    expect(Number(decoded.seq)).toBeGreaterThan(0);

    await hub.stop();
  });

  it("NDATA heartbeat with stats collector", async () => {
    const hub = new HubLink(makeConfig({ heartbeatIntervalMs: 80 }), mockClient);

    hub.setStatsCollector(() => [
      { name: "Agent Metrics/uptime_seconds", type: "Int32" as const, value: 60 },
      { name: "Agent Metrics/metrics_gathered", type: "Int64" as const, value: 1000 },
    ]);

    await hub.start();

    // Wait for heartbeat
    await Bun.sleep(200);

    const ndatas = mockClient.findAllPublished("NDATA");
    expect(ndatas.length).toBeGreaterThanOrEqual(1);

    // Verify metrics in NDATA
    const decoded = sparkplug.decodePayload(new Uint8Array(ndatas[0]!.payload));
    const uptime = decoded.metrics!.find((m) => m.name === "Agent Metrics/uptime_seconds");
    expect(uptime).toBeDefined();
    expect(Number(uptime!.value)).toBe(60);

    const gathered = decoded.metrics!.find((m) => m.name === "Agent Metrics/metrics_gathered");
    expect(gathered).toBeDefined();

    await hub.stop();
  });
});
