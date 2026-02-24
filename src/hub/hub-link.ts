// CollatrEdge — Hub link session manager
// PRD refs: §9 Hub Link & Control Plane, Appendix C Sparkplug B Topic Map
// ──────────────────────────────────────────────────────────────────────
// Runtime component (not a plugin) managing the Sparkplug B edge node
// session: MQTT connection, birth/death lifecycle, sequence numbering,
// device tracking, and NCMD subscription.
// ──────────────────────────────────────────────────────────────────────

import * as os from "os";
import type { MqttClientInterface } from "../core/mqtt-types.ts";
import type { Metric } from "../core/metric.ts";
import { getLogger } from "../core/logger.ts";
import { RealMqttClient } from "../core/mqtt-client.ts";
import {
  type SparkplugDataType,
  encodeNBirth,
  encodeNDeath,
  encodeDBirth,
  encodeDDeath,
  encodeDData,
  encodeNData,
  decodeNCmd,
  resolveAliases,
} from "./sparkplug-codec.ts";

// ---------------------------------------------------------------------------
// Config and types
// ---------------------------------------------------------------------------

export interface HubLinkConfig {
  groupId: string;
  edgeNodeId: string;
  broker: string;
  tlsCert?: string;
  tlsKey?: string;
  heartbeatIntervalMs: number;
  swVersion: string;
}

export interface DeviceInfo {
  deviceId: string;
  pluginType: string;
  pluginAlias: string;
  initialMetrics: Metric[];
  properties?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Topic builder
// ---------------------------------------------------------------------------

const TOPIC_PREFIX = "spBv1.0";

function buildTopic(groupId: string, msgType: string, edgeNodeId: string, deviceId?: string): string {
  const base = `${TOPIC_PREFIX}/${groupId}/${msgType}/${edgeNodeId}`;
  return deviceId ? `${base}/${deviceId}` : base;
}

// ---------------------------------------------------------------------------
// HubLink class
// ---------------------------------------------------------------------------

export class HubLink {
  private client: MqttClientInterface;
  private config: HubLinkConfig;
  // TODO: Phase 8+ — persist bdSeq in SQLite state for crash recovery
  private bdSeq = 0;
  private seq = 0;
  private devices = new Map<string, DeviceInfo>();
  private aliases = new Map<string, Map<string, number>>(); // deviceId → (metricName → alias)
  private deviceBirthPublished = new Set<string>();
  private lastKnownMetrics = new Map<string, Metric[]>(); // F-6: for rebirth re-publish
  private _connected = false;
  private _started = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private statsCollector: (() => { name: string; type: SparkplugDataType; value: unknown }[]) | null = null;

  constructor(config: HubLinkConfig, client?: MqttClientInterface) {
    this.config = config;
    this.client = client ?? new RealMqttClient();
  }

  get connected(): boolean { return this._connected; }
  get started(): boolean { return this._started; }

  /** Set an optional stats collector for heartbeat NDATA */
  setStatsCollector(collector: () => { name: string; type: SparkplugDataType; value: unknown }[]): void {
    this.statsCollector = collector;
  }

  /** Register a device (input plugin). Called during pipeline startup. */
  registerDevice(device: DeviceInfo): void {
    this.devices.set(device.deviceId, device);
    // Pre-compute aliases for initial metrics
    const metricNames = this.extractMetricNames(device.initialMetrics);
    if (metricNames.length > 0) {
      this.aliases.set(device.deviceId, resolveAliases(device.deviceId, metricNames));
    }
  }

