// CollatrEdge — OPC-UA input plugin (ServiceInput)
// PRD refs: Appendix D (OPC-UA Input Plugin Specification), §6 Plugin System
// ──────────────────────────────────────────────────────────────────────
// SAFETY: CollatrEdge is READ-ONLY. OPC-UA write services are not
// implemented and MUST NOT be added. Input plugins never modify PLC state.
// ──────────────────────────────────────────────────────────────────────

import { z } from "zod/v4";
import type { ServiceInput } from "../../core/plugin-types";
import type { Accumulator } from "../../core/accumulator";
import { getLogger } from "../../core/logger";
import { parseDuration } from "../../core/config";
import type { FieldValue } from "../../core/metric";

// ---------------------------------------------------------------------------
// Zod config schema — matches PRD Appendix D §D.1 exactly
// ---------------------------------------------------------------------------

const OpcuaNodeSchema = z.object({
  node_id: z.string(),
  name: z.string(),
  sampling_interval: z.string().optional(),
  deadband_type: z.enum(["none", "absolute", "percent"]).optional(),
  deadband_value: z.number().optional(),
  queue_size: z.number().int().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const OpcuaGroupSchema = z.object({
  name: z.string().describe("Group name (used as measurement name if set)"),
  namespace: z.string().optional()
    .describe("Default namespace for nodes in this group"),
  sampling_interval: z.string().optional(),
  deadband_type: z.enum(["none", "absolute", "percent"]).optional(),
  deadband_value: z.number().optional(),
  default_tags: z.record(z.string(), z.string()).optional(),
  nodes: z.array(OpcuaNodeSchema),
});

export const OpcuaConfigSchema = z.object({
  // Connection
  endpoint: z.string()
    .describe("OPC-UA server endpoint (e.g., opc.tcp://192.168.1.50:4840)"),
  connect_timeout: z.string().default("10s"),
  request_timeout: z.string().default("5s"),
  session_timeout: z.string().default("30m"),

  // Security
  security_policy: z.enum([
    "None", "Basic256Sha256", "Aes128_Sha256_RsaOaep",
    "Aes256_Sha256_RsaPss", "auto",
  ]).default("auto"),
  security_mode: z.enum(["None", "Sign", "SignAndEncrypt", "auto"]).default("auto"),

  // Client certificate
  certificate: z.string().optional()
    .describe("Path to client certificate (PEM or DER)"),
  private_key: z.string().optional()
    .describe("Path to client private key (PEM)"),

  // Server certificate trust
  server_certificate: z.string().optional()
    .describe("Path to explicitly trusted server certificate (PEM or DER)"),

  // Authentication
  auth_method: z.enum(["anonymous", "username", "certificate"]).default("anonymous"),
  username: z.string().optional(),
  password: z.string().optional()
    .describe("Plaintext or secret ref: @{secrets:opc_password}"),

  // Subscription parameters
  // NOTE: Zod v4 .default({}) does not apply inner field defaults, so we
  // must provide the full default object explicitly.
  subscription: z.object({
    publishing_interval: z.string().default("1s"),
    queue_size: z.number().int().min(1).default(10),
    max_keep_alive_count: z.number().int().min(1).default(10),
    lifetime_count: z.number().int().min(3).default(1000),
    max_notifications_per_publish: z.number().int().min(0).default(100),
  }).default({
    publishing_interval: "1s",
    queue_size: 10,
    max_keep_alive_count: 10,
    lifetime_count: 1000,
    max_notifications_per_publish: 100,
  }),

  // Data change filter
  data_change_filter: z.object({
    trigger: z.enum(["status", "status_value", "status_value_timestamp"])
      .default("status_value"),
    deadband_type: z.enum(["none", "absolute", "percent"]).default("none"),
    deadband_value: z.number().default(0),
  }).default({
    trigger: "status_value",
    deadband_type: "none",
    deadband_value: 0,
  }),

  // Timestamp source
  timestamp: z.enum(["source", "server", "gather"]).default("source"),

  // Reconnection
  reconnect: z.object({
    initial_delay: z.string().default("1s"),
    max_delay: z.string().default("30s"),
    max_retry: z.number().int().min(0).default(0)
      .describe("0 = retry forever"),
  }).default({
    initial_delay: "1s",
    max_delay: "30s",
    max_retry: 0,
  }),

  // Browse
  browse: z.object({
    enabled: z.boolean().default(false),
    root_node_id: z.string().default("ns=0;i=85")
      .describe("ObjectsFolder by default"),
    max_depth: z.number().int().min(1).default(5),
    node_classes: z.array(z.enum(["Variable", "Object"])).default(["Variable"]),
    output_file: z.string().optional()
      .describe("Path to write discovered nodes as TOML snippet"),
  }).default({
    enabled: false,
    root_node_id: "ns=0;i=85",
    max_depth: 5,
    node_classes: ["Variable"],
  }),

  // Nodes to monitor
  nodes: z.array(OpcuaNodeSchema),

  // Node groups
  groups: z.array(OpcuaGroupSchema).optional(),
});

export type OpcuaConfig = z.infer<typeof OpcuaConfigSchema>;
export type OpcuaNodeConfig = z.infer<typeof OpcuaNodeSchema>;

// ---------------------------------------------------------------------------
// Expanded node (after group inheritance)
// ---------------------------------------------------------------------------

interface ExpandedNode {
  node_id: string;
  name: string;
  measurement: string; // group name or node name
  sampling_interval_ms: number; // -1 = server default
  deadband_type: "none" | "absolute" | "percent";
  deadband_value: number;
  queue_size: number;
  tags: Record<string, string>;
}

// ---------------------------------------------------------------------------
// OPC-UA client interface (for dependency injection / testing)
// ---------------------------------------------------------------------------

/** Quality category derived from OPC-UA StatusCode. */
export type QualityCategory = "good" | "uncertain" | "bad";

/** A data change notification from a monitored item. */
export interface DataChangeEvent {
  nodeId: string;
  value: unknown;
  dataType: string;
  sourceTimestamp: Date | null;
  serverTimestamp: Date | null;
  statusCode: number;
  quality: QualityCategory;
}

/** Browse result for a single node. */
export interface BrowseResultNode {
  nodeId: string;
  browseName: string;
  nodeClass: string;
  dataType?: string;
  currentValue?: unknown;
}

/**
 * Abstraction over node-opcua for testability.
 * Tests inject a mock; production uses RealOpcuaClient.
 */
export interface OpcuaClient {
  connect(endpointUrl: string, options: OpcuaClientOptions): Promise<void>;
  createSession(auth?: OpcuaAuthOptions): Promise<void>;
  createSubscription(params: OpcuaSubscriptionParams): Promise<void>;
  addMonitoredItem(item: OpcuaMonitoredItemParams): Promise<void>;
  onDataChange(handler: (event: DataChangeEvent) => void): void;
  onClose(handler: () => void): void;
  transferSubscriptions(): Promise<boolean>;
  browse(rootNodeId: string, maxDepth: number, nodeClasses: string[]): Promise<BrowseResultNode[]>;
  resolveNamespaceUri(uri: string): Promise<number>;
  closeSession(): Promise<void>;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;
  readonly sessionActive: boolean;
}

export interface OpcuaClientOptions {
  securityPolicy: string;
  securityMode: string;
  connectTimeout: number;
  requestTimeout: number;
  sessionTimeout: number;
  certificatePath?: string;
  privateKeyPath?: string;
  serverCertificatePath?: string;
}

export interface OpcuaAuthOptions {
  type: "anonymous" | "username" | "certificate";
  username?: string;
  password?: string;
}

export interface OpcuaSubscriptionParams {
  publishingInterval: number;
  maxKeepAliveCount: number;
  lifetimeCount: number;
  maxNotificationsPerPublish: number;
}

export interface OpcuaMonitoredItemParams {
  nodeId: string;
  samplingInterval: number;
  queueSize: number;
  deadbandType: "none" | "absolute" | "percent";
  deadbandValue: number;
}

// ---------------------------------------------------------------------------
// Security auto-negotiation fallback order (PRD Appendix D §D.1)
// ---------------------------------------------------------------------------

const SECURITY_FALLBACK_ORDER: Array<{ policy: string; mode: string }> = [
  { policy: "Basic256Sha256", mode: "SignAndEncrypt" },
  { policy: "Aes128_Sha256_RsaOaep", mode: "SignAndEncrypt" },
  { policy: "Aes256_Sha256_RsaPss", mode: "SignAndEncrypt" },
  { policy: "Basic256Sha256", mode: "Sign" },
  { policy: "None", mode: "None" },
];

// ---------------------------------------------------------------------------
// Data type mapping (PRD Appendix D §D.3)
// ---------------------------------------------------------------------------

/** Map OPC-UA value to FieldValue(s). Returns fields to emit. */
export function mapOpcuaValue(
  name: string,
  value: unknown,
  dataType: string,
): Record<string, FieldValue> {
  if (value === null || value === undefined) {
    return {};
  }

  // Array types → name[0], name[1], ..., name.length
  if (Array.isArray(value)) {
    const fields: Record<string, FieldValue> = {};
    fields[`${name}.length`] = value.length;
    for (let i = 0; i < value.length; i++) {
      const subFields = mapOpcuaValue(`${name}[${i}]`, value[i], dataType);
      Object.assign(fields, subFields);
    }
    return fields;
  }

  // Scalar mappings
  switch (dataType) {
    case "Boolean":
      return { [name]: Boolean(value) };

    case "SByte":
    case "Int16":
    case "Int32":
    case "Byte":
    case "UInt16":
    case "UInt32":
    case "Float":
    case "Double":
      return { [name]: Number(value) };

    case "Int64":
    case "UInt64": {
      const num = Number(value);
      if (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER) {
        getLogger().warn("value exceeds Number.MAX_SAFE_INTEGER — precision loss", { plugin: "opcua", field: name });
      }
      return { [name]: num };
    }

    case "String":
      return { [name]: String(value) };

    case "DateTime": {
      // Convert to Unix epoch milliseconds
      if (value instanceof Date) {
        return { [name]: value.getTime() };
      }
      return { [name]: Number(value) };
    }

    case "ByteString": {
      // Base64-encoded
      if (Buffer.isBuffer(value)) {
        return { [name]: value.toString("base64") };
      }
      return { [name]: String(value) };
    }

    case "Guid":
    case "NodeId":
      return { [name]: String(value) };

    case "StatusCode":
      return { [name]: Number(value) };

    case "LocalizedText": {
      // Extract .text property
      if (typeof value === "object" && value !== null && "text" in value) {
        return { [name]: String((value as { text: unknown }).text ?? "") };
      }
      return { [name]: String(value) };
    }

    case "QualifiedName": {
      // {ns}:{name} format
      if (typeof value === "object" && value !== null) {
        const qn = value as { namespaceIndex?: number; name?: string };
        return { [name]: `${qn.namespaceIndex ?? 0}:${qn.name ?? ""}` };
      }
      return { [name]: String(value) };
    }

    default: {
      // ExtensionObject / Structure → flatten with dot notation
      if (typeof value === "object" && value !== null) {
        return flattenObject(name, value as Record<string, unknown>, 0, 3);
      }
      // Unknown type → JSON string with one-time warning
      getLogger().warn("unmappable data type, emitting as JSON string", { plugin: "opcua", data_type: dataType, field: name });
      return { [name]: JSON.stringify(value) };
    }
  }
}

/** Flatten nested object with dot notation, max depth. */
function flattenObject(
  prefix: string,
  obj: Record<string, unknown>,
  depth: number,
  maxDepth: number,
): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {};
  for (const [key, val] of Object.entries(obj)) {
    const fieldName = `${prefix}.${key}`;
    if (val === null || val === undefined) continue;
    if (typeof val === "object" && !Array.isArray(val) && depth < maxDepth) {
      Object.assign(fields, flattenObject(fieldName, val as Record<string, unknown>, depth + 1, maxDepth));
    } else if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") {
      fields[fieldName] = val;
    } else if (typeof val === "bigint") {
      fields[fieldName] = Number(val);
    } else {
      // Beyond max depth or complex type → JSON string
      fields[fieldName] = JSON.stringify(val);
    }
  }
  return fields;
}

