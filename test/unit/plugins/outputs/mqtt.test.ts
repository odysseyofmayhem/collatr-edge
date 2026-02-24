// Unit tests: MQTT output plugin
// PRD refs: §9 Hub Link & Control Plane, §19 MVP Plugin Inventory

import { describe, it, expect, beforeEach } from "bun:test";
import {
  MqttOutput,
  MqttOutputConfigSchema,
  type MqttOutputConfig,
} from "@plugins/outputs/mqtt";
import type {
  MqttClientInterface,
  MqttClientOptions,
  MqttMessageEvent,
  MqttPublishOptions,
} from "@core/mqtt-types";
import { createMetric } from "@core/metric";

// ---------------------------------------------------------------------------
// Mock Hub link
// ---------------------------------------------------------------------------

class MockHubLink {
  publishCalls: Array<{ deviceId: string; metrics: unknown[] }> = [];

  async publishDeviceData(deviceId: string, metrics: unknown[]): Promise<void> {
    this.publishCalls.push({ deviceId, metrics });
  }
}

// ---------------------------------------------------------------------------
// Mock MQTT client
// ---------------------------------------------------------------------------

class MockMqttClient implements MqttClientInterface {
  private _isConnected = false;
  connectCalls: Array<{ servers: string[]; options: MqttClientOptions }> = [];
  publishCalls: Array<{ topic: string; payload: Buffer; options?: MqttPublishOptions }> = [];
  disconnected = false;

  get isConnected(): boolean { return this._isConnected; }

