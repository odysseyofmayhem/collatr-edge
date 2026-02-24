// Unit tests: Sparkplug B codec
// PRD refs: §9 Hub Link & Control Plane, Appendix C

import { describe, it, expect } from "bun:test";
import spPayload from "sparkplug-payload";
import {
  fieldValueToSparkplugType,
  computeMetricAlias,
  resolveAliases,
  encodeNBirth,
  encodeNDeath,
  encodeDBirth,
  encodeDDeath,
  encodeDData,
  encodeNData,
  decodeNCmd,
} from "@core/../hub/sparkplug-codec";
import { createMetric } from "@core/metric";

const sparkplug = spPayload.get("spBv1.0")!;

// ---------------------------------------------------------------------------
// fieldValueToSparkplugType
// ---------------------------------------------------------------------------

describe("fieldValueToSparkplugType", () => {
  it("maps boolean → Boolean", () => {
    expect(fieldValueToSparkplugType(true)).toBe("Boolean");
    expect(fieldValueToSparkplugType(false)).toBe("Boolean");
  });

  it("maps string → String", () => {
    expect(fieldValueToSparkplugType("hello")).toBe("String");
    expect(fieldValueToSparkplugType("")).toBe("String");
  });

  it("maps bigint → Int64", () => {
    expect(fieldValueToSparkplugType(42n)).toBe("Int64");
    expect(fieldValueToSparkplugType(0n)).toBe("Int64");
    expect(fieldValueToSparkplugType(9007199254740992n)).toBe("Int64");
  });

  it("maps integer number within Int32 range → Int32", () => {
    expect(fieldValueToSparkplugType(0)).toBe("Int32");
    expect(fieldValueToSparkplugType(42)).toBe("Int32");
    expect(fieldValueToSparkplugType(-100)).toBe("Int32");
    expect(fieldValueToSparkplugType(2147483647)).toBe("Int32");
    expect(fieldValueToSparkplugType(-2147483648)).toBe("Int32");
  });

  it("maps integer number outside Int32 range → Int64", () => {
    expect(fieldValueToSparkplugType(2147483648)).toBe("Int64");
    expect(fieldValueToSparkplugType(-2147483649)).toBe("Int64");
    expect(fieldValueToSparkplugType(Number.MAX_SAFE_INTEGER)).toBe("Int64");
  });

  it("maps float number → Double", () => {
    expect(fieldValueToSparkplugType(3.14)).toBe("Double");
    expect(fieldValueToSparkplugType(0.5)).toBe("Double");
    expect(fieldValueToSparkplugType(-22.5)).toBe("Double");
  });
});

// ---------------------------------------------------------------------------
// computeMetricAlias and resolveAliases
// ---------------------------------------------------------------------------

describe("computeMetricAlias", () => {
  it("produces a deterministic alias for same input", () => {
    const a1 = computeMetricAlias("device_1", "temperature");
    const a2 = computeMetricAlias("device_1", "temperature");
    expect(a1).toBe(a2);
  });

  it("produces different aliases for different inputs", () => {
    const a1 = computeMetricAlias("device_1", "temperature");
    const a2 = computeMetricAlias("device_1", "humidity");
    expect(a1).not.toBe(a2);
  });

  it("produces different aliases for different devices", () => {
    const a1 = computeMetricAlias("device_1", "temperature");
    const a2 = computeMetricAlias("device_2", "temperature");
    expect(a1).not.toBe(a2);
  });

  it("alias is within 0..(2^31-1) range", () => {
    const alias = computeMetricAlias("some_device", "some_metric");
    expect(alias).toBeGreaterThanOrEqual(0);
    expect(alias).toBeLessThan(2147483648);
  });
});

