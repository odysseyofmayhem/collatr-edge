import { describe, it, expect } from "bun:test";
import { buildPipeline } from "@pipeline/plugin-factory";
import type { AgentConfig } from "@core/config";
import { resolveNetworkPolicy, PolicyViolationError } from "@core/network-policy";
import { SimpleStatsCollector } from "@core/stats";
import { InternalInput } from "@plugins/inputs/internal";
import { ModbusInput } from "@plugins/inputs/modbus";
import { OpcuaInput } from "@plugins/inputs/opcua";
import { MqttConsumerInput } from "@plugins/inputs/mqtt-consumer";
import { RenameProcessor } from "@plugins/processors/rename";
import { FilterProcessor } from "@plugins/processors/filter";
import { BasicstatsAggregator } from "@plugins/aggregators/basicstats";
import { LocalStoreOutput } from "@plugins/outputs/local-store";
import { FileOutput } from "@plugins/outputs/file";
import { StdoutOutput } from "@plugins/outputs/stdout";

// ---------------------------------------------------------------------------
// Helper: minimal AgentConfig factory
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agent: {
      interval: "10s",
      round_interval: true,
      collection_jitter: "0s",
      collection_offset: "0s",
      flush_interval: "10s",
      flush_jitter: "0s",
      precision: "1ms",
      log_level: "info",
    },
    global_tags: {},
    inputs: {},
    processors: {},
    aggregators: {},
    outputs: {},
    networkPolicy: resolveNetworkPolicy(),
    secretRefs: [],
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Minimal config — internal input + stdout output
// ---------------------------------------------------------------------------

