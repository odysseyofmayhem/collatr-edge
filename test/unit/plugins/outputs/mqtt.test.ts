// Unit tests: MQTT output plugin
// PRD refs: §9 Hub Link & Control Plane, §10 Network Policy, §19 MVP Plugin Inventory

import { describe, it, expect, beforeEach } from "bun:test";
import {
  MqttOutput,
  MqttOutputConfigSchema,
  parseMqttServerUrl,
  type MqttOutputConfig,
} from "@plugins/outputs/mqtt";
import { createMetric } from "@core/metric";
import { MockMqttClient } from "../../../helpers/mock-mqtt-client.ts";
import {
  resolveNetworkPolicy,
  PolicyViolationError,
} from "@core/network-policy";

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

    it("strips _device_id tag on copy without mutating original", async () => {
      const config = MqttOutputConfigSchema.parse({ sparkplug: true });
      const output = new MqttOutput(config, mockHubLink as never);

      await output.connect();

      const metric = createMetric({
        name: "temperature",
        fields: { value: 22.5 },
        tags: { _device_id: "plc_a", location: "factory" },
      });

      await output.write([metric]);

      // Original metric must NOT be mutated (other outputs may share it)
      expect(metric.hasTag("_device_id")).toBe(true);
      expect(metric.hasTag("location")).toBe(true);

      // The metrics published to hub link should not have _device_id
      const published = mockHubLink.publishCalls[0]!;
      const publishedMetric = published.metrics[0] as ReturnType<typeof createMetric>;
      expect(publishedMetric.hasTag("_device_id")).toBe(false);
      expect(publishedMetric.hasTag("location")).toBe(true);

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

  // -------------------------------------------------------------------------
  // Network policy enforcement (PRD §10/§16)
  // -------------------------------------------------------------------------

  describe("Network policy enforcement", () => {
    let mockClient: MockMqttClient;

    beforeEach(() => {
      mockClient = new MockMqttClient();
    });

    it("plain mode with servers = [] → connect() throws (missing servers)", async () => {
      const config = MqttOutputConfigSchema.parse({
        servers: [],
      });
      const output = new MqttOutput(config, undefined, mockClient);

      await expect(output.connect()).rejects.toThrow("requires 'servers' config");
    });

    it("plain mode with standalone policy → connect() throws PolicyViolationError", async () => {
      const policy = resolveNetworkPolicy({ mode: "standalone" });
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://192.168.1.10:1883"],
      });
      const output = new MqttOutput(config, undefined, mockClient, policy);

      await expect(output.connect()).rejects.toThrow(PolicyViolationError);
    });

    it("plain mode with local_network + server not in allowedHosts → throws", async () => {
      const policy = resolveNetworkPolicy({
        mode: "local_network",
        egress: { allowed_hosts: ["192.168.1.50:8086"] },
      });
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://10.0.0.5:1883"],
      });
      const output = new MqttOutput(config, undefined, mockClient, policy);

      await expect(output.connect()).rejects.toThrow(PolicyViolationError);
    });

    it("plain mode with local_network + server in allowedHosts → does not throw", async () => {
      const policy = resolveNetworkPolicy({
        mode: "local_network",
        egress: { allowed_hosts: ["192.168.1.10:1883"] },
      });
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://192.168.1.10:1883"],
      });
      const output = new MqttOutput(config, undefined, mockClient, policy);

      // Should not throw — proceeds to connect
      await output.connect();
      expect(mockClient.connectCalls.length).toBe(1);
      await output.close();
    });

    it("plain mode with connected policy → does not throw", async () => {
      const policy = resolveNetworkPolicy({ mode: "connected" });
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://remote-broker.example.com:1883"],
      });
      const output = new MqttOutput(config, undefined, mockClient, policy);

      await output.connect();
      expect(mockClient.connectCalls.length).toBe(1);
      await output.close();
    });

    it("plain mode without networkPolicy (undefined) → no enforcement (backward compat)", async () => {
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://any-broker:1883"],
      });
      // No policy passed — backward compatible
      const output = new MqttOutput(config, undefined, mockClient);

      await output.connect();
      expect(mockClient.connectCalls.length).toBe(1);
      await output.close();
    });

    it("PolicyViolationError message includes target host, port, mode, and reason", async () => {
      const policy = resolveNetworkPolicy({ mode: "standalone" });
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://192.168.1.10:1883"],
      });
      const output = new MqttOutput(config, undefined, mockClient, policy);

      try {
        await output.connect();
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyViolationError);
        const pve = err as PolicyViolationError;
        expect(pve.message).toContain("192.168.1.10");
        expect(pve.message).toContain("1883");
        expect(pve.message).toContain("standalone");
        expect(pve.policyMode).toBe("standalone");
        expect(pve.target.host).toBe("192.168.1.10");
        expect(pve.target.port).toBe(1883);
      }
    });

    it("validates all servers — second server blocked", async () => {
      const policy = resolveNetworkPolicy({
        mode: "local_network",
        egress: { allowed_hosts: ["192.168.1.10:1883"] },
      });
      const config = MqttOutputConfigSchema.parse({
        servers: ["tcp://192.168.1.10:1883", "tcp://10.0.0.5:1883"],
      });
      const output = new MqttOutput(config, undefined, mockClient, policy);

      await expect(output.connect()).rejects.toThrow(PolicyViolationError);
    });

    it("local_network blocks hostname when allowDns=false", async () => {
      const policy = resolveNetworkPolicy({ mode: "local_network" });
      const config = MqttOutputConfigSchema.parse({
        servers: ["mqtt://broker.example.com:1883"],
      });
      const output = new MqttOutput(config, undefined, mockClient, policy);

      try {
        await output.connect();
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyViolationError);
        expect((err as PolicyViolationError).message).toContain("DNS");
      }
    });
  });

  // -------------------------------------------------------------------------
  // parseMqttServerUrl helper
  // -------------------------------------------------------------------------

  describe("parseMqttServerUrl", () => {
    it("parses tcp:// URL", () => {
      const target = parseMqttServerUrl("tcp://192.168.1.10:1883", "test");
      expect(target.host).toBe("192.168.1.10");
      expect(target.port).toBe(1883);
      expect(target.protocol).toBe("mqtt");
      expect(target.description).toBe("test");
    });

    it("parses mqtt:// URL", () => {
      const target = parseMqttServerUrl("mqtt://broker:1883", "test");
      expect(target.host).toBe("broker");
      expect(target.port).toBe(1883);
      expect(target.protocol).toBe("mqtt");
    });

    it("parses mqtts:// URL as mqtts protocol", () => {
      const target = parseMqttServerUrl("mqtts://secure-broker:8883", "test");
      expect(target.host).toBe("secure-broker");
      expect(target.port).toBe(8883);
      expect(target.protocol).toBe("mqtts");
    });

    it("parses ssl:// URL as mqtts protocol", () => {
      const target = parseMqttServerUrl("ssl://secure-broker:8883", "test");
      expect(target.host).toBe("secure-broker");
      expect(target.port).toBe(8883);
      expect(target.protocol).toBe("mqtts");
    });

    it("defaults to port 1883 for mqtt:// URL without explicit port", () => {
      const target = parseMqttServerUrl("mqtt://broker", "test");
      expect(target.host).toBe("broker");
      expect(target.port).toBe(1883);
      expect(target.protocol).toBe("mqtt");
    });

    it("defaults to port 8883 for mqtts:// URL without explicit port", () => {
      const target = parseMqttServerUrl("mqtts://secure-broker", "test");
      expect(target.host).toBe("secure-broker");
      expect(target.port).toBe(8883);
      expect(target.protocol).toBe("mqtts");
    });

    it("handles unparseable URL — returns raw string as host", () => {
      const target = parseMqttServerUrl("not-a-url", "test_desc");
      expect(target.host).toBe("not-a-url");
      expect(target.protocol).toBe("mqtt");
      expect(target.description).toBe("test_desc");
    });

    it("parses mqtt://[::1]:1883 (IPv6 bracket notation)", () => {
      const result = parseMqttServerUrl("mqtt://[::1]:1883", "test");
      expect(result.host).toBe("::1");
      expect(result.port).toBe(1883);
      expect(result.protocol).toBe("mqtt");
    });

    it("parses mqtts://[2001:db8::1]:8883 (IPv6 with explicit port)", () => {
      const result = parseMqttServerUrl("mqtts://[2001:db8::1]:8883", "test");
      expect(result.host).toBe("2001:db8::1");
      expect(result.port).toBe(8883);
      expect(result.protocol).toBe("mqtts");
    });
  });
});