describe("resolveAliases", () => {
  it("assigns unique aliases to all metric names", () => {
    const aliases = resolveAliases("device_1", [
      "temperature", "humidity", "pressure",
    ]);

    expect(aliases.size).toBe(3);

    const values = [...aliases.values()];
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(3);
  });

  it("is deterministic across calls", () => {
    const a1 = resolveAliases("device_1", ["temp", "humidity"]);
    const a2 = resolveAliases("device_1", ["temp", "humidity"]);

    expect(a1.get("temp")).toBe(a2.get("temp"));
    expect(a1.get("humidity")).toBe(a2.get("humidity"));
  });

  it("handles collision resolution by incrementing", () => {
    // We can't easily force a real collision, but we can verify
    // that the algorithm produces unique values for a large set
    const names = Array.from({ length: 100 }, (_, i) => `metric_${i}`);
    const aliases = resolveAliases("device_1", names);

    const values = [...aliases.values()];
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// encodeNBirth → decode round-trip
// ---------------------------------------------------------------------------

describe("encodeNBirth", () => {
  it("encodes NBIRTH with bdSeq, properties, control metrics, agent metrics", () => {
    const buf = encodeNBirth({
      bdSeq: 3,
      swVersion: "0.1.0",
      hwPlatform: "linux-arm64",
      hostname: "edge-line-3",
      pluginsLoaded: ["modbus", "mqtt_consumer", "internal"],
      agentMetrics: [
        { name: "uptime_seconds", type: "Int32", value: 0 },
        { name: "event_loop_lag_ms", type: "Double", value: 0.5 },
        { name: "buffer_total_length", type: "Int32", value: 0 },
      ],
    });

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);

    // Decode and verify
    const decoded = sparkplug.decodePayload(new Uint8Array(buf));
    expect(decoded.metrics).toBeDefined();

    const metrics = decoded.metrics!;

    // bdSeq present
    const bdSeq = metrics.find((m) => m.name === "bdSeq");
    expect(bdSeq).toBeDefined();
    expect(Number(bdSeq!.value)).toBe(3);

    // Node Control/Rebirth present
    const rebirth = metrics.find((m) => m.name === "Node Control/Rebirth");
    expect(rebirth).toBeDefined();
    expect(rebirth!.type).toBe("Boolean");
    expect(rebirth!.value).toBe(false);

    // Properties
    const swVersion = metrics.find((m) => m.name === "Properties/sw_version");
    expect(swVersion).toBeDefined();
    expect(swVersion!.value).toBe("0.1.0");

    const hwPlatform = metrics.find((m) => m.name === "Properties/hw_platform");
    expect(hwPlatform!.value).toBe("linux-arm64");

    const hostname = metrics.find((m) => m.name === "Properties/hostname");
    expect(hostname!.value).toBe("edge-line-3");

    const plugins = metrics.find((m) => m.name === "Properties/plugins_loaded");
    expect(plugins!.value).toBe("modbus,mqtt_consumer,internal");

    // Agent Metrics
    const uptime = metrics.find((m) => m.name === "Agent Metrics/uptime_seconds");
    expect(uptime).toBeDefined();
    expect(uptime!.type).toBe("Int32");
    expect(Number(uptime!.value)).toBe(0);

    const lag = metrics.find((m) => m.name === "Agent Metrics/event_loop_lag_ms");
    expect(lag!.type).toBe("Double");
    expect(lag!.value).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// encodeNDeath → decode round-trip
// ---------------------------------------------------------------------------

describe("encodeNDeath", () => {
  it("encodes NDEATH with bdSeq", () => {
    const buf = encodeNDeath(5);
    const decoded = sparkplug.decodePayload(new Uint8Array(buf));

    expect(decoded.metrics).toHaveLength(1);
    const bdSeq = decoded.metrics![0]!;
    expect(bdSeq.name).toBe("bdSeq");
    expect(Number(bdSeq.value)).toBe(5);
  });

  it("preserves bdSeq value 0", () => {
    const buf = encodeNDeath(0);
    const decoded = sparkplug.decodePayload(new Uint8Array(buf));
    expect(Number(decoded.metrics![0]!.value)).toBe(0);
  });

  it("preserves bdSeq value 255", () => {
    const buf = encodeNDeath(255);
    const decoded = sparkplug.decodePayload(new Uint8Array(buf));
    expect(Number(decoded.metrics![0]!.value)).toBe(255);
  });
});

// ---------------------------------------------------------------------------
// encodeDBirth → decode round-trip
// ---------------------------------------------------------------------------

describe("encodeDBirth", () => {
  it("encodes DBIRTH with full metric definitions, aliases, types, properties", () => {
    const metrics = [
      createMetric({
        name: "plc_data",
        fields: { temperature: 22.5, running: true, rpm: 1485 },
      }),
    ];

    const aliases = new Map<string, number>([
      ["plc_data/temperature", 100],
      ["plc_data/running", 101],
      ["plc_data/rpm", 102],
    ]);

    const buf = encodeDBirth({
      deviceId: "wrapper_plc",
      metrics,
      aliases,
      pluginType: "modbus",
      pluginAlias: "wrapper_plc",
      properties: { controller: "tcp://192.168.10.100:502" },
    });

    const decoded = sparkplug.decodePayload(new Uint8Array(buf));
    expect(decoded.metrics).toBeDefined();

    const spMetrics = decoded.metrics!;
    expect(spMetrics.length).toBe(3);

    // Check metric names and aliases
    const tempMetric = spMetrics.find((m) => m.name === "plc_data/temperature");
    expect(tempMetric).toBeDefined();
    expect(Number(tempMetric!.alias)).toBe(100);
    expect(tempMetric!.type).toBe("Double");
    expect(tempMetric!.value).toBe(22.5);

    const runningMetric = spMetrics.find((m) => m.name === "plc_data/running");
    expect(runningMetric).toBeDefined();
    expect(Number(runningMetric!.alias)).toBe(101);
    expect(runningMetric!.type).toBe("Boolean");

    const rpmMetric = spMetrics.find((m) => m.name === "plc_data/rpm");
    expect(rpmMetric).toBeDefined();
    expect(Number(rpmMetric!.alias)).toBe(102);
    expect(rpmMetric!.type).toBe("Int32");

    // Check properties on first metric
    expect(tempMetric!.properties).toBeDefined();
    expect(tempMetric!.properties!.plugin_type.value).toBe("modbus");
    expect(tempMetric!.properties!.plugin_alias.value).toBe("wrapper_plc");
    expect(tempMetric!.properties!.controller.value).toBe("tcp://192.168.10.100:502");
  });
});

// ---------------------------------------------------------------------------
// encodeDDeath
// ---------------------------------------------------------------------------

describe("encodeDDeath", () => {
  it("encodes DDEATH as empty payload", () => {
    const buf = encodeDDeath();
    const decoded = sparkplug.decodePayload(new Uint8Array(buf));
    expect(decoded.metrics?.length ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// encodeDData → decode round-trip
// ---------------------------------------------------------------------------

describe("encodeDData", () => {
  it("encodes DDATA with alias-based metrics (no names)", () => {
    const tsNs = BigInt(Date.now()) * 1_000_000n;
    const metrics = [
      createMetric({
        name: "plc_data",
        fields: { temperature: 23.5, rpm: 1500 },
        timestamp: tsNs,
      }),
    ];

    const aliases = new Map<string, number>([
      ["plc_data/temperature", 200],
      ["plc_data/rpm", 201],
    ]);

    const buf = encodeDData({ metrics, aliases });
    const decoded = sparkplug.decodePayload(new Uint8Array(buf));

    expect(decoded.metrics).toHaveLength(2);

    const m0 = decoded.metrics![0]!;
    expect(Number(m0.alias)).toBe(200);
    expect(m0.type).toBe("Double");
    expect(m0.value).toBe(23.5);

    const m1 = decoded.metrics![1]!;
    expect(Number(m1.alias)).toBe(201);
    expect(m1.type).toBe("Int32");
    expect(Number(m1.value)).toBe(1500);
  });

  it("preserves timestamps from metrics", () => {
    const tsMs = Date.now();
    const tsNs = BigInt(tsMs) * 1_000_000n;
    const metrics = [
      createMetric({
        name: "temp",
        fields: { value: 22.5 },
        timestamp: tsNs,
      }),
    ];
    const aliases = new Map([["temp/value", 300]]);

    const buf = encodeDData({ metrics, aliases });
    const decoded = sparkplug.decodePayload(new Uint8Array(buf));

    const metricTs = Number(decoded.metrics![0]!.timestamp!.toString());
    expect(metricTs).toBe(tsMs);
  });
});

// ---------------------------------------------------------------------------
// encodeNData → decode round-trip
// ---------------------------------------------------------------------------

describe("encodeNData", () => {
  it("encodes NDATA with seq and agent self-metrics", () => {
    const buf = encodeNData({
      seq: 42,
      metrics: [
        { name: "uptime_seconds", type: "Int32", value: 3600 },
        { name: "event_loop_lag_ms", type: "Double", value: 1.2 },
        { name: "buffer_total_length", type: "Int32", value: 50 },
      ],
    });

    const decoded = sparkplug.decodePayload(new Uint8Array(buf));

    // seq is present
    expect(Number(decoded.seq)).toBe(42);

    expect(decoded.metrics).toHaveLength(3);

    const uptime = decoded.metrics!.find((m) => m.name === "uptime_seconds");
    expect(uptime).toBeDefined();
    expect(Number(uptime!.value)).toBe(3600);

    const lag = decoded.metrics!.find((m) => m.name === "event_loop_lag_ms");
    expect(lag!.value).toBe(1.2);

    const bufLen = decoded.metrics!.find((m) => m.name === "buffer_total_length");
    expect(Number(bufLen!.value)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// decodeNCmd
// ---------------------------------------------------------------------------

describe("decodeNCmd", () => {
  it("decodes a rebirth command", () => {
    // Encode a command payload with Node Control/Rebirth = true
    const cmdPayload = sparkplug.encodePayload({
      timestamp: Date.now(),
      metrics: [
        {
          name: "Node Control/Rebirth",
          type: "Boolean" as const,
          value: true,
          timestamp: Date.now(),
        },
      ],
    });

    const result = decodeNCmd(Buffer.from(cmdPayload));

    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]!.name).toBe("Node Control/Rebirth");
    expect(result.metrics[0]!.value).toBe(true);
    expect(result.metrics[0]!.type).toBe("Boolean");
  });

  it("decodes multiple command metrics", () => {
    const cmdPayload = sparkplug.encodePayload({
      timestamp: Date.now(),
      metrics: [
        {
          name: "Node Control/Rebirth",
          type: "Boolean" as const,
          value: true,
          timestamp: Date.now(),
        },
        {
          name: "Node Control/Restart",
          type: "Boolean" as const,
          value: false,
          timestamp: Date.now(),
        },
      ],
    });

    const result = decodeNCmd(Buffer.from(cmdPayload));
    expect(result.metrics).toHaveLength(2);
  });
});
