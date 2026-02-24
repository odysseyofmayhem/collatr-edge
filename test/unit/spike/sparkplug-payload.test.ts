import { describe, it, expect } from "bun:test";
import spPayload from "sparkplug-payload";
import Long from "long";

const sparkplug = spPayload.get("spBv1.0")!;

describe("sparkplug-payload spike — Bun compatibility", () => {
  it("should load the spBv1.0 namespace", () => {
    expect(sparkplug).not.toBeNull();
    expect(typeof sparkplug.encodePayload).toBe("function");
    expect(typeof sparkplug.decodePayload).toBe("function");
  });

  describe("NBIRTH payload with multiple metric types", () => {
    it("encodes and decodes Int32, Double, Boolean metrics", () => {
      const payload = {
        timestamp: Date.now(),
        metrics: [
          {
            name: "bdSeq",
            type: "Int64" as const,
            value: 0,
            timestamp: Date.now(),
          },
          {
            name: "Agent Metrics/uptime_seconds",
            type: "Int32" as const,
            value: 0,
            timestamp: Date.now(),
          },
          {
            name: "Agent Metrics/event_loop_lag_ms",
            type: "Double" as const,
            value: 0.5,
            timestamp: Date.now(),
          },
          {
            name: "Node Control/Rebirth",
            type: "Boolean" as const,
            value: false,
            timestamp: Date.now(),
          },
        ],
      };

      const encoded = sparkplug.encodePayload(payload);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);

      const decoded = sparkplug.decodePayload(encoded);
      expect(decoded.metrics).toHaveLength(4);

      // Verify bdSeq
      const bdSeqMetric = decoded.metrics!.find(
        (m) => m.name === "bdSeq"
      );
      expect(bdSeqMetric).toBeDefined();

      // Verify Int32 metric
      const uptimeMetric = decoded.metrics!.find(
        (m) => m.name === "Agent Metrics/uptime_seconds"
      );
      expect(uptimeMetric).toBeDefined();
      expect(uptimeMetric!.type).toBe("Int32");
      expect(Number(uptimeMetric!.value)).toBe(0);

      // Verify Double metric
      const lagMetric = decoded.metrics!.find(
        (m) => m.name === "Agent Metrics/event_loop_lag_ms"
      );
      expect(lagMetric).toBeDefined();
      expect(lagMetric!.type).toBe("Double");
      expect(lagMetric!.value).toBe(0.5);

      // Verify Boolean metric
      const rebirthMetric = decoded.metrics!.find(
        (m) => m.name === "Node Control/Rebirth"
      );
      expect(rebirthMetric).toBeDefined();
      expect(rebirthMetric!.type).toBe("Boolean");
      expect(rebirthMetric!.value).toBe(false);
    });
  });

  describe("DDATA payload with metric aliases", () => {
    it("encodes and decodes alias-based metrics", () => {
      const payload = {
        timestamp: Date.now(),
        seq: 5,
        metrics: [
          {
            alias: 12345,
            type: "Int32" as const,
            value: 42,
            timestamp: Date.now(),
          },
          {
            alias: 67890,
            type: "Double" as const,
            value: 98.6,
            timestamp: Date.now(),
          },
        ],
      };

      const encoded = sparkplug.encodePayload(payload);
      const decoded = sparkplug.decodePayload(encoded);

      expect(decoded.metrics).toHaveLength(2);

      // Alias-based metrics — no name, just alias + value
      const m0 = decoded.metrics![0];
      expect(Number(m0.alias)).toBe(12345);
      expect(m0.type).toBe("Int32");
      expect(Number(m0.value)).toBe(42);

      const m1 = decoded.metrics![1];
      expect(Number(m1.alias)).toBe(67890);
      expect(m1.type).toBe("Double");
      expect(m1.value).toBe(98.6);
    });
  });

  describe("NDEATH payload with bdSeq", () => {
    it("encodes and decodes bdSeq in NDEATH", () => {
      const payload = {
        timestamp: Date.now(),
        metrics: [
          {
            name: "bdSeq",
            type: "Int64" as const,
            value: 7,
            timestamp: Date.now(),
          },
        ],
      };

      const encoded = sparkplug.encodePayload(payload);
      const decoded = sparkplug.decodePayload(encoded);

      expect(decoded.metrics).toHaveLength(1);
      const bdSeq = decoded.metrics![0];
      expect(bdSeq.name).toBe("bdSeq");
      expect(Number(bdSeq.value)).toBe(7);
    });
  });

  describe("timestamp preservation", () => {
    it("preserves 64-bit millisecond timestamps", () => {
      const now = Date.now();
      const nowLong = Long.fromNumber(now, true); // unsigned
      const payload = {
        timestamp: nowLong.toNumber(),
        metrics: [
          {
            name: "test",
            type: "Int32" as const,
            value: 1,
            timestamp: nowLong.toNumber(),
          },
        ],
      };

      const encoded = sparkplug.encodePayload(payload);
      const decoded = sparkplug.decodePayload(encoded);

      // Timestamp comes back as Long from protobufjs
      const decodedTs = decoded.timestamp;
      expect(Long.fromValue(decodedTs as Long).toNumber()).toBe(now);

      const metricTs = decoded.metrics![0].timestamp;
      expect(Long.fromValue(metricTs as Long).toNumber()).toBe(now);
    });
  });

  describe("String metric type", () => {
    it("encodes and decodes String values", () => {
      const payload = {
        timestamp: Date.now(),
        metrics: [
          {
            name: "Properties/sw_version",
            type: "String" as const,
            value: "0.1.0",
            timestamp: Date.now(),
          },
        ],
      };

      const encoded = sparkplug.encodePayload(payload);
      const decoded = sparkplug.decodePayload(encoded);

      expect(decoded.metrics![0].value).toBe("0.1.0");
      expect(decoded.metrics![0].type).toBe("String");
    });
  });

  describe("metric properties", () => {
    it("encodes and decodes metric properties", () => {
      const payload = {
        timestamp: Date.now(),
        metrics: [
          {
            name: "temperature",
            type: "Double" as const,
            value: 22.5,
            alias: 100,
            timestamp: Date.now(),
            properties: {
              plugin_type: {
                type: "String" as const,
                value: "modbus",
              },
            },
          },
        ],
      };

      const encoded = sparkplug.encodePayload(payload);
      const decoded = sparkplug.decodePayload(encoded);

      const metric = decoded.metrics![0];
      expect(metric.name).toBe("temperature");
      expect(metric.properties).toBeDefined();
      expect(metric.properties!.plugin_type.value).toBe("modbus");
    });
  });
});