describe("buildPipeline", () => {
  it("builds pipeline from minimal config (internal + stdout)", () => {
    const config = makeConfig({
      inputs: { internal: [{}] },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.inputs).toHaveLength(1);
    expect(opts.inputs[0]!.plugin).toBeInstanceOf(InternalInput);
    expect(opts.outputs).toHaveLength(1);
    expect(opts.outputs[0]!.plugin).toBeInstanceOf(StdoutOutput);
    expect(opts.processors).toHaveLength(0);
    expect(opts.aggregators).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. Full config — all plugin types
  // -------------------------------------------------------------------------

  it("builds pipeline with all plugin types", () => {
    const config = makeConfig({
      inputs: {
        modbus: [{
          controller: "tcp://192.168.1.10:502",
          registers: [{
            address: 0,
            type: "holding",
            data_type: "uint16",
            name: "temp",
            measurement: "plc",
          }],
        }],
        opcua: [{
          endpoint: "opc.tcp://192.168.1.20:4840",
          nodes: [{
            node_id: "ns=2;s=Temperature",
            name: "temp",
            measurement: "opc",
          }],
        }],
        mqtt_consumer: [{
          servers: ["tcp://localhost:1883"],
          topics: ["sensors/#"],
        }],
        internal: [{}],
      },
      processors: {
        rename: [{
          rename: { old_name: "new_name" },
        }],
        filter: [{
          namepass: ["cpu*"],
        }],
      },
      aggregators: {
        basicstats: [{
          stats: ["mean", "max", "min"],
        }],
      },
      outputs: {
        local_store: [{
          path: "/tmp/collatr-test-factory",
        }],
        file: [{
          path: "/tmp/collatr-test-factory-output.json",
        }],
        stdout: [{}],
      },
    });

    const opts = buildPipeline(config);

    // 4 inputs: modbus, opcua, mqtt_consumer, internal
    expect(opts.inputs).toHaveLength(4);
    expect(opts.inputs[0]!.plugin).toBeInstanceOf(ModbusInput);
    expect(opts.inputs[1]!.plugin).toBeInstanceOf(OpcuaInput);
    expect(opts.inputs[2]!.plugin).toBeInstanceOf(MqttConsumerInput);
    expect(opts.inputs[3]!.plugin).toBeInstanceOf(InternalInput);

    // 2 processors: rename, filter
    expect(opts.processors).toHaveLength(2);
    expect(opts.processors[0]!.plugin).toBeInstanceOf(RenameProcessor);
    expect(opts.processors[1]!.plugin).toBeInstanceOf(FilterProcessor);

    // 1 aggregator: basicstats
    expect(opts.aggregators).toHaveLength(1);
    expect(opts.aggregators[0]!.plugin).toBeInstanceOf(BasicstatsAggregator);

    // 3 outputs: local_store, file, stdout
    expect(opts.outputs).toHaveLength(3);
    expect(opts.outputs[0]!.plugin).toBeInstanceOf(LocalStoreOutput);
    expect(opts.outputs[1]!.plugin).toBeInstanceOf(FileOutput);
    expect(opts.outputs[2]!.plugin).toBeInstanceOf(StdoutOutput);
  });

  // -------------------------------------------------------------------------
  // 3. Unknown plugin type — throws clear error
  // -------------------------------------------------------------------------

  it("throws on unknown input plugin", () => {
    const config = makeConfig({
      inputs: { nonexistent: [{}] },
    });
    expect(() => buildPipeline(config)).toThrow('Unknown input plugin: "nonexistent"');
  });

  it("throws on unknown processor plugin", () => {
    const config = makeConfig({
      processors: { nonexistent: [{}] },
    });
    expect(() => buildPipeline(config)).toThrow('Unknown processor plugin: "nonexistent"');
  });

  it("throws on unknown aggregator plugin", () => {
    const config = makeConfig({
      aggregators: { nonexistent: [{}] },
    });
    expect(() => buildPipeline(config)).toThrow('Unknown aggregator plugin: "nonexistent"');
  });

  it("throws on unknown output plugin", () => {
    const config = makeConfig({
      outputs: { nonexistent: [{}] },
    });
    expect(() => buildPipeline(config)).toThrow('Unknown output plugin: "nonexistent"');
  });

  // -------------------------------------------------------------------------
  // 4. Invalid plugin config — Zod validation error
  // -------------------------------------------------------------------------

  it("throws Zod error for invalid modbus config (missing controller)", () => {
    const config = makeConfig({
      inputs: { modbus: [{}] }, // missing required 'controller' field
    });
    expect(() => buildPipeline(config)).toThrow();
  });

  it("throws Zod error for invalid opcua config (missing required fields)", () => {
    const config = makeConfig({
      inputs: { opcua: [{}] }, // missing endpoint and nodes
    });
    expect(() => buildPipeline(config)).toThrow();
  });

  // -------------------------------------------------------------------------
  // 5. Duration parsing — agent.interval → gatherIntervalMs
  // -------------------------------------------------------------------------

  it("parses agent duration strings to milliseconds", () => {
    const config = makeConfig({
      agent: {
        interval: "5s",
        round_interval: false,
        collection_jitter: "0s",
        collection_offset: "0s",
        flush_interval: "30s",
        flush_jitter: "0s",
        precision: "1ms",
        log_level: "info",
      },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.gatherIntervalMs).toBe(5_000);
    expect(opts.flushIntervalMs).toBe(30_000);
    expect(opts.roundInterval).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Per-plugin overrides — input with custom interval and timeout
  // -------------------------------------------------------------------------

  it("wires per-input interval and timeout overrides", () => {
    const config = makeConfig({
      inputs: {
        internal: [{
          interval: "30s",
          timeout: "5s",
        }],
      },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.inputs).toHaveLength(1);
    expect(opts.inputs[0]!.interval).toBe(30_000);
    expect(opts.inputs[0]!.timeout).toBe(5_000);
  });

  it("wires per-output metric_batch_size", () => {
    const config = makeConfig({
      outputs: {
        stdout: [{
          metric_batch_size: 500,
        }],
      },
    });

    const opts = buildPipeline(config);

    expect(opts.outputs).toHaveLength(1);
    expect(opts.outputs[0]!.metricBatchSize).toBe(500);
  });

  // -------------------------------------------------------------------------
  // 7. enabled: false — plugin skipped
  // -------------------------------------------------------------------------

  it("skips input plugins with enabled: false", () => {
    const config = makeConfig({
      inputs: {
        internal: [
          { enabled: false },
          {}, // second instance, enabled by default
        ],
      },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.inputs).toHaveLength(1);
    expect(opts.inputs[0]!.plugin).toBeInstanceOf(InternalInput);
  });

  it("skips processor plugins with enabled: false", () => {
    const config = makeConfig({
      processors: {
        rename: [{
          enabled: false,
          rename: { old: "new" },
        }],
      },
    });

    const opts = buildPipeline(config);
    expect(opts.processors).toHaveLength(0);
  });

  it("skips aggregator plugins with enabled: false", () => {
    const config = makeConfig({
      aggregators: {
        basicstats: [{
          enabled: false,
          stats: ["mean"],
        }],
      },
    });

    const opts = buildPipeline(config);
    expect(opts.aggregators).toHaveLength(0);
  });

  it("skips output plugins with enabled: false", () => {
    const config = makeConfig({
      outputs: {
        stdout: [{ enabled: false }],
        file: [{ path: "/tmp/test.json" }],
      },
    });

    const opts = buildPipeline(config);

    expect(opts.outputs).toHaveLength(1);
    expect(opts.outputs[0]!.plugin).toBeInstanceOf(FileOutput);
  });

  // -------------------------------------------------------------------------
  // 8. Global tags — passed through to PipelineOptions
  // -------------------------------------------------------------------------

  it("passes global_tags through to PipelineOptions", () => {
    const config = makeConfig({
      global_tags: { env: "production", site: "factory-1" },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.globalTags).toEqual({ env: "production", site: "factory-1" });
  });

  it("omits globalTags when global_tags is empty", () => {
    const config = makeConfig({
      global_tags: {},
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.globalTags).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 9. drop_original wiring — aggregator config
  // -------------------------------------------------------------------------

  it("wires drop_original from aggregator config", () => {
    const config = makeConfig({
      aggregators: {
        basicstats: [{
          stats: ["mean"],
          drop_original: true,
        }],
      },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.aggregators).toHaveLength(1);
    expect(opts.aggregators[0]!.dropOriginal).toBe(true);
  });

  it("wires aggregator period override", () => {
    const config = makeConfig({
      aggregators: {
        basicstats: [{
          stats: ["mean"],
          period: "60s",
        }],
      },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.aggregators).toHaveLength(1);
    expect(opts.aggregators[0]!.period).toBe(60_000);
  });

  // -------------------------------------------------------------------------
  // 10. Per-plugin filter fields — namepass/namedrop → MetricFilter wired
  // -------------------------------------------------------------------------

  it("wires per-input metric filter from namepass/namedrop", () => {
    const config = makeConfig({
      inputs: {
        internal: [{
          namepass: ["cpu*", "mem*"],
        }],
      },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.inputs).toHaveLength(1);
    expect(opts.inputs[0]!.filter).toBeDefined();
    // Filter is a MetricFilter instance — verify it's not a noop
    expect(opts.inputs[0]!.filter!.isNoop).toBe(false);
  });

  it("wires per-output metric filter from tagpass", () => {
    const config = makeConfig({
      outputs: {
        stdout: [{
          tagpass: { host: ["server-*"] },
        }],
      },
    });

    const opts = buildPipeline(config);

    expect(opts.outputs).toHaveLength(1);
    expect(opts.outputs[0]!.filter).toBeDefined();
    expect(opts.outputs[0]!.filter!.isNoop).toBe(false);
  });

  it("wires per-processor metric filter", () => {
    const config = makeConfig({
      processors: {
        rename: [{
          rename: { old_name: "new_name" },
          namedrop: ["internal_*"],
        }],
      },
    });

    const opts = buildPipeline(config);

    expect(opts.processors).toHaveLength(1);
    expect(opts.processors[0]!.filter).toBeDefined();
    expect(opts.processors[0]!.filter!.isNoop).toBe(false);
  });

  it("omits filter when no filter fields are configured", () => {
    const config = makeConfig({
      inputs: { internal: [{}] },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.inputs[0]!.filter).toBeUndefined();
    expect(opts.outputs[0]!.filter).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // StatsCollector injection
  // -------------------------------------------------------------------------

  it("uses provided StatsCollector for internal input", () => {
    const stats = new SimpleStatsCollector(1000);
    const config = makeConfig({
      inputs: { internal: [{}] },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config, stats);

    expect(opts.inputs).toHaveLength(1);
    expect(opts.inputs[0]!.plugin).toBeInstanceOf(InternalInput);
  });

  // -------------------------------------------------------------------------
  // Processor ordering by order field
  // -------------------------------------------------------------------------

  it("sorts processors by order field", () => {
    const config = makeConfig({
      processors: {
        rename: [{
          rename: { a: "b" },
          order: 10,
        }],
        filter: [{
          namepass: ["cpu*"],
          order: 5,
        }],
      },
    });

    const opts = buildPipeline(config);

    expect(opts.processors).toHaveLength(2);
    // filter (order=5) should come before rename (order=10)
    expect(opts.processors[0]!.plugin).toBeInstanceOf(FilterProcessor);
    expect(opts.processors[1]!.plugin).toBeInstanceOf(RenameProcessor);
  });

  it("preserves config order for processors with same order value", () => {
    const config = makeConfig({
      processors: {
        rename: [
          { rename: { a: "b" } },
          { rename: { c: "d" } },
        ],
      },
    });

    const opts = buildPipeline(config);

    // Both have default order=0, should preserve insertion order
    expect(opts.processors).toHaveLength(2);
    expect(opts.processors[0]!.plugin).toBeInstanceOf(RenameProcessor);
    expect(opts.processors[1]!.plugin).toBeInstanceOf(RenameProcessor);
  });

  // -------------------------------------------------------------------------
  // Multiple instances of same plugin type
  // -------------------------------------------------------------------------

  it("supports multiple instances of the same plugin type", () => {
    const config = makeConfig({
      inputs: {
        modbus: [
          {
            controller: "tcp://192.168.1.10:502",
            registers: [{
              address: 0, type: "holding", data_type: "uint16",
              name: "temp1", measurement: "plc1",
            }],
          },
          {
            controller: "tcp://192.168.1.11:502",
            registers: [{
              address: 0, type: "holding", data_type: "uint16",
              name: "temp2", measurement: "plc2",
            }],
          },
        ],
      },
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.inputs).toHaveLength(2);
    expect(opts.inputs[0]!.plugin).toBeInstanceOf(ModbusInput);
    expect(opts.inputs[1]!.plugin).toBeInstanceOf(ModbusInput);
  });

  // -------------------------------------------------------------------------
  // Empty config sections
  // -------------------------------------------------------------------------

  it("handles config with no inputs, processors, aggregators", () => {
    const config = makeConfig({
      outputs: { stdout: [{}] },
    });

    const opts = buildPipeline(config);

    expect(opts.inputs).toHaveLength(0);
    expect(opts.processors).toHaveLength(0);
    expect(opts.aggregators).toHaveLength(0);
    expect(opts.outputs).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Network policy enforcement (PRD §10/§16)
  // -------------------------------------------------------------------------

  describe("network policy enforcement", () => {
    it("hub enabled + standalone policy → throws PolicyViolationError", () => {
      const config = makeConfig({
        agent: {
          interval: "10s",
          round_interval: true,
          collection_jitter: "0s",
          collection_offset: "0s",
          flush_interval: "10s",
          flush_jitter: "0s",
          precision: "1ms",
          log_level: "info",
          hub: {
            enabled: true,
            group_id: "factory",
            edge_node_id: "edge1",
            broker: "mqtt://hub.collatr.cloud:1883",
            heartbeat_interval: "30s",
          },
        },
        networkPolicy: resolveNetworkPolicy({ mode: "standalone" }),
        outputs: { stdout: [{}] },
      });

      expect(() => buildPipeline(config)).toThrow(PolicyViolationError);
    });

    it("hub enabled + connected policy → creates hub link normally", () => {
      const config = makeConfig({
        agent: {
          interval: "10s",
          round_interval: true,
          collection_jitter: "0s",
          collection_offset: "0s",
          flush_interval: "10s",
          flush_jitter: "0s",
          precision: "1ms",
          log_level: "info",
          hub: {
            enabled: true,
            group_id: "factory",
            edge_node_id: "edge1",
            broker: "mqtt://hub.collatr.cloud:1883",
            heartbeat_interval: "30s",
          },
        },
        networkPolicy: resolveNetworkPolicy({ mode: "connected" }),
        outputs: {
          mqtt: [{ sparkplug: true }],
        },
      });

      const opts = buildPipeline(config);
      expect(opts.hubLink).toBeDefined();
    });

    it("hub enabled + local_network policy → throws PolicyViolationError", () => {
      const config = makeConfig({
        agent: {
          interval: "10s",
          round_interval: true,
          collection_jitter: "0s",
          collection_offset: "0s",
          flush_interval: "10s",
          flush_jitter: "0s",
          precision: "1ms",
          log_level: "info",
          hub: {
            enabled: true,
            group_id: "factory",
            edge_node_id: "edge1",
            broker: "mqtt://hub.collatr.cloud:1883",
            heartbeat_interval: "30s",
          },
        },
        networkPolicy: resolveNetworkPolicy({ mode: "local_network" }),
        outputs: { stdout: [{}] },
      });

      expect(() => buildPipeline(config)).toThrow(PolicyViolationError);
    });

    it("passes networkPolicy to PipelineOptions", () => {
      const policy = resolveNetworkPolicy({ mode: "standalone" });
      const config = makeConfig({
        networkPolicy: policy,
        outputs: { stdout: [{}] },
      });

      const opts = buildPipeline(config);
      expect(opts.networkPolicy).toBe(policy);
    });

    it("passes networkPolicy to MQTT output", () => {
      const policy = resolveNetworkPolicy({
        mode: "local_network",
        egress: { allowed_hosts: ["192.168.1.10:1883"] },
      });
      const config = makeConfig({
        networkPolicy: policy,
        outputs: {
          mqtt: [{
            servers: ["tcp://192.168.1.10:1883"],
          }],
        },
      });

      // Should not throw — the server is in the allowed hosts list
      const opts = buildPipeline(config);
      expect(opts.outputs).toHaveLength(1);
    });
  });
});
