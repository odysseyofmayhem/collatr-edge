// CollatrEdge — MQTT consumer input plugin (ServiceInput)
// PRD refs: §6 Plugin System, §19 MVP Plugin Inventory
// ──────────────────────────────────────────────────────────────────────
// Subscribe to MQTT topics and parse incoming messages as metrics.
// Supports JSON (flat + nested) and plain string payloads.
// ──────────────────────────────────────────────────────────────────────

import { z } from "zod/v4";
import type { ServiceInput } from "../../core/plugin-types";
import type { Accumulator } from "../../core/accumulator";
import { getLogger } from "../../core/logger";
import type { FieldValue } from "../../core/metric";
import { parseDuration } from "../../core/config";

// ---------------------------------------------------------------------------
// Zod config schema — matches PRD Appendix A + §19 + task 2.3 spec
// ---------------------------------------------------------------------------

export const MqttConsumerConfigSchema = z.object({
  // Connection
  servers: z.array(z.string()).min(1)
    .describe("MQTT broker URLs (e.g., tcp://192.168.10.50:1883)"),
  client_id: z.string().optional()
    .describe("MQTT client ID. Auto-generated if not set."),

  // Subscriptions
  topics: z.array(z.string()).min(1)
    .describe("MQTT topics to subscribe to (supports + and # wildcards)"),
  qos: z.number().int().min(0).max(2).default(1)
    .describe("MQTT QoS level (0, 1, or 2)"),

  // Payload parsing
  data_format: z.enum(["json", "value"]).default("json")
    .describe("Payload format: 'json' parses JSON objects, 'value' treats entire payload as single value"),

  // Measurement naming
  measurement: z.string().optional()
    .describe("Override measurement name. Defaults to topic name."),

  // Topic → tag mapping
  topic_tag: z.string().default("topic")
    .describe("Tag key for the MQTT topic. Set to '' to disable."),
  topic_tags: z.array(z.object({
    topic_pattern: z.string()
      .describe("Topic pattern with named segments, e.g., 'factory/+factory_id/line/+line_id'"),
    tags: z.array(z.string())
      .describe("Tag names for each + segment in order"),
  })).optional()
    .describe("Extract tag values from topic segments"),

  // Tags
  tags: z.record(z.string(), z.string()).optional()
    .describe("Static tags to add to all metrics from this input"),

  // Auth
  username: z.string().optional(),
  password: z.string().optional(),

  // TLS
  tls: z.object({
    ca_file: z.string().optional(),
    cert_file: z.string().optional(),
    key_file: z.string().optional(),
    insecure_skip_verify: z.boolean().default(false),
  }).optional(),

  // Reconnection
  reconnect: z.object({
    initial_delay: z.string().default("1s"),
    max_delay: z.string().default("30s"),
    max_retry: z.number().int().min(0).default(0)
      .describe("Max reconnect attempts (0 = unlimited)"),
  }).default({
    initial_delay: "1s",
    max_delay: "30s",
    max_retry: 0,
  }),
});

export type MqttConsumerConfig = z.infer<typeof MqttConsumerConfigSchema>;

// ---------------------------------------------------------------------------
// MQTT client interface (for dependency injection / testing)
// ---------------------------------------------------------------------------

export interface MqttMessageEvent {
  topic: string;
  payload: Buffer;
  qos: number;
  retain: boolean;
}