/** Derive quality category from OPC-UA StatusCode value. */
export function qualityFromStatusCode(statusCode: number): QualityCategory {
  // Top 2 bits: 00 = good, 01 = uncertain, 10/11 = bad
  const severity = (statusCode >>> 30) & 0x03;
  if (severity === 0) return "good";
  if (severity === 1) return "uncertain";
  return "bad";
}

// ---------------------------------------------------------------------------
// Node expansion (groups → flat list)
// ---------------------------------------------------------------------------

function expandNodes(config: OpcuaConfig): ExpandedNode[] {
  const defaultSubParams = config.subscription;
  const defaultDeadband = config.data_change_filter;
  const nodes: ExpandedNode[] = [];

  // Direct nodes
  for (const node of config.nodes) {
    nodes.push({
      node_id: node.node_id,
      name: node.name,
      measurement: node.name,
      sampling_interval_ms: node.sampling_interval
        ? parseDuration(node.sampling_interval)
        : -1,
      deadband_type: node.deadband_type ?? defaultDeadband.deadband_type,
      deadband_value: node.deadband_value ?? defaultDeadband.deadband_value,
      queue_size: node.queue_size ?? defaultSubParams.queue_size,
      tags: node.tags ?? {},
    });
  }

  // Group nodes — inherit group defaults, per-node overrides win
  if (config.groups) {
    for (const group of config.groups) {
      for (const node of group.nodes) {
        // Resolve node_id: prepend group namespace if node_id doesn't already have one
        let resolvedNodeId = node.node_id;
        if (group.namespace && !node.node_id.startsWith("ns=") && !node.node_id.startsWith("nsu=")) {
          resolvedNodeId = `${group.namespace}${node.node_id}`;
        }

        nodes.push({
          node_id: resolvedNodeId,
          name: node.name,
          measurement: group.name,
          sampling_interval_ms: node.sampling_interval
            ? parseDuration(node.sampling_interval)
            : group.sampling_interval
              ? parseDuration(group.sampling_interval)
              : -1,
          deadband_type: node.deadband_type ?? group.deadband_type ?? defaultDeadband.deadband_type,
          deadband_value: node.deadband_value ?? group.deadband_value ?? defaultDeadband.deadband_value,
          queue_size: node.queue_size ?? defaultSubParams.queue_size,
          tags: { ...(group.default_tags ?? {}), ...(node.tags ?? {}) },
        });
      }
    }
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Namespace URI resolution helper
// ---------------------------------------------------------------------------

const NSU_REGEX = /^nsu=([^;]+);(.+)$/;

async function resolveNodeId(
  nodeId: string,
  client: OpcuaClient,
): Promise<string> {
  const match = nodeId.match(NSU_REGEX);
  if (!match) return nodeId; // Already in ns= format

  const uri = match[1]!;
  const rest = match[2]!;
  const nsIndex = await client.resolveNamespaceUri(uri);
  return `ns=${nsIndex};${rest}`;
}

// ---------------------------------------------------------------------------
// Browse mode helper
// ---------------------------------------------------------------------------

function formatBrowseOutput(
  endpointUrl: string,
  nodes: BrowseResultNode[],
): string {
  const lines: string[] = [
    `# Discovered OPC-UA nodes from ${endpointUrl}`,
    `# Generated ${new Date().toISOString()} — ${nodes.length} nodes found`,
    `# Review and copy desired nodes into your config file.`,
    "",
  ];

  for (const node of nodes) {
    lines.push(`# [[inputs.opcua.nodes]]`);
    lines.push(`#   node_id = "${node.nodeId}"`);
    lines.push(`#   name = "${node.browseName.toLowerCase().replace(/[^a-z0-9_]/g, "_")}"`);

    const meta: string[] = [];
    if (node.dataType) meta.push(`OPC-UA DataType: ${node.dataType}`);
    if (node.currentValue !== undefined) meta.push(`Current value: ${node.currentValue}`);
    if (meta.length > 0) {
      lines.push(`#   # ${meta.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// OpcuaInput — ServiceInput implementation
// ---------------------------------------------------------------------------

export class OpcuaInput implements ServiceInput {
  private config: OpcuaConfig;
  private client: OpcuaClient;
  private acc: Accumulator | null = null;
  private expandedNodes: ExpandedNode[] = [];
  private reconnecting = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Server certificate fingerprint for TOFU. */
  private trustedFingerprint: string | null = null;

  /** Nodes that failed during monitoring setup (bad NodeID etc). */
  readonly failedNodes: Set<string> = new Set();

  constructor(config: OpcuaConfig, client?: OpcuaClient | null) {
    this.config = config;
    // Use injected client or defer to start(). Lazy loading avoids
    // importing node-opcua at construction time (factory instantiation).
    this.client = client ?? (null as unknown as OpcuaClient);
    this.expandedNodes = expandNodes(config);
  }

  // ServiceInput requires gather() but it's a no-op for push-based inputs.
  // Data flows through the subscription callback instead.
  async gather(_acc: Accumulator): Promise<void> {
    // no-op: OPC-UA uses subscription-based push, not polling
  }

  async start(acc: Accumulator): Promise<void> {
    this.acc = acc;
    this.stopped = false;

    // Safety assertion: the plugin factory always provides a RealOpcuaClient,
    // and tests always inject a mock. This should never trigger.
    if (!this.client) {
      throw new Error("OPC-UA client not initialized — this is a bug");
    }

    await this.connectAndSubscribe();
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (this.client.sessionActive) {
        await this.client.closeSession();
      }
      if (this.client.isConnected) {
        await this.client.disconnect();
      }
    } catch (err) {
      getLogger().warn("error during shutdown", { plugin: "opcua", error: (err as Error).message });
    }
  }

  private async connectAndSubscribe(): Promise<void> {
    const config = this.config;

    // Determine security policy and mode
    let secPolicy = config.security_policy;
    let secMode = config.security_mode;

    // Build client options
    const clientOpts: OpcuaClientOptions = {
      securityPolicy: secPolicy,
      securityMode: secMode,
      connectTimeout: parseDuration(config.connect_timeout),
      requestTimeout: parseDuration(config.request_timeout),
      sessionTimeout: parseDuration(config.session_timeout),
      certificatePath: config.certificate,
      privateKeyPath: config.private_key,
      serverCertificatePath: config.server_certificate,
    };

    // Auto-negotiation: try security fallback order
    if (secPolicy === "auto" || secMode === "auto") {
      let connected = false;
      for (const fallback of SECURITY_FALLBACK_ORDER) {
        try {
          const opts = {
            ...clientOpts,
            securityPolicy: secPolicy === "auto" ? fallback.policy : secPolicy,
            securityMode: secMode === "auto" ? fallback.mode : secMode,
          };
          await this.client.connect(config.endpoint, opts);
          connected = true;
          if (fallback.policy === "None") {
            getLogger().warn("connected with security policy None — traffic is not encrypted", { plugin: "opcua" });
          }
          break;
        } catch {
          // Try next fallback
          try { await this.client.disconnect(); } catch { /* ignore */ }
        }
      }

      if (!connected) {
        throw new Error(
          `OPC-UA auto-negotiation failed for ${config.endpoint}. ` +
          "Set security_policy and security_mode explicitly in config.",
        );
      }
    } else {
      await this.client.connect(config.endpoint, clientOpts);
    }

    // Create session with authentication
    const auth: OpcuaAuthOptions = { type: config.auth_method };
    if (config.auth_method === "username") {
      auth.username = config.username;
      auth.password = config.password;
    }
    await this.client.createSession(auth);

    // Resolve nsu= namespace URIs
    for (const node of this.expandedNodes) {
      try {
        node.node_id = await resolveNodeId(node.node_id, this.client);
      } catch (err) {
        getLogger().error("failed to resolve namespace URI", { plugin: "opcua", node_id: node.node_id, error: (err as Error).message });
      }
    }

    // Browse mode
    if (config.browse.enabled) {
      try {
        const browseResults = await this.client.browse(
          config.browse.root_node_id,
          config.browse.max_depth,
          config.browse.node_classes,
        );
        if (config.browse.output_file) {
          const toml = formatBrowseOutput(config.endpoint, browseResults);
          await Bun.write(config.browse.output_file, toml);
          getLogger().info("browse results written", { plugin: "opcua", output_file: config.browse.output_file, node_count: browseResults.length });
        }
      } catch (err) {
        getLogger().warn("browse failed", { plugin: "opcua", error: (err as Error).message });
      }
    }

    // Create subscription
    const pubInterval = parseDuration(config.subscription.publishing_interval);
    await this.client.createSubscription({
      publishingInterval: pubInterval,
      maxKeepAliveCount: config.subscription.max_keep_alive_count,
      lifetimeCount: config.subscription.lifetime_count,
      maxNotificationsPerPublish: config.subscription.max_notifications_per_publish,
    });

    // Register data change handler
    this.client.onDataChange((event: DataChangeEvent) => {
      this.handleDataChange(event);
    });

    // Register connection loss handler — triggers automatic reconnection (F-03)
    this.client.onClose(() => {
      if (!this.stopped) {
        getLogger().warn("connection lost — initiating reconnection", { plugin: "opcua" });
        this.reconnect();
      }
    });

    // Add monitored items for each configured node
    for (const node of this.expandedNodes) {
      try {
        await this.client.addMonitoredItem({
          nodeId: node.node_id,
          samplingInterval: node.sampling_interval_ms,
          queueSize: node.queue_size,
          deadbandType: node.deadband_type,
          deadbandValue: node.deadband_value,
        });
      } catch (err) {
        // Bad NodeID or other monitored item error — skip, log, continue (PRD D.7)
        this.failedNodes.add(node.node_id);
        getLogger().error("failed to monitor node", { plugin: "opcua", node_id: node.node_id, name: node.name, error: (err as Error).message });
      }
    }
  }

  private handleDataChange(event: DataChangeEvent): void {
    if (!this.acc || this.stopped) return;

    // Find the expanded node config for this nodeId
    const node = this.expandedNodes.find((n) => n.node_id === event.nodeId);
    if (!node) return;

    // Map OPC-UA value to fields
    const fields = mapOpcuaValue("value", event.value, event.dataType);
    if (Object.keys(fields).length === 0) return;

    // Determine timestamp based on config
    let timestamp: bigint | undefined;
    switch (this.config.timestamp) {
      case "source":
        if (event.sourceTimestamp) {
          timestamp = BigInt(event.sourceTimestamp.getTime()) * 1_000_000n;
        }
        break;
      case "server":
        if (event.serverTimestamp) {
          timestamp = BigInt(event.serverTimestamp.getTime()) * 1_000_000n;
        }
        break;
      case "gather":
        // Let accumulator assign timestamp (default behaviour)
        timestamp = undefined;
        break;
    }

    // Build tags: quality + per-node tags
    const tags: Record<string, string> = {
      quality: event.quality,
      ...node.tags,
    };

    this.acc.addFields(node.measurement, fields, tags, timestamp);
  }

  /** Reconnect with exponential backoff per PRD Appendix D. */
  async reconnect(): Promise<void> {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;

    const initialDelay = parseDuration(this.config.reconnect.initial_delay);
    const maxDelay = parseDuration(this.config.reconnect.max_delay);
    const maxRetry = this.config.reconnect.max_retry;
    let attempt = 0;
    let delay = initialDelay;

    while (!this.stopped) {
      attempt++;
      if (maxRetry > 0 && attempt > maxRetry) {
        getLogger().error("max reconnect attempts exceeded", { plugin: "opcua", max_retry: maxRetry });
        this.reconnecting = false;
        return;
      }

      getLogger().warn("reconnecting", { plugin: "opcua", delay_ms: delay, attempt });

      await new Promise<void>((resolve) => {
        this.reconnectTimer = setTimeout(resolve, delay);
      });
      this.reconnectTimer = null;

      if (this.stopped) break;

      try {
        // Clean up existing connection
        try { await this.client.disconnect(); } catch { /* ignore */ }

        // Reconnect
        await this.connectAndSubscribe();
        getLogger().info("reconnected successfully", { plugin: "opcua", attempts: attempt });
        this.reconnecting = false;
        return;
      } catch (err) {
        getLogger().warn("reconnect attempt failed", { plugin: "opcua", attempt, error: (err as Error).message });
        delay = Math.min(delay * 2, maxDelay);
      }
    }

    this.reconnecting = false;
  }
}

// ---------------------------------------------------------------------------
// Factory function for plugin registration
// ---------------------------------------------------------------------------

export function createOpcuaInput(rawConfig: unknown, client?: OpcuaClient | null): OpcuaInput {
  const config = OpcuaConfigSchema.parse(rawConfig);
  return new OpcuaInput(config, client);
}
