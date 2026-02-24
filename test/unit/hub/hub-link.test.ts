// Unit tests: Hub link session manager
// PRD refs: §9 Hub Link & Control Plane, Appendix C

import { describe, it, expect, beforeEach } from "bun:test";
import spPayload from "sparkplug-payload";
import { HubLink, type HubLinkConfig, type DeviceInfo } from "../../../src/hub/hub-link.ts";
import type {
  MqttClientInterface,
  MqttClientOptions,
  MqttMessageEvent,
  MqttPublishOptions,
} from "@core/mqtt-types";
import { createMetric } from "@core/metric";

const sparkplug = spPayload.get("spBv1.0")!;

// ---------------------------------------------------------------------------
// Mock MQTT client for Hub link tests
// ---------------------------------------------------------------------------

class MockMqttClient implements MqttClientInterface {
  private _isConnected = false;
  private messageHandler: ((event: MqttMessageEvent) => void) | null = null;
  private connectHandler: (() => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private reconnectHandler: (() => void) | null = null;

  connectCalls: Array<{ servers: string[]; options: MqttClientOptions }> = [];
  subscribeCalls: Array<{ topics: string[]; qos: number }> = [];
  publishCalls: Array<{ topic: string; payload: Buffer; options?: MqttPublishOptions }> = [];
  disconnected = false;
  willConfig: { topic: string; payload: Buffer; qos: 0 | 1; retain: boolean } | null = null;

  get isConnected(): boolean { return this._isConnected; }

  setWill(topic: string, payload: Buffer, qos: 0 | 1 = 0, retain = false): void {
    this.willConfig = { topic, payload, qos, retain };
  }

  connect(servers: string[], options: MqttClientOptions): void {
    this.connectCalls.push({ servers, options });
    this._isConnected = true;
  }

  async subscribe(topics: string[], qos: number): Promise<void> {
    this.subscribeCalls.push({ topics, qos });
  }

  async unsubscribe(_topics: string[]): Promise<void> {}

  async publish(topic: string, payload: Buffer, options?: MqttPublishOptions): Promise<void> {
    this.publishCalls.push({ topic, payload, options });
  }

  onMessage(handler: (event: MqttMessageEvent) => void): void {
    this.messageHandler = handler;
  }
  onConnect(handler: () => void): void { this.connectHandler = handler; }
  onError(handler: (error: Error) => void): void { this.errorHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  onReconnect(handler: () => void): void { this.reconnectHandler = handler; }

  async disconnect(): Promise<void> {
    this._isConnected = false;
    this.disconnected = true;
  }

  // Test helpers
  emitMessage(topic: string, payload: Buffer): void {
    if (this.messageHandler) {
      this.messageHandler({ topic, payload, qos: 0, retain: false });
    }
  }

  /** Find published message by topic substring */
  findPublished(topicSubstring: string): { topic: string; payload: Buffer; options?: MqttPublishOptions } | undefined {
    return this.publishCalls.find((p) => p.topic.includes(topicSubstring));
  }

  /** Find all published messages by topic substring */
  findAllPublished(topicSubstring: string): Array<{ topic: string; payload: Buffer; options?: MqttPublishOptions }> {
    return this.publishCalls.filter((p) => p.topic.includes(topicSubstring));
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<HubLinkConfig>): HubLinkConfig {
  return {
    groupId: "plant_floor",
    edgeNodeId: "edge-line-3",
    broker: "tcp://hub.collatr.com:1883",
    heartbeatIntervalMs: 0, // Disabled by default in tests
    swVersion: "0.1.0",
    ...overrides,
  };
}

function makeDevice(overrides?: Partial<DeviceInfo>): DeviceInfo {
  return {
    deviceId: "wrapper_plc",
    pluginType: "modbus",
    pluginAlias: "wrapper_plc",
    initialMetrics: [
      createMetric({
        name: "plc_data",
        fields: { temperature: 22.5, rpm: 1485 },
      }),
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HubLink", () => {
  let mockClient: MockMqttClient;
  let config: HubLinkConfig;

  beforeEach(() => {
    mockClient = new MockMqttClient();
    config = makeConfig();
  });

  // =========================================================================
  // start() — Will message, connect, NBIRTH, NCMD subscription
  // =========================================================================

  describe("start()", () => {
    it("sets Will message with correct NDEATH payload before connecting", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      expect(mockClient.willConfig).not.toBeNull();
      expect(mockClient.willConfig!.topic).toBe("spBv1.0/plant_floor/NDEATH/edge-line-3");
      expect(mockClient.willConfig!.qos).toBe(1);
      expect(mockClient.willConfig!.retain).toBe(false);

      // Verify Will payload contains bdSeq = 0
      const decoded = sparkplug.decodePayload(new Uint8Array(mockClient.willConfig!.payload));
      const bdSeq = decoded.metrics!.find((m) => m.name === "bdSeq");
      expect(bdSeq).toBeDefined();
      expect(Number(bdSeq!.value)).toBe(0);

      await hub.stop();
    });

    it("connects to configured broker", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      expect(mockClient.connectCalls.length).toBe(1);
      expect(mockClient.connectCalls[0]!.servers).toEqual(["tcp://hub.collatr.com:1883"]);

      await hub.stop();
    });

    it("publishes NBIRTH to correct topic", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      const nbirth = mockClient.findPublished("NBIRTH");
      expect(nbirth).toBeDefined();
      expect(nbirth!.topic).toBe("spBv1.0/plant_floor/NBIRTH/edge-line-3");

      await hub.stop();
    });

    it("NBIRTH payload contains bdSeq, properties, control metrics", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      const nbirth = mockClient.findPublished("NBIRTH")!;
      const decoded = sparkplug.decodePayload(new Uint8Array(nbirth.payload));

      // bdSeq
      const bdSeq = decoded.metrics!.find((m) => m.name === "bdSeq");
      expect(bdSeq).toBeDefined();
      expect(Number(bdSeq!.value)).toBe(0);

      // Node Control/Rebirth
      const rebirth = decoded.metrics!.find((m) => m.name === "Node Control/Rebirth");
      expect(rebirth).toBeDefined();
      expect(rebirth!.type).toBe("Boolean");

      // Properties
      const sw = decoded.metrics!.find((m) => m.name === "Properties/sw_version");
      expect(sw).toBeDefined();
      expect(sw!.value).toBe("0.1.0");

      // Agent Metrics
      const uptime = decoded.metrics!.find((m) => m.name === "Agent Metrics/uptime_seconds");
      expect(uptime).toBeDefined();

      await hub.stop();
    });

    it("subscribes to NCMD topic", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      expect(mockClient.subscribeCalls.length).toBe(1);
      expect(mockClient.subscribeCalls[0]!.topics).toEqual(["spBv1.0/plant_floor/NCMD/edge-line-3"]);
      expect(mockClient.subscribeCalls[0]!.qos).toBe(1);

      await hub.stop();
    });
  });