  /** Start the hub link: set Will, connect, publish NBIRTH, subscribe to NCMD */
  async start(): Promise<void> {
    const log = getLogger();

    // 1. Set Will message (NDEATH with bdSeq)
    const ndeathTopic = buildTopic(this.config.groupId, "NDEATH", this.config.edgeNodeId);
    const ndeathPayload = encodeNDeath(this.bdSeq);
    this.client.setWill(ndeathTopic, ndeathPayload, 1, false);

    // 2. Connect and await connection establishment (RED-4 fix)
    this.client.onClose(() => {
      this._connected = false;
      log.info("hub link disconnected", { component: "hub_link" });
    });

    // Register onConnect before calling connect() — the handler fires once
    // the MQTT CONNACK is received (real client) or synchronously (mock client).
    const connected = new Promise<void>((resolve, reject) => {
      this.client.onConnect(() => {
        this._connected = true;
        log.info("hub link connected", { component: "hub_link" });
        resolve();
      });
      this.client.onError((error: Error) => {
        log.error("hub link connect error", { component: "hub_link", error: error.message });
        reject(new Error(`Hub link connect failed: ${error.message}`));
      });
    });

    this.client.connect([this.config.broker], {
      clientId: `collatr-edge-${this.config.edgeNodeId}`,
      cert: this.config.tlsCert,
      key: this.config.tlsKey,
      clean: true,
    });

    await connected;

    // 3. Publish NBIRTH + subscribe to NCMD (connection established at this point)
    try {
      await this.publishNBirth();

      const ncmdTopic = buildTopic(this.config.groupId, "NCMD", this.config.edgeNodeId);
      await this.client.subscribe([ncmdTopic], 1);

      // Wire NCMD handler
      this.client.onMessage((event) => {
        if (event.topic === ncmdTopic) {
          this.handleNCmd(event.payload);
        }
      });
    } catch (err) {
      // Partial startup cleanup (Finding 13)
      await this.client.disconnect().catch(() => {});
      throw err;
    }

    // Restore persistent error handler (replaces the connect-reject handler)
    this.client.onError((error: Error) => {
      log.error("hub link error", { component: "hub_link", error: error.message });
    });

    // 4. Start heartbeat timer
    if (this.config.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.publishHeartbeat().catch((err) => {
          log.error("heartbeat publish failed", { component: "hub_link", error: String(err) });
        });
      }, this.config.heartbeatIntervalMs);
    }

