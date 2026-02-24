// CollatrEdge — MQTT output plugin
// PRD refs: §9 Hub Link & Control Plane, §19 MVP Plugin Inventory
// ──────────────────────────────────────────────────────────────────────
// Publishes metrics via MQTT. Two modes:
// 1. Sparkplug B mode: routes metrics through Hub link by device_id tag
// 2. Plain MQTT mode: publishes JSON to configured topic
// ──────────────────────────────────────────────────────────────────────

import { z } from "zod/v4";
import type { Output } from "../../core/plugin-types.ts";
import type { Metric } from "../../core/metric.ts";
import type { MqttClientInterface } from "../../core/mqtt-types.ts";
import { RealMqttClient } from "../../core/mqtt-client.ts";
import { getLogger } from "../../core/logger.ts";
import { toJSON } from "./stdout.ts";
import type { HubLink } from "../../hub/hub-link.ts";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export const MqttOutputConfigSchema = z.object({
  // Connection (used when NOT sharing Hub link connection)
  servers: z.array(z.string()).optional(),
  client_id: z.string().optional(),

  // Sparkplug B mode (when hub link handles connection)
  sparkplug: z.boolean().default(false),

  // Plain MQTT mode settings
  topic: z.string().default("collatr/${name}")
    .describe("Topic template for plain mode. Supports ${name} substitution."),
  data_format: z.enum(["json", "sparkplug"]).default("json"),
  qos: z.number().int().min(0).max(1).default(1) as z.ZodType<0 | 1>,
  retain: z.boolean().default(false),

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
  }).default({ initial_delay: "1s", max_delay: "30s" }),
});

export type MqttOutputConfig = z.infer<typeof MqttOutputConfigSchema>;

// Internal tag used to route metrics to Sparkplug devices
const DEVICE_ID_TAG = "_device_id";

// ---------------------------------------------------------------------------
// MQTT Output
// ---------------------------------------------------------------------------

export class MqttOutput implements Output {
  private config: MqttOutputConfig;
  private hubLink: HubLink | null;
  private client: MqttClientInterface | null;
  private ownClient: boolean;

  constructor(config: MqttOutputConfig, hubLink?: HubLink, client?: MqttClientInterface) {
    this.config = config;
    this.hubLink = hubLink ?? null;
    this.ownClient = false;
    this.client = client ?? null;
  }

  async connect(): Promise<void> {
    if (this.config.sparkplug && this.hubLink) {
      // Sparkplug mode — Hub link manages the connection
      getLogger().info("mqtt output using hub link connection", { plugin: "mqtt_output" });
      return;
    }

    // Plain mode — connect our own client
    if (!this.config.servers || this.config.servers.length === 0) {
      throw new Error("MQTT output requires 'servers' config when not in sparkplug mode");
    }

    if (!this.client) {
      this.client = new RealMqttClient();
    }
    this.ownClient = true;

    this.client.onError((error: Error) => {
      getLogger().error("mqtt output error", { plugin: "mqtt_output", error: error.message });
    });

    this.client.connect(this.config.servers, {
      clientId: this.config.client_id,
      username: this.config.username,
      password: this.config.password,
      ca: this.config.tls?.ca_file,
      cert: this.config.tls?.cert_file,
      key: this.config.tls?.key_file,
      rejectUnauthorized: this.config.tls ? !this.config.tls.insecure_skip_verify : undefined,
    });
  }

  async write(batch: Metric[]): Promise<void> {
    if (this.config.sparkplug && this.hubLink) {
      await this.writeSparkplug(batch);
    } else {
      await this.writePlain(batch);
    }
  }

  async close(): Promise<void> {
    // Only disconnect our own client, not the hub link's
    if (this.ownClient && this.client) {
      await this.client.disconnect();
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async writeSparkplug(batch: Metric[]): Promise<void> {
    if (!this.hubLink) return;

    // Group metrics by _device_id tag (operate on copies to avoid mutating shared objects)
    const grouped = new Map<string, Metric[]>();
    for (const metric of batch) {
      const deviceId = metric.getTag(DEVICE_ID_TAG) ?? "unknown";
      let group = grouped.get(deviceId);
      if (!group) {
        group = [];
        grouped.set(deviceId, group);
      }
      // Copy + strip _device_id tag (internal routing — must not mutate shared metric)
      const cleaned = metric.copy();
      cleaned.removeTag(DEVICE_ID_TAG);
      group.push(cleaned);
    }

    // Publish each device's metrics
    for (const [deviceId, metrics] of grouped) {
      try {
        await this.hubLink.publishDeviceData(deviceId, metrics);
      } catch (err) {
        getLogger().error("sparkplug publish failed", {
          plugin: "mqtt_output",
          device_id: deviceId,
          error: String(err),
        });
      }
    }
  }

  private async writePlain(batch: Metric[]): Promise<void> {
    if (!this.client) return;

    for (const metric of batch) {
      const topic = this.config.topic.replace("${name}", metric.name);
      const payload = Buffer.from(toJSON(metric));

      try {
        await this.client.publish(topic, payload, {
          qos: this.config.qos as 0 | 1,
          retain: this.config.retain,
        });
      } catch (err) {
        getLogger().error("mqtt publish failed", {
          plugin: "mqtt_output",
          topic,
          error: String(err),
        });
      }
    }
  }
}