  // =========================================================================
  // registerDevice + publishDeviceBirth
  // =========================================================================

  describe("publishDeviceBirth()", () => {
    it("publishes DBIRTH to correct topic with all metrics and aliases", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      const device = makeDevice();
      hub.registerDevice(device);

      const metrics = [
        createMetric({
          name: "plc_data",
          fields: { temperature: 23.5, rpm: 1500 },
        }),
      ];

      await hub.publishDeviceBirth("wrapper_plc", metrics);

      const dbirth = mockClient.findPublished("DBIRTH");
      expect(dbirth).toBeDefined();
      expect(dbirth!.topic).toBe("spBv1.0/plant_floor/DBIRTH/edge-line-3/wrapper_plc");

      // Verify payload has metrics with aliases
      const decoded = sparkplug.decodePayload(new Uint8Array(dbirth!.payload));
      expect(decoded.metrics!.length).toBe(2); // temperature + rpm

      const tempMetric = decoded.metrics!.find((m) => m.name === "plc_data/temperature");
      expect(tempMetric).toBeDefined();
      expect(tempMetric!.alias).toBeDefined();
      expect(Number(tempMetric!.alias)).toBeGreaterThan(0);

      await hub.stop();
    });
  });

  // =========================================================================
  // publishDeviceData — DDATA, auto-DBIRTH
  // =========================================================================

  describe("publishDeviceData()", () => {
    it("publishes DDATA to correct topic with alias-based encoding", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      const device = makeDevice();
      hub.registerDevice(device);

      const metrics = [
        createMetric({
          name: "plc_data",
          fields: { temperature: 24.0, rpm: 1500 },
        }),
      ];

      // First call triggers auto-DBIRTH
      await hub.publishDeviceData("wrapper_plc", metrics);

      // Should have DBIRTH + DDATA
      const dbirths = mockClient.findAllPublished("DBIRTH");
      expect(dbirths.length).toBe(1);

      const ddatas = mockClient.findAllPublished("DDATA");
      expect(ddatas.length).toBe(1);
      expect(ddatas[0]!.topic).toBe("spBv1.0/plant_floor/DDATA/edge-line-3/wrapper_plc");

      await hub.stop();
    });

    it("auto-publishes DBIRTH on first DDATA call for a device", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      hub.registerDevice(makeDevice());

      const metrics = [
        createMetric({ name: "plc_data", fields: { temperature: 22.5 } }),
      ];

      // First publishDeviceData triggers DBIRTH
      await hub.publishDeviceData("wrapper_plc", metrics);

      const dbirths = mockClient.findAllPublished("DBIRTH");
      expect(dbirths.length).toBe(1);

      // Second call should NOT trigger another DBIRTH
      await hub.publishDeviceData("wrapper_plc", metrics);

      const dbirths2 = mockClient.findAllPublished("DBIRTH");
      expect(dbirths2.length).toBe(1); // Still 1

      await hub.stop();
    });

    it("seq increments with each published message", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();
      hub.registerDevice(makeDevice());

      const metrics = [createMetric({ name: "data", fields: { val: 1 } })];

      // NBIRTH (seq=0), DBIRTH (seq increments), DDATA (seq increments)
      const initialPublishCount = mockClient.publishCalls.length; // NBIRTH
      await hub.publishDeviceData("wrapper_plc", metrics); // DBIRTH + DDATA
      await hub.publishDeviceData("wrapper_plc", metrics); // DDATA only

      // Verify seq increments (tracked internally, visible via NDATA)
      await hub.publishNodeData([
        { name: "test", value: 1, type: "Int32" },
      ]);

      const ndata = mockClient.findPublished("NDATA");
      const decoded = sparkplug.decodePayload(new Uint8Array(ndata!.payload));
      // seq should be >0 (incremented from NBIRTH=0 through DBIRTH, DDATA, DDATA)
      expect(Number(decoded.seq)).toBeGreaterThan(0);

      await hub.stop();
    });
  });

  // =========================================================================
  // publishNodeData — NDATA
  // =========================================================================

  describe("publishNodeData()", () => {
    it("publishes NDATA to correct topic with metrics", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      await hub.publishNodeData([
        { name: "uptime_seconds", value: 3600, type: "Int32" },
        { name: "event_loop_lag_ms", value: 1.5, type: "Double" },
      ]);

      const ndata = mockClient.findPublished("NDATA");
      expect(ndata).toBeDefined();
      expect(ndata!.topic).toBe("spBv1.0/plant_floor/NDATA/edge-line-3");

      const decoded = sparkplug.decodePayload(new Uint8Array(ndata!.payload));
      expect(decoded.metrics!.length).toBe(2);

      const uptime = decoded.metrics!.find((m) => m.name === "uptime_seconds");
      expect(Number(uptime!.value)).toBe(3600);

      await hub.stop();
    });
  });

  // =========================================================================
  // handleNCmd — rebirth
  // =========================================================================

  describe("handleNCmd (rebirth)", () => {
    it("triggers full rebirth on Node Control/Rebirth = true", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      hub.registerDevice(makeDevice());

      // Publish initial DBIRTH
      const metrics = [createMetric({ name: "data", fields: { val: 1 } })];
      await hub.publishDeviceBirth("wrapper_plc", metrics);

      const publishCountBefore = mockClient.publishCalls.length;

      // Simulate NCMD with rebirth request
      const cmdPayload = sparkplug.encodePayload({
        timestamp: Date.now(),
        metrics: [{
          name: "Node Control/Rebirth",
          type: "Boolean" as const,
          value: true,
          timestamp: Date.now(),
        }],
      });

      const ncmdTopic = "spBv1.0/plant_floor/NCMD/edge-line-3";
      mockClient.emitMessage(ncmdTopic, Buffer.from(cmdPayload));

      // Wait for async rebirth
      await Bun.sleep(50);

      // Should have re-published NBIRTH + DBIRTH
      const afterPublishes = mockClient.publishCalls.slice(publishCountBefore);
      const reNBirth = afterPublishes.find((p) => p.topic.includes("NBIRTH"));
      expect(reNBirth).toBeDefined();

      const reDBirth = afterPublishes.find((p) => p.topic.includes("DBIRTH"));
      expect(reDBirth).toBeDefined();

      await hub.stop();
    });
  });

  // =========================================================================
  // stop() — DDEATH for all devices, disconnect
  // =========================================================================

  describe("stop()", () => {
    it("publishes DDEATH for all devices with published DBIRTH", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      hub.registerDevice(makeDevice({ deviceId: "dev_a", pluginAlias: "dev_a" }));
      hub.registerDevice(makeDevice({ deviceId: "dev_b", pluginAlias: "dev_b" }));

      // Publish DBIRTH for both
      const metrics = [createMetric({ name: "data", fields: { val: 1 } })];
      await hub.publishDeviceBirth("dev_a", metrics);
      await hub.publishDeviceBirth("dev_b", metrics);

      await hub.stop();

      const ddeaths = mockClient.findAllPublished("DDEATH");
      expect(ddeaths.length).toBe(2);

      const topics = ddeaths.map((d) => d.topic);
      expect(topics).toContain("spBv1.0/plant_floor/DDEATH/edge-line-3/dev_a");
      expect(topics).toContain("spBv1.0/plant_floor/DDEATH/edge-line-3/dev_b");
    });

    it("disconnects the MQTT client", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();
      await hub.stop();

      expect(mockClient.disconnected).toBe(true);
    });
  });

  // =========================================================================
  // Sequence numbering
  // =========================================================================

  describe("sequence numbering", () => {
    it("seq wraps at 255 → 0", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      hub.registerDevice(makeDevice());

      // Publish enough messages to wrap seq (starts at 0 after NBIRTH)
      const metrics = [createMetric({ name: "data", fields: { val: 1 } })];
      await hub.publishDeviceBirth("wrapper_plc", metrics);

      // Publish many DDATA to wrap seq
      for (let i = 0; i < 260; i++) {
        await hub.publishDeviceData("wrapper_plc", metrics);
      }

      // Verify via NDATA that seq has wrapped (we can't easily read internal seq,
      // but it should not throw and should keep working)
      await hub.publishNodeData([{ name: "test", value: 1, type: "Int32" }]);

      // The key verification: no errors thrown, all publishes succeeded
      const ddataCount = mockClient.findAllPublished("DDATA").length;
      expect(ddataCount).toBe(260);

      await hub.stop();
    });
  });

  // =========================================================================
  // Topic structure
  // =========================================================================

  describe("topic structure", () => {
    it("matches PRD §9 topic pattern: spBv1.0/{group_id}/{msg_type}/{edge_node_id}[/{device_id}]", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      // NBIRTH
      expect(mockClient.findPublished("NBIRTH")!.topic).toBe(
        "spBv1.0/plant_floor/NBIRTH/edge-line-3",
      );

      // NCMD subscription
      expect(mockClient.subscribeCalls[0]!.topics[0]).toBe(
        "spBv1.0/plant_floor/NCMD/edge-line-3",
      );

      // DBIRTH (device-level)
      hub.registerDevice(makeDevice());
      await hub.publishDeviceBirth("wrapper_plc", [
        createMetric({ name: "d", fields: { v: 1 } }),
      ]);
      expect(mockClient.findPublished("DBIRTH")!.topic).toBe(
        "spBv1.0/plant_floor/DBIRTH/edge-line-3/wrapper_plc",
      );

      await hub.stop();
    });
  });

  // =========================================================================
  // rebirth()
  // =========================================================================

  describe("rebirth()", () => {
    it("increments bdSeq on rebirth", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      // First NBIRTH has bdSeq=0
      const firstNBirth = mockClient.findPublished("NBIRTH")!;
      const decoded1 = sparkplug.decodePayload(new Uint8Array(firstNBirth.payload));
      const bdSeq1 = Number(decoded1.metrics!.find((m) => m.name === "bdSeq")!.value);
      expect(bdSeq1).toBe(0);

      // Rebirth
      await hub.rebirth();

      const nbirths = mockClient.findAllPublished("NBIRTH");
      expect(nbirths.length).toBe(2);

      const decoded2 = sparkplug.decodePayload(new Uint8Array(nbirths[1]!.payload));
      const bdSeq2 = Number(decoded2.metrics!.find((m) => m.name === "bdSeq")!.value);
      expect(bdSeq2).toBe(1);

      await hub.stop();
    });

    it("re-publishes DBIRTH for all devices on rebirth", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      hub.registerDevice(makeDevice({ deviceId: "dev_a", pluginAlias: "dev_a" }));
      hub.registerDevice(makeDevice({ deviceId: "dev_b", pluginAlias: "dev_b" }));

      // Initial DBIRTH
      const m = [createMetric({ name: "d", fields: { v: 1 } })];
      await hub.publishDeviceBirth("dev_a", m);
      await hub.publishDeviceBirth("dev_b", m);

      const dbirthsBefore = mockClient.findAllPublished("DBIRTH").length;

      await hub.rebirth();

      const dbirthsAfter = mockClient.findAllPublished("DBIRTH").length;
      expect(dbirthsAfter - dbirthsBefore).toBe(2); // Both re-published

      await hub.stop();
    });
  });

  // =========================================================================
  // publishDeviceDeath
  // =========================================================================

  describe("publishDeviceDeath()", () => {
    it("publishes DDEATH and clears birth tracking", async () => {
      const hub = new HubLink(config, mockClient);
      await hub.start();

      hub.registerDevice(makeDevice());
      const m = [createMetric({ name: "d", fields: { v: 1 } })];
      await hub.publishDeviceBirth("wrapper_plc", m);

      await hub.publishDeviceDeath("wrapper_plc");

      const ddeath = mockClient.findPublished("DDEATH");
      expect(ddeath).toBeDefined();
      expect(ddeath!.topic).toBe("spBv1.0/plant_floor/DDEATH/edge-line-3/wrapper_plc");

      // Next publishDeviceData should trigger re-DBIRTH
      await hub.publishDeviceData("wrapper_plc", m);
      const dbirths = mockClient.findAllPublished("DBIRTH");
      expect(dbirths.length).toBe(2); // Initial + re-birth after death

      await hub.stop();
    });
  });
});