export interface MqttClientOptions {
  clientId?: string;
  username?: string;
  password?: string;
  reconnectPeriod?: number;
  maxReconnectDelay?: number;
  maxReconnectAttempts?: number;
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface MqttClientInterface {
  connect(servers: string[], options: MqttClientOptions): void;
  subscribe(topics: string[], qos: number): Promise<void>;
  unsubscribe(topics: string[]): Promise<void>;
  onMessage(handler: (event: MqttMessageEvent) => void): void;
  onConnect(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
  onReconnect(handler: () => void): void;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;
}

// ---------------------------------------------------------------------------
// JSON payload flattening (nested → dot-notation)
// ---------------------------------------------------------------------------

/**
 * Flatten a JSON object into dot-notation fields.
 * Nested objects → "parent.child" keys.
 * Arrays → "parent[0]", "parent[1]", "parent.length" keys.
 * Only primitive leaf values are kept.
 */
export function flattenJson(
  obj: unknown,
  prefix = "",
  result: Record<string, FieldValue> = {},
): Record<string, FieldValue> {
  if (obj === null || obj === undefined) return result;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const key = prefix ? `${prefix}[${i}]` : `[${i}]`;
      flattenJson(obj[i], key, result);
    }
    result[prefix ? `${prefix}.length` : "length"] = obj.length;
    return result;
  }

  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      flattenJson(value, fullKey, result);
    }
    return result;
  }

  // Leaf value — only include if it's a valid FieldValue type
  if (typeof obj === "number" || typeof obj === "string" || typeof obj === "boolean") {
    if (prefix) result[prefix] = obj;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Topic → tag extraction
// ---------------------------------------------------------------------------

/**
 * Extract tags from a topic path using a pattern with named segments.
 * Pattern: "factory/+factory_id/line/+line_id"
 * Topic:   "factory/A/line/1"
 * Result:  { factory_id: "A", line_id: "1" }
 */
export function extractTopicTags(
  topic: string,
  topicTags?: MqttConsumerConfig["topic_tags"],
): Record<string, string> {
  if (!topicTags || topicTags.length === 0) return {};

  const topicParts = topic.split("/");
  const result: Record<string, string> = {};

  for (const mapping of topicTags) {
    const patternParts = mapping.topic_pattern.split("/");
    let tagIndex = 0;
    let matches = true;

    // Check if topic matches pattern (accounting for wildcards)
    if (patternParts.length !== topicParts.length) {
      // Allow # at end to match remaining segments
      if (patternParts[patternParts.length - 1] !== "#") {
        continue;
      }
    }

    for (let i = 0; i < patternParts.length; i++) {
      const pPart = patternParts[i]!;
      if (pPart === "#") break; // matches rest
      if (i >= topicParts.length) { matches = false; break; }

      if (pPart.startsWith("+")) {
        // Named wildcard — extract tag value
        if (tagIndex < mapping.tags.length) {
          result[mapping.tags[tagIndex]!] = topicParts[i]!;
          tagIndex++;
        }
      } else if (pPart !== topicParts[i]) {
        matches = false;
        break;
      }
    }

    if (matches) return result;
  }

  return result;
}

// ---------------------------------------------------------------------------
// MQTT Consumer Input plugin
// ---------------------------------------------------------------------------

export class MqttConsumerInput implements ServiceInput {
  private config: MqttConsumerConfig;
  private client: MqttClientInterface;
  private acc: Accumulator | null = null;
  private _stopped = false;
  private reconnectAttempts = 0;

  constructor(config: MqttConsumerConfig, client?: MqttClientInterface) {
    this.config = config;
    this.client = client ?? createDefaultMqttClient();
  }

  async gather(_acc: Accumulator): Promise<void> {
    // No-op — MQTT is push-based (ServiceInput).
    // All data flows through the onMessage handler registered in start().
  }

  async start(acc: Accumulator): Promise<void> {
    this.acc = acc;
    this._stopped = false;

    // Set up message handler
    this.client.onMessage((event: MqttMessageEvent) => {
      if (this._stopped) return;
      this.handleMessage(event);
    });

    // Set up error handler
    this.client.onError((error: Error) => {
      if (this._stopped) return;
      getLogger().error("error", { plugin: "mqtt_consumer", error: error.message });
      if (this.acc) this.acc.addError(error);
    });

    // Set up reconnect handler with retry tracking (F-05: wire max_retry)
    this.client.onReconnect(() => {
      if (this._stopped) return;
      this.reconnectAttempts++;
      const maxRetry = this.config.reconnect.max_retry;
      if (maxRetry > 0 && this.reconnectAttempts > maxRetry) {
        getLogger().error("max reconnect attempts exceeded — giving up", { plugin: "mqtt_consumer", max_retry: maxRetry });
        this.client.disconnect().catch(() => {});
        return;
      }
      getLogger().info("reconnecting", { plugin: "mqtt_consumer", attempt: this.reconnectAttempts });
    });

    // Set up connect handler to (re)subscribe on connect
    this.client.onConnect(() => {
      if (this._stopped) return;
      this.reconnectAttempts = 0; // reset on successful connect
      // Subscribe on connect (and re-connect)
      this.client.subscribe(this.config.topics, this.config.qos).catch((err: Error) => {
        getLogger().error("subscribe error", { plugin: "mqtt_consumer", error: err.message });
        if (this.acc) this.acc.addError(err);
      });
    });

    // Connect to broker(s) — F-02: pass full servers list for failover
    const reconnectConfig = this.config.reconnect;
    const initialDelayMs = parseDuration(reconnectConfig.initial_delay);
    const maxDelayMs = parseDuration(reconnectConfig.max_delay);
    const maxRetry = reconnectConfig.max_retry;

    const options: MqttClientOptions = {
      clientId: this.config.client_id,
      username: this.config.username,
      password: this.config.password,
      reconnectPeriod: initialDelayMs,
      maxReconnectDelay: maxDelayMs,
      maxReconnectAttempts: maxRetry > 0 ? maxRetry : undefined,
    };

    // TLS options
    if (this.config.tls) {
      options.ca = this.config.tls.ca_file;
      options.cert = this.config.tls.cert_file;
      options.key = this.config.tls.key_file;
      options.rejectUnauthorized = !this.config.tls.insecure_skip_verify;
    }

    this.client.connect(this.config.servers, options);
  }

  async stop(): Promise<void> {
    this._stopped = true;
    try {
      await this.client.unsubscribe(this.config.topics);
    } catch {
      // Ignore unsubscribe errors during shutdown
    }
    await this.client.disconnect();
    this.acc = null;
  }

  // -------------------------------------------------------------------------
  // Private: message handling
  // -------------------------------------------------------------------------

  private handleMessage(event: MqttMessageEvent): void {
    if (!this.acc) return;

    try {
      const payloadStr = event.payload.toString("utf-8");
      const measurementName = this.config.measurement ?? event.topic;

      // Build tags
      const tags: Record<string, string> = {};

      // Static tags from config
      if (this.config.tags) {
        Object.assign(tags, this.config.tags);
      }

      // Topic tag
      if (this.config.topic_tag && this.config.topic_tag !== "") {
        tags[this.config.topic_tag] = event.topic;
      }

      // Topic → tag extraction
      const topicTags = extractTopicTags(event.topic, this.config.topic_tags);
      Object.assign(tags, topicTags);

      // Parse payload
      let fields: Record<string, FieldValue>;

      if (this.config.data_format === "json") {
        const parsed = JSON.parse(payloadStr);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          fields = flattenJson(parsed);
        } else {
          // Non-object JSON (number, string, boolean, array)
          fields = { value: this.toFieldValue(parsed) };
        }
      } else {
        // data_format === "value" — entire payload is a single value
        const num = Number(payloadStr);
        if (!isNaN(num) && payloadStr.trim() !== "") {
          fields = { value: num };
        } else {
          fields = { value: payloadStr };
        }
      }

      if (Object.keys(fields).length === 0) return;

      this.acc.addFields(measurementName, fields, tags);
    } catch (error: unknown) {
      // Parse error — log but don't crash
      const msg = error instanceof Error ? error.message : String(error);
      getLogger().error("payload parse error", { plugin: "mqtt_consumer", topic: event.topic, error: msg });
      if (this.acc) this.acc.addError(new Error(`Payload parse error: ${msg}`));
    }
  }

  private toFieldValue(value: unknown): FieldValue {
    if (typeof value === "number") return value;
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value;
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Default MQTT client factory (wraps mqtt.js)
// ---------------------------------------------------------------------------

function createDefaultMqttClient(): MqttClientInterface {
  // Stub client that defers failure to start() time instead of throwing at construction.
  // Tests inject mock clients. Production will need a real mqtt.js wrapper (Phase 7+).
  const notImplemented = (): never => {
    throw new Error(
      "MQTT client not implemented — inject a client via constructor for testing, " +
      "or implement the real mqtt.js wrapper for production use.",
    );
  };
  return {
    connect: notImplemented,
    subscribe: () => Promise.reject(new Error("MQTT client not implemented")),
    unsubscribe: () => Promise.reject(new Error("MQTT client not implemented")),
    onMessage: notImplemented,
    onConnect: notImplemented,
    onError: notImplemented,
    onClose: notImplemented,
    onReconnect: notImplemented,
    disconnect: () => Promise.reject(new Error("MQTT client not implemented")),
    get isConnected() { return false; },
  };
}

// ---------------------------------------------------------------------------
// Factory function for config-based instantiation
// ---------------------------------------------------------------------------

export function createMqttConsumerInput(
  rawConfig: unknown,
  client?: MqttClientInterface,
): MqttConsumerInput {
  const config = MqttConsumerConfigSchema.parse(rawConfig);
  return new MqttConsumerInput(config, client);
}
