// CollatrEdge — Plugin factory: config → PipelineOptions
// PRD refs: §6 Plugin System, §7 Configuration, §8 Pipeline Lifecycle
//
// Bridges parsed AgentConfig to the PipelineOptions expected by PipelineRuntime.
// Validates each plugin instance config against its Zod schema, instantiates
// plugins, wires per-plugin overrides (interval, timeout, batch_size, period,
// drop_original, enabled), and extracts metric filters.

import type { AgentConfig, PluginInstanceConfig } from "../core/config";
import { parseDuration } from "../core/config";
import { MetricFilter, type MetricFilterConfig } from "../core/metric-filter";
import { SimpleStatsCollector, type StatsCollector } from "../core/stats";
import type { Input, Processor, Aggregator, Output } from "../core/plugin-types";
import type { PipelineOptions } from "./runtime";

// Plugin classes
import { ModbusInput } from "../plugins/inputs/modbus";
import { ModbusConfigSchema } from "../plugins/inputs/modbus";
import { OpcuaInput } from "../plugins/inputs/opcua";
import { OpcuaConfigSchema } from "../plugins/inputs/opcua";
import { MqttConsumerInput } from "../plugins/inputs/mqtt-consumer";
import { MqttConsumerConfigSchema } from "../plugins/inputs/mqtt-consumer";
import { InternalInput } from "../plugins/inputs/internal";
import { InternalConfigSchema } from "../plugins/inputs/internal";
import { RenameProcessor } from "../plugins/processors/rename";
import { RenameConfigSchema } from "../plugins/processors/rename";
import { FilterProcessor } from "../plugins/processors/filter";
import { FilterConfigSchema } from "../plugins/processors/filter";
import { BasicstatsAggregator } from "../plugins/aggregators/basicstats";
import { BasicstatsConfigSchema } from "../plugins/aggregators/basicstats";
import { LocalStoreOutput } from "../plugins/outputs/local-store";
import { LocalStoreConfigSchema } from "../plugins/outputs/local-store";
import { FileOutput } from "../plugins/outputs/file";
import { FileOutputConfigSchema } from "../plugins/outputs/file";
import { StdoutOutput } from "../plugins/outputs/stdout";
import { StdoutConfigSchema } from "../plugins/outputs/stdout";
import { MqttOutput } from "../plugins/outputs/mqtt";
import { MqttOutputConfigSchema } from "../plugins/outputs/mqtt";
import { HubLink, type HubLinkConfig } from "../hub/hub-link";

// ---------------------------------------------------------------------------
// Filter fields extracted from raw plugin config
// ---------------------------------------------------------------------------

/** Filter fields that can appear on any plugin (PRD §7). Exported for config-validate. */
export const FILTER_KEYS = [
  "namepass", "namedrop", "tagpass", "tagdrop", "fieldpass", "fielddrop",
] as const;

/**
 * Extract MetricFilter config fields from a raw plugin instance config.
 * Returns a MetricFilterConfig (possibly empty) and the remaining config
 * with filter fields stripped out.
 */
function extractFilterConfig(
  raw: PluginInstanceConfig,
): { filterConfig: MetricFilterConfig; pluginConfig: PluginInstanceConfig } {
  const filterConfig: Record<string, unknown> = {};
  const pluginConfig: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if ((FILTER_KEYS as readonly string[]).includes(key)) {
      filterConfig[key] = value;
    } else {
      pluginConfig[key] = value;
    }
  }

  return {
    filterConfig: filterConfig as MetricFilterConfig,
    pluginConfig: pluginConfig as PluginInstanceConfig,
  };
}

/**
 * Create a MetricFilter from extracted config, or undefined if no filters set.
 */
function buildFilter(filterConfig: MetricFilterConfig): MetricFilter | undefined {
  const filter = new MetricFilter(filterConfig);
  return filter.isNoop ? undefined : filter;
}

// ---------------------------------------------------------------------------
// Per-plugin override extraction
// ---------------------------------------------------------------------------

/** Extract and remove well-known override fields from raw plugin config. */
interface PluginOverrides {
  interval?: number;
  timeout?: number;
  metricBatchSize?: number;
  period?: number;
  dropOriginal?: boolean;
  enabled?: boolean;
  order?: number;
  alias?: string;
  logLevel?: string;
}

// All PRD-defined per-plugin override keys (§7). Keys are extracted from raw
// config before Zod schema parsing so they don't cause unknown-field errors.
// Some overrides are wired to PipelineOptions (interval, timeout, etc.);
// others are extracted-and-discarded until their Phase 7+ features are built.
/** All PRD per-plugin override keys. Exported for config-validate. */
export const OVERRIDE_KEYS = [
  // Wired in Phase 6
  "interval", "timeout", "metric_batch_size", "period",
  "drop_original", "enabled", "order", "alias", "log_level",
  // PRD §7 — extracted to avoid Zod errors, wired in Phase 7+
  "error_behavior",       // per-plugin startup error behaviour
  "retry_max",            // output retry limit
  "retry_backoff",        // output backoff strategy
  "flush_interval",       // per-output flush interval override
  "flush_jitter",         // per-output flush jitter
  "collection_jitter",    // per-input collection jitter
  "collection_offset",    // per-input collection offset
  "precision",            // per-input timestamp precision
  "metric_buffer_limit",  // per-output buffer limit
  "tags",                 // per-input/processor additional tags
] as const;