    this._started = true;
    log.info("hub link started", {
      component: "hub_link",
      group_id: this.config.groupId,
      edge_node_id: this.config.edgeNodeId,
      devices: this.devices.size,
    });
  }

  /** Publish DBIRTH for a device */
  async publishDeviceBirth(deviceId: string, metrics: Metric[]): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      getLogger().warn("publishDeviceBirth called for unregistered device, metrics dropped", {
        component: "hub_link", device_id: deviceId,
      });
      return;
    }

    // Track last-known metrics for rebirth re-publish (F-6)
    this.lastKnownMetrics.set(deviceId, metrics);

    // Compute/update aliases from current metrics
    const metricNames = this.extractMetricNames(metrics);
    const deviceAliases = resolveAliases(deviceId, metricNames);
    this.aliases.set(deviceId, deviceAliases);

    const topic = buildTopic(this.config.groupId, "DBIRTH", this.config.edgeNodeId, deviceId);
    const payload = encodeDBirth({
      seq: this.seq,
      deviceId,
      metrics,
      aliases: deviceAliases,
      pluginType: device.pluginType,
      pluginAlias: device.pluginAlias,
      properties: device.properties,
    });

    await this.client.publish(topic, payload, { qos: 0 });
    this.seq = this.nextSeq();
    this.deviceBirthPublished.add(deviceId);

    getLogger().info("DBIRTH published", { component: "hub_link", device_id: deviceId });
  }

  /** Publish DDATA for a device. Auto-publishes DBIRTH on first call. */
  async publishDeviceData(deviceId: string, metrics: Metric[]): Promise<void> {
    // Auto-DBIRTH on first data for this device
    if (!this.deviceBirthPublished.has(deviceId)) {
      await this.publishDeviceBirth(deviceId, metrics);
    }

    const deviceAliases = this.aliases.get(deviceId);
    if (!deviceAliases) return;

    // Ensure all metric names have aliases (new metrics since DBIRTH)
    const currentNames = this.extractMetricNames(metrics);
    for (const name of currentNames) {
      if (!deviceAliases.has(name)) {
        // New metric discovered — need DBIRTH re-publish
        await this.publishDeviceBirth(deviceId, metrics);
        break;
      }
    }

    const topic = buildTopic(this.config.groupId, "DDATA", this.config.edgeNodeId, deviceId);
    const payload = encodeDData({ seq: this.seq, metrics, aliases: this.aliases.get(deviceId)! });

    await this.client.publish(topic, payload, { qos: 0 });
    this.seq = this.nextSeq();
  }

  /** Publish DDEATH for a device */
  async publishDeviceDeath(deviceId: string): Promise<void> {
    const topic = buildTopic(this.config.groupId, "DDEATH", this.config.edgeNodeId, deviceId);
    const payload = encodeDDeath(this.seq);

    await this.client.publish(topic, payload, { qos: 0 });
    this.seq = this.nextSeq();
    this.deviceBirthPublished.delete(deviceId);

    getLogger().info("DDEATH published", { component: "hub_link", device_id: deviceId });
  }

  /** Publish NDATA with agent self-metrics */
  async publishNodeData(metrics: { name: string; value: unknown; type: SparkplugDataType }[]): Promise<void> {
    const topic = buildTopic(this.config.groupId, "NDATA", this.config.edgeNodeId);
    const payload = encodeNData({ seq: this.seq, metrics });

    await this.client.publish(topic, payload, { qos: 0 });
    this.seq = this.nextSeq();
  }

  /**
   * Perform full rebirth (NBIRTH + all DBIRTHs).
   *
   * Known limitation (F-2): MQTT Will message retains the original bdSeq from
   * start(). The MQTT protocol does not support updating the Will after CONNECT.
   * A proper fix requires disconnect → reconnect with updated Will → re-publish.
   * For MVP, the Hub will still receive NDEATH on ungraceful disconnect — it
   * just can't precisely correlate post-rebirth deaths with the latest NBIRTH.
   * TODO: Post-MVP — disconnect/reconnect cycle on rebirth (Eclipse Tahu pattern).
   */
  async rebirth(): Promise<void> {
    const log = getLogger();
    log.info("rebirth triggered", { component: "hub_link" });

    // Reset seq
    this.seq = 0;
    this.bdSeq = (this.bdSeq + 1) % 256;
    this.deviceBirthPublished.clear();

    // Re-publish NBIRTH
    await this.publishNBirth();

    // Re-publish DBIRTH for all devices that previously had a birth published,
    // using their last-known metrics (F-6: initialMetrics may be empty)
    for (const [deviceId] of this.devices) {
      const metrics = this.lastKnownMetrics.get(deviceId);
      if (metrics && metrics.length > 0) {
        await this.publishDeviceBirth(deviceId, metrics);
      }
    }
  }

  /** Graceful shutdown: publish DDEATH for all devices, then disconnect */
  async stop(): Promise<void> {
    const log = getLogger();

    // Cancel heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Publish DDEATH for all devices (snapshot to avoid Set modification during iteration)
    const devicesToClose = [...this.deviceBirthPublished];
    for (const deviceId of devicesToClose) {
      try {
        await this.publishDeviceDeath(deviceId);
      } catch (err) {
        log.error("DDEATH publish failed", { component: "hub_link", device_id: deviceId, error: String(err) });
      }
    }

    // Disconnect (broker will publish NDEATH via Will message)
    try {
      await this.client.disconnect();
    } catch (err) {
      log.error("hub link disconnect error", { component: "hub_link", error: String(err) });
    }

    this._started = false;
    this._connected = false;
    log.info("hub link stopped", { component: "hub_link" });
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  private async publishNBirth(): Promise<void> {
    const topic = buildTopic(this.config.groupId, "NBIRTH", this.config.edgeNodeId);
    const payload = encodeNBirth({
      bdSeq: this.bdSeq,
      swVersion: this.config.swVersion,
      hwPlatform: `${process.platform}-${process.arch}`,
      hostname: os.hostname(),
      pluginsLoaded: [...this.devices.values()].map((d) => d.pluginType),
      agentMetrics: [
        { name: "uptime_seconds", type: "Int32", value: 0 },
        { name: "event_loop_lag_ms", type: "Double", value: 0 },
        { name: "buffer_total_length", type: "Int32", value: 0 },
      ],
    });

    await this.client.publish(topic, payload, { qos: 0 });
    this.seq = 1; // NBIRTH consumed seq=0; next message starts at 1 (F-4)
  }

  private handleNCmd(payload: Buffer): void {
    const log = getLogger();
    try {
      const cmd = decodeNCmd(payload);
      for (const metric of cmd.metrics) {
        if (metric.name === "Node Control/Rebirth" && metric.value === true) {
          log.info("rebirth requested via NCMD", { component: "hub_link" });
          this.rebirth().catch((err) => {
            log.error("rebirth failed", { component: "hub_link", error: String(err) });
          });
        }
      }
    } catch (err) {
      log.error("NCMD decode error", { component: "hub_link", error: String(err) });
    }
  }

  private async publishHeartbeat(): Promise<void> {
    if (!this.statsCollector) return;
    const metrics = this.statsCollector();
    if (metrics.length > 0) {
      await this.publishNodeData(metrics);
    }
  }

  private nextSeq(): number {
    return (this.seq + 1) % 256;
  }

  private extractMetricNames(metrics: Metric[]): string[] {
    const names: string[] = [];
    for (const metric of metrics) {
      for (const fieldName of metric.fields.keys()) {
        const fullName = metric.name === fieldName ? fieldName : `${metric.name}/${fieldName}`;
        names.push(fullName);
      }
    }
    return names;
  }
}
