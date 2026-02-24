// CollatrEdge — Plugin schema registry
// Maps plugin type+name to Zod config schema for validation.
// Used by config validate command (6.3) and plugin factory (6.5).

import type { z } from "zod/v4";

// Input schemas
import { ModbusConfigSchema } from "../plugins/inputs/modbus";
import { OpcuaConfigSchema } from "../plugins/inputs/opcua";
import { MqttConsumerConfigSchema } from "../plugins/inputs/mqtt-consumer";
import { InternalConfigSchema } from "../plugins/inputs/internal";

// Processor schemas
import { RenameConfigSchema } from "../plugins/processors/rename";
import { FilterConfigSchema } from "../plugins/processors/filter";

// Aggregator schemas
import { BasicstatsConfigSchema } from "../plugins/aggregators/basicstats";

// Output schemas
import { LocalStoreConfigSchema } from "../plugins/outputs/local-store";
import { FileOutputConfigSchema } from "../plugins/outputs/file";
import { StdoutConfigSchema } from "../plugins/outputs/stdout";
import { MqttOutputConfigSchema } from "../plugins/outputs/mqtt";

/**
 * Central registry mapping "type.name" → Zod schema.
 * Keys match the TOML config section format: "inputs.modbus", "outputs.file", etc.
 */
export const PLUGIN_SCHEMAS: Record<string, z.ZodType> = {
  "inputs.modbus": ModbusConfigSchema,
  "inputs.opcua": OpcuaConfigSchema,
  "inputs.mqtt_consumer": MqttConsumerConfigSchema,
  "inputs.internal": InternalConfigSchema,
  "processors.rename": RenameConfigSchema,
  "processors.filter": FilterConfigSchema,
  "aggregators.basicstats": BasicstatsConfigSchema,
  "outputs.local_store": LocalStoreConfigSchema,
  "outputs.file": FileOutputConfigSchema,
  "outputs.stdout": StdoutConfigSchema,
  "outputs.mqtt": MqttOutputConfigSchema,
};