function extractOverrides(
  raw: PluginInstanceConfig,
): { overrides: PluginOverrides; pluginConfig: PluginInstanceConfig } {
  const overrides: PluginOverrides = {};
  const pluginConfig: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "interval":
        overrides.interval = parseDuration(value as string);
        break;
      case "timeout":
        overrides.timeout = parseDuration(value as string);
        break;
      case "metric_batch_size":
        overrides.metricBatchSize = value as number;
        break;
      case "period":
        overrides.period = parseDuration(value as string);
        break;
      case "drop_original":
        overrides.dropOriginal = value as boolean;
        break;
      case "enabled":
        overrides.enabled = value as boolean;
        break;
      case "order":
        overrides.order = value as number;
        break;
      case "alias":
        overrides.alias = value as string;
        break;
      case "log_level":
        overrides.logLevel = value as string;
        break;
      default:
        // Strip remaining OVERRIDE_KEYS (Phase 7+ features) so they don't
        // leak into plugin Zod schemas. The values are intentionally discarded.
        if ((OVERRIDE_KEYS as readonly string[]).includes(key)) break;
        pluginConfig[key] = value;
        break;
    }
  }

  return { overrides, pluginConfig };
}

// ---------------------------------------------------------------------------
// Plugin constructor registry
// ---------------------------------------------------------------------------

type InputFactory = (config: unknown, stats: StatsCollector) => Input;
type ProcessorFactory = (config: unknown) => Processor;
type AggregatorFactory = (config: unknown) => Aggregator;
type OutputFactory = (config: unknown) => Output;

const INPUT_FACTORIES: Record<string, InputFactory> = {
  modbus: (config) => new ModbusInput(ModbusConfigSchema.parse(config)),
  opcua: (config) => new OpcuaInput(OpcuaConfigSchema.parse(config)),
  mqtt_consumer: (config) => new MqttConsumerInput(MqttConsumerConfigSchema.parse(config)),
  internal: (config, stats) => new InternalInput(InternalConfigSchema.parse(config), stats),
};

const PROCESSOR_FACTORIES: Record<string, ProcessorFactory> = {
  rename: (config) => new RenameProcessor(RenameConfigSchema.parse(config)),
  filter: (config) => new FilterProcessor(FilterConfigSchema.parse(config)),
};

const AGGREGATOR_FACTORIES: Record<string, AggregatorFactory> = {
  basicstats: (config) => new BasicstatsAggregator(BasicstatsConfigSchema.parse(config)),
};

const OUTPUT_FACTORIES: Record<string, OutputFactory> = {
  local_store: (config) => new LocalStoreOutput(LocalStoreConfigSchema.parse(config)),
  file: (config) => new FileOutput(FileOutputConfigSchema.parse(config)),
  stdout: (config) => new StdoutOutput(StdoutConfigSchema.parse(config)),
  mqtt: (config) => new MqttOutput(MqttOutputConfigSchema.parse(config)),
};

// ---------------------------------------------------------------------------
// buildPipeline — main factory function
// ---------------------------------------------------------------------------

/**
 * Build PipelineOptions from a parsed AgentConfig.
 *
 * @param config   Parsed and validated AgentConfig (from parseConfig / loadConfigFile)
 * @param stats    Optional StatsCollector for InternalInput. If not provided, a
 *                 SimpleStatsCollector is created.
 * @returns PipelineOptions ready for PipelineRuntime
 * @throws Error if an unknown plugin type is encountered or Zod validation fails
 */