  setWill(): void {}
  connect(servers: string[], options: MqttClientOptions): void {
    this.connectCalls.push({ servers, options });
    this._isConnected = true;
  }
  async subscribe(): Promise<void> {}
  async unsubscribe(): Promise<void> {}
  async publish(topic: string, payload: Buffer, options?: MqttPublishOptions): Promise<void> {
    this.publishCalls.push({ topic, payload, options });
  }
  onMessage(): void {}
  onConnect(): void {}
  onError(): void {}
  onClose(): void {}
  onReconnect(): void {}
  async disconnect(): Promise<void> {
    this._isConnected = false;
    this.disconnected = true;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MQTT Output Plugin", () => {
  describe("config validation", () => {
    it("accepts minimal sparkplug config", () => {
      const config = MqttOutputConfigSchema.parse({ sparkplug: true });
      expect(config.sparkplug).toBe(true);
      expect(config.qos).toBe(1);
    });

    it("accepts minimal plain config with servers", () => {
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://broker:1883"],
      });
      expect(config.sparkplug).toBe(false);
      expect(config.data_format).toBe("json");
      expect(config.topic).toBe("collatr/${name}");
    });

    it("validates QoS range", () => {
      expect(() => MqttOutputConfigSchema.parse({
        servers: ["tcp://broker:1883"],
        qos: 2,
      })).toThrow();
    });

    it("applies defaults", () => {
      const config = MqttOutputConfigSchema.parse({});
      expect(config.sparkplug).toBe(false);
      expect(config.qos).toBe(1);
      expect(config.retain).toBe(false);
      expect(config.data_format).toBe("json");
    });
  });

  describe("Sparkplug mode", () => {
    let mockHubLink: MockHubLink;

    beforeEach(() => {
      mockHubLink = new MockHubLink();
    });

    it("routes metrics to hub link by _device_id tag", async () => {
      const config = MqttOutputConfigSchema.parse({ sparkplug: true });
      // Cast mock as HubLink (it has the methods we need)
      const output = new MqttOutput(config, mockHubLink as never);

      await output.connect();

      const metrics = [
        createMetric({
          name: "temperature",
          fields: { value: 22.5 },
          tags: { _device_id: "plc_a" },
        }),
        createMetric({
          name: "pressure",
          fields: { value: 101.3 },
          tags: { _device_id: "plc_a" },
        }),
        createMetric({
          name: "humidity",
          fields: { value: 65 },
          tags: { _device_id: "plc_b" },
        }),
      ];

      await output.write(metrics);

      // Should have 2 publish calls: one for plc_a, one for plc_b
      expect(mockHubLink.publishCalls.length).toBe(2);

      const plcA = mockHubLink.publishCalls.find((c) => c.deviceId === "plc_a");
      expect(plcA).toBeDefined();
      expect(plcA!.metrics.length).toBe(2);

      const plcB = mockHubLink.publishCalls.find((c) => c.deviceId === "plc_b");
      expect(plcB).toBeDefined();
      expect(plcB!.metrics.length).toBe(1);

      await output.close();
    });

    it("strips _device_id tag before publishing", async () => {
      const config = MqttOutputConfigSchema.parse({ sparkplug: true });
      const output = new MqttOutput(config, mockHubLink as never);

      await output.connect();

      const metric = createMetric({
        name: "temperature",
        fields: { value: 22.5 },
        tags: { _device_id: "plc_a", location: "factory" },
      });

      await output.write([metric]);

      // The metric should no longer have _device_id tag
      expect(metric.hasTag("_device_id")).toBe(false);
      expect(metric.hasTag("location")).toBe(true);

      await output.close();
    });

    it("does not disconnect hub link's client on close", async () => {
      const config = MqttOutputConfigSchema.parse({ sparkplug: true });
      const output = new MqttOutput(config, mockHubLink as never);

      await output.connect();
      await output.close();
      // No error — didn't try to disconnect anything
    });
  });

  describe("Plain MQTT mode", () => {
    let mockClient: MockMqttClient;

    beforeEach(() => {
      mockClient = new MockMqttClient();
    });

    it("connects to configured servers", async () => {
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://broker:1883"],
        client_id: "test-client",
      });
      const output = new MqttOutput(config, undefined, mockClient);

      await output.connect();

      expect(mockClient.connectCalls.length).toBe(1);
      expect(mockClient.connectCalls[0]!.servers).toEqual(["tcp://broker:1883"]);
      expect(mockClient.connectCalls[0]!.options.clientId).toBe("test-client");

      await output.close();
    });

    it("publishes JSON to topic with ${name} substitution", async () => {
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://broker:1883"],
        topic: "collatr/${name}",
        qos: 0,
      });
      const output = new MqttOutput(config, undefined, mockClient);

      await output.connect();

      const metrics = [
        createMetric({
          name: "temperature",
          fields: { value: 22.5 },
        }),
      ];

      await output.write(metrics);

      expect(mockClient.publishCalls.length).toBe(1);
      expect(mockClient.publishCalls[0]!.topic).toBe("collatr/temperature");
      expect(mockClient.publishCalls[0]!.options?.qos).toBe(0);

      // Verify payload is valid JSON
      const payload = mockClient.publishCalls[0]!.payload.toString();
      const parsed = JSON.parse(payload);
      expect(parsed.name).toBe("temperature");

      await output.close();
    });

    it("publishes with configured QoS and retain", async () => {
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://broker:1883"],
        qos: 1,
        retain: true,
      });
      const output = new MqttOutput(config, undefined, mockClient);

      await output.connect();
      await output.write([
        createMetric({ name: "test", fields: { v: 1 } }),
      ]);

      expect(mockClient.publishCalls[0]!.options?.qos).toBe(1);
      expect(mockClient.publishCalls[0]!.options?.retain).toBe(true);

      await output.close();
    });

    it("disconnects own client on close()", async () => {
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://broker:1883"],
      });
      const output = new MqttOutput(config, undefined, mockClient);

      await output.connect();
      await output.close();

      expect(mockClient.disconnected).toBe(true);
    });

    it("throws if no servers configured in plain mode", async () => {
      const config = MqttOutputConfigSchema.parse({});
      const output = new MqttOutput(config);

      await expect(output.connect()).rejects.toThrow("requires 'servers'");
    });
  });
});