export function buildPipeline(
  config: AgentConfig,
  stats?: StatsCollector,
): PipelineOptions {
  const statsCollector = stats ?? new SimpleStatsCollector();

  // -- Inputs --
  const inputs: PipelineOptions["inputs"] = [];
  for (const [pluginName, instances] of Object.entries(config.inputs)) {
    const factory = INPUT_FACTORIES[pluginName];
    if (!factory) {
      throw new Error(`Unknown input plugin: "${pluginName}"`);
    }
    for (const rawInstance of instances) {
      // 1. Extract filter fields
      const { filterConfig, pluginConfig: afterFilter } = extractFilterConfig(rawInstance);
      // 2. Extract override fields
      const { overrides, pluginConfig } = extractOverrides(afterFilter);
      // 3. Skip disabled plugins
      if (overrides.enabled === false) continue;
      // 4. Instantiate plugin (Zod validates inside factory)
      const plugin = factory(pluginConfig, statsCollector);
      // 5. Build filter
      const filter = buildFilter(filterConfig);

      inputs.push({
        plugin,
        interval: overrides.interval,
        timeout: overrides.timeout,
        filter,
        alias: overrides.alias,
        logLevel: overrides.logLevel,
      });
    }
  }

  // -- Processors (sorted by order) --
  const processorEntries: { plugin: Processor; filter?: MetricFilter; order: number; alias?: string; logLevel?: string }[] = [];
  for (const [pluginName, instances] of Object.entries(config.processors)) {
    const factory = PROCESSOR_FACTORIES[pluginName];
    if (!factory) {
      throw new Error(`Unknown processor plugin: "${pluginName}"`);
    }
    for (const rawInstance of instances) {
      const { filterConfig, pluginConfig: afterFilter } = extractFilterConfig(rawInstance);
      const { overrides, pluginConfig } = extractOverrides(afterFilter);
      if (overrides.enabled === false) continue;
      const plugin = factory(pluginConfig);
      const filter = buildFilter(filterConfig);
      processorEntries.push({
        plugin,
        filter,
        order: overrides.order ?? 0,
        alias: overrides.alias,
        logLevel: overrides.logLevel,
      });
    }
  }
  // Sort by order (stable — preserves config order for equal values)
  processorEntries.sort((a, b) => a.order - b.order);
  const processors: PipelineOptions["processors"] = processorEntries.map(({ plugin, filter, alias, logLevel }) => ({
    plugin,
    filter,
    alias,
    logLevel,
  }));

  // -- Aggregators --
  // Note: aggregators handle their own filter fields (namepass, namedrop,
  // tagpass, tagdrop) in their Zod schemas — they build their own internal
  // MetricFilter in the constructor. We do NOT call extractFilterConfig()
  // here because that would strip the fields before the schema sees them.
  const aggregators: PipelineOptions["aggregators"] = [];
  for (const [pluginName, instances] of Object.entries(config.aggregators)) {
    const factory = AGGREGATOR_FACTORIES[pluginName];
    if (!factory) {
      throw new Error(`Unknown aggregator plugin: "${pluginName}"`);
    }
    for (const rawInstance of instances) {
      const { overrides, pluginConfig } = extractOverrides(rawInstance);
      if (overrides.enabled === false) continue;
      const plugin = factory(pluginConfig);
      aggregators.push({
        plugin,
        period: overrides.period,
        dropOriginal: overrides.dropOriginal,
        alias: overrides.alias,
        logLevel: overrides.logLevel,
      });
    }
  }

  // -- Hub link (PRD §9: created when [agent.hub] enabled, before outputs) --
  let hubLink: HubLink | undefined;
  const hubConfig = config.agent.hub;
  if (hubConfig?.enabled) {
    hubLink = new HubLink({
      groupId: hubConfig.group_id,
      edgeNodeId: hubConfig.edge_node_id,
      broker: hubConfig.broker,
      tlsCert: hubConfig.tls_cert,
      tlsKey: hubConfig.tls_key,
      heartbeatIntervalMs: parseDuration(hubConfig.heartbeat_interval),
      swVersion: "0.1.0", // TODO: read from package.json or build info
    });
  }

  // -- Outputs --
  const outputs: PipelineOptions["outputs"] = [];
  for (const [pluginName, instances] of Object.entries(config.outputs)) {
    const factory = OUTPUT_FACTORIES[pluginName];
    if (!factory) {
      throw new Error(`Unknown output plugin: "${pluginName}"`);
    }
    for (const rawInstance of instances) {
      const { filterConfig, pluginConfig: afterFilter } = extractFilterConfig(rawInstance);
      const { overrides, pluginConfig } = extractOverrides(afterFilter);
      if (overrides.enabled === false) continue;

      // Special case: mqtt output with sparkplug mode needs the hub link
      let plugin: Output;
      if (pluginName === "mqtt") {
        const parsedConfig = MqttOutputConfigSchema.parse(pluginConfig);
        plugin = new MqttOutput(parsedConfig, parsedConfig.sparkplug ? hubLink : undefined);
      } else {
        plugin = factory(pluginConfig);
      }

      const filter = buildFilter(filterConfig);
      outputs.push({
        plugin,
        metricBatchSize: overrides.metricBatchSize,
        filter,
        alias: overrides.alias,
        logLevel: overrides.logLevel,
      });
    }
  }

  // -- Map agent-level config to PipelineOptions --
  return {
    inputs,
    processors,
    aggregators,
    outputs,
    gatherIntervalMs: parseDuration(config.agent.interval),
    flushIntervalMs: parseDuration(config.agent.flush_interval),
    roundInterval: config.agent.round_interval,
    globalTags: Object.keys(config.global_tags).length > 0
      ? config.global_tags
      : undefined,
    hubLink,
  };
}
