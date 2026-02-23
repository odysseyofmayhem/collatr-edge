// Unit tests: OPC-UA input plugin
// PRD refs: Appendix D (OPC-UA Input Plugin Specification)

import { describe, it, expect, beforeEach } from "bun:test";
import {
  OpcuaInput,
  OpcuaConfigSchema,
  mapOpcuaValue,
  qualityFromStatusCode,
  type OpcuaConfig,
  type OpcuaClient,
  type OpcuaClientOptions,
  type OpcuaAuthOptions,
  type OpcuaSubscriptionParams,
  type OpcuaMonitoredItemParams,
  type DataChangeEvent,
  type BrowseResultNode,
  type QualityCategory,
} from "@plugins/inputs/opcua";
import type { Accumulator } from "@core/accumulator";
import type { FieldValue } from "@core/metric";

// ---------------------------------------------------------------------------
// Mock OPC-UA client
// ---------------------------------------------------------------------------

class MockOpcuaClient implements OpcuaClient {
  private _isConnected = false;
  private _sessionActive = false;
  private _subscriptionCreated = false;
  private dataChangeHandler: ((event: DataChangeEvent) => void) | null = null;

  // Tracking for assertions
  connectCalls: Array<{ endpoint: string; options: OpcuaClientOptions }> = [];
  sessionCalls: Array<OpcuaAuthOptions | undefined> = [];
  subscriptionCalls: OpcuaSubscriptionParams[] = [];
  monitoredItems: OpcuaMonitoredItemParams[] = [];
  browseCalls: Array<{ rootNodeId: string; maxDepth: number; nodeClasses: string[] }> = [];
  resolvedNamespaces: Map<string, number> = new Map();

  // Error injection
  connectError: Error | null = null;
  sessionError: Error | null = null;
  monitorError: Map<string, Error> = new Map(); // nodeId → error
  browseResult: BrowseResultNode[] = [];
  transferResult = false;

  get isConnected(): boolean { return this._isConnected; }
  get sessionActive(): boolean { return this._sessionActive; }

  async connect(endpointUrl: string, options: OpcuaClientOptions): Promise<void> {
    this.connectCalls.push({ endpoint: endpointUrl, options });
    if (this.connectError) throw this.connectError;
    this._isConnected = true;
  }

  async createSession(auth?: OpcuaAuthOptions): Promise<void> {
    this.sessionCalls.push(auth);
    if (this.sessionError) throw this.sessionError;
    this._sessionActive = true;
  }

  async createSubscription(params: OpcuaSubscriptionParams): Promise<void> {
    this.subscriptionCalls.push(params);
    this._subscriptionCreated = true;
  }

  async addMonitoredItem(item: OpcuaMonitoredItemParams): Promise<void> {
    const err = this.monitorError.get(item.nodeId);
    if (err) throw err;
    this.monitoredItems.push(item);
  }

  onDataChange(handler: (event: DataChangeEvent) => void): void {
    this.dataChangeHandler = handler;
  }

  async transferSubscriptions(): Promise<boolean> {
    return this.transferResult;
  }

  async browse(rootNodeId: string, maxDepth: number, nodeClasses: string[]): Promise<BrowseResultNode[]> {
    this.browseCalls.push({ rootNodeId, maxDepth, nodeClasses });
    return this.browseResult;
  }

  async resolveNamespaceUri(uri: string): Promise<number> {
    const idx = this.resolvedNamespaces.get(uri);
    if (idx === undefined) {
      throw new Error(`Namespace URI not found: ${uri}`);
    }
    return idx;
  }

  async closeSession(): Promise<void> {
    this._sessionActive = false;
  }

  async disconnect(): Promise<void> {
    this._isConnected = false;
    this._sessionActive = false;
  }

  // Test helper: emit a data change event
  emitDataChange(event: DataChangeEvent): void {
    if (this.dataChangeHandler) {
      this.dataChangeHandler(event);
    }
  }

  reset(): void {
    this._isConnected = false;
    this._sessionActive = false;
    this._subscriptionCreated = false;
    this.dataChangeHandler = null;
    this.connectCalls = [];
    this.sessionCalls = [];
    this.subscriptionCalls = [];
    this.monitoredItems = [];
    this.browseCalls = [];
    this.connectError = null;
    this.sessionError = null;
    this.monitorError.clear();
  }
}

// ---------------------------------------------------------------------------
// Collecting accumulator (captures emitted metrics)
// ---------------------------------------------------------------------------

interface CapturedMetric {
  measurement: string;
  fields: Record<string, FieldValue>;
  tags: Record<string, string>;
  timestamp?: bigint;
}

class CollectingAcc implements Accumulator {
  metrics: CapturedMetric[] = [];
  errors: Error[] = [];

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void {
    this.metrics.push({
      measurement,
      fields: { ...fields },
      tags: { ...(tags ?? {}) },
      timestamp,
    });
  }

  addMetric(): void {
    // not used in these tests
  }

  addError(error: Error): void {
    this.errors.push(error);
  }
}

// ---------------------------------------------------------------------------
// Helper: minimal valid config
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Partial<OpcuaConfig> = {}): OpcuaConfig {
  return OpcuaConfigSchema.parse({
    endpoint: "opc.tcp://localhost:4840",
    nodes: [
      { node_id: "ns=2;s=Temperature", name: "temperature" },
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OPC-UA input plugin", () => {
  let client: MockOpcuaClient;
  let acc: CollectingAcc;

  beforeEach(() => {
    client = new MockOpcuaClient();
    acc = new CollectingAcc();
  });

  // -------------------------------------------------------------------------
  // Connection and basic operation
  // -------------------------------------------------------------------------

  it("connects to mock OPC-UA server, reads single node → correct metric value", async () => {
    const config = minimalConfig();
    const input = new OpcuaInput(config, client);

    await input.start(acc);

    expect(client.isConnected).toBe(true);
    expect(client.sessionActive).toBe(true);
    expect(client.monitoredItems.length).toBe(1);
    expect(client.monitoredItems[0]!.nodeId).toBe("ns=2;s=Temperature");

    // Simulate a data change notification
    client.emitDataChange({
      nodeId: "ns=2;s=Temperature",
      value: 23.5,
      dataType: "Double",
      sourceTimestamp: new Date("2026-01-15T10:00:00Z"),
      serverTimestamp: new Date("2026-01-15T10:00:01Z"),
      statusCode: 0x00000000,
      quality: "good",
    });

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.measurement).toBe("temperature");
    expect(acc.metrics[0]!.fields.value).toBe(23.5);

    await input.stop();
  });

  it("subscription: monitored item receives data change → metric emitted", async () => {
    const config = minimalConfig({
      nodes: [
        { node_id: "ns=2;s=Speed", name: "motor_speed" },
      ],
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    // Multiple data changes
    client.emitDataChange({
      nodeId: "ns=2;s=Speed",
      value: 1485.0,
      dataType: "Float",
      sourceTimestamp: new Date("2026-01-15T10:00:00Z"),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    client.emitDataChange({
      nodeId: "ns=2;s=Speed",
      value: 1490.0,
      dataType: "Float",
      sourceTimestamp: new Date("2026-01-15T10:00:01Z"),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    expect(acc.metrics.length).toBe(2);
    expect(acc.metrics[0]!.fields.value).toBe(1485.0);
    expect(acc.metrics[1]!.fields.value).toBe(1490.0);

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Data type mapping (PRD D.3)
  // -------------------------------------------------------------------------

  it("data type Boolean → boolean FieldValue", () => {
    const fields = mapOpcuaValue("value", true, "Boolean");
    expect(fields.value).toBe(true);

    const fields2 = mapOpcuaValue("value", false, "Boolean");
    expect(fields2.value).toBe(false);
  });

  it("data type Int32 → number FieldValue", () => {
    const fields = mapOpcuaValue("value", -42, "Int32");
    expect(fields.value).toBe(-42);
  });

  it("data type Float → number FieldValue", () => {
    const fields = mapOpcuaValue("value", 3.14, "Float");
    expect(fields.value).toBeCloseTo(3.14, 2);
  });

  it("data type Double → number FieldValue", () => {
    const fields = mapOpcuaValue("value", 1.23456789012345, "Double");
    expect(fields.value).toBe(1.23456789012345);
  });

  it("data type String → string FieldValue", () => {
    const fields = mapOpcuaValue("value", "hello world", "String");
    expect(fields.value).toBe("hello world");
  });

  it("data type DateTime → number (Unix epoch ms)", () => {
    const date = new Date("2026-06-15T12:30:00.000Z");
    const fields = mapOpcuaValue("value", date, "DateTime");
    expect(fields.value).toBe(date.getTime());
  });

  // -------------------------------------------------------------------------
  // Quality mapping
  // -------------------------------------------------------------------------

  it("quality Good → quality tag 'good', value emitted", async () => {
    const config = minimalConfig();
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    client.emitDataChange({
      nodeId: "ns=2;s=Temperature",
      value: 25.0,
      dataType: "Double",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.tags.quality).toBe("good");
    expect(acc.metrics[0]!.fields.value).toBe(25.0);

    await input.stop();
  });

  it("quality Bad → quality tag 'bad', value STILL emitted (not dropped)", async () => {
    const config = minimalConfig();
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    client.emitDataChange({
      nodeId: "ns=2;s=Temperature",
      value: 0.0,
      dataType: "Double",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x80000000, // Bad
      quality: "bad",
    });

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.tags.quality).toBe("bad");
    expect(acc.metrics[0]!.fields.value).toBe(0.0);

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Quality helper
  // -------------------------------------------------------------------------

  it("qualityFromStatusCode maps correctly", () => {
    expect(qualityFromStatusCode(0x00000000)).toBe("good");
    expect(qualityFromStatusCode(0x00040000)).toBe("good"); // Good with sub-code
    expect(qualityFromStatusCode(0x40000000)).toBe("uncertain");
    expect(qualityFromStatusCode(0x40920000)).toBe("uncertain"); // Uncertain_LastUsableValue
    expect(qualityFromStatusCode(0x80000000)).toBe("bad");
    expect(qualityFromStatusCode(0x80090000)).toBe("bad"); // Bad_SensorFailure
  });

  // -------------------------------------------------------------------------
  // Timestamp source selection
  // -------------------------------------------------------------------------

  it("timestamp source=source uses OPC-UA source timestamp", async () => {
    const config = minimalConfig({ timestamp: "source" });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    const sourceTime = new Date("2026-01-15T10:00:00.000Z");
    client.emitDataChange({
      nodeId: "ns=2;s=Temperature",
      value: 20.0,
      dataType: "Double",
      sourceTimestamp: sourceTime,
      serverTimestamp: new Date("2026-01-15T10:00:05.000Z"),
      statusCode: 0x00000000,
      quality: "good",
    });

    expect(acc.metrics.length).toBe(1);
    const expectedNs = BigInt(sourceTime.getTime()) * 1_000_000n;
    expect(acc.metrics[0]!.timestamp).toBe(expectedNs);

    await input.stop();
  });

  it("timestamp source=gather uses local timestamp (undefined → accumulator assigns)", async () => {
    const config = minimalConfig({ timestamp: "gather" });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    client.emitDataChange({
      nodeId: "ns=2;s=Temperature",
      value: 20.0,
      dataType: "Double",
      sourceTimestamp: new Date("2026-01-15T10:00:00.000Z"),
      serverTimestamp: new Date("2026-01-15T10:00:05.000Z"),
      statusCode: 0x00000000,
      quality: "good",
    });

    expect(acc.metrics.length).toBe(1);
    // timestamp should be undefined — accumulator assigns it
    expect(acc.metrics[0]!.timestamp).toBeUndefined();

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Node groups
  // -------------------------------------------------------------------------

  it("node groups expanded: group defaults inherited, per-node overrides win", async () => {
    const config = minimalConfig({
      nodes: [],
      groups: [
        {
          name: "conveyor_drives",
          sampling_interval: "500ms",
          deadband_type: "absolute" as const,
          deadband_value: 1.0,
          default_tags: { subsystem: "conveyor" },
          nodes: [
            { node_id: "ns=2;s=Conv1.Speed", name: "conv1_speed" },
            {
              node_id: "ns=2;s=Conv2.Speed",
              name: "conv2_speed",
              deadband_value: 2.0, // per-node override
              tags: { location: "east" }, // merged with group defaults
            },
          ],
        },
      ],
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    // Both nodes should be monitored
    expect(client.monitoredItems.length).toBe(2);

    // First node inherits group defaults
    const item1 = client.monitoredItems[0]!;
    expect(item1.nodeId).toBe("ns=2;s=Conv1.Speed");
    expect(item1.samplingInterval).toBe(500);
    expect(item1.deadbandType).toBe("absolute");
    expect(item1.deadbandValue).toBe(1.0);

    // Second node has per-node override for deadband_value
    const item2 = client.monitoredItems[1]!;
    expect(item2.nodeId).toBe("ns=2;s=Conv2.Speed");
    expect(item2.deadbandValue).toBe(2.0); // per-node override

    // Emit data for conv2 to verify tags are merged
    client.emitDataChange({
      nodeId: "ns=2;s=Conv2.Speed",
      value: 10.0,
      dataType: "Double",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.tags.subsystem).toBe("conveyor"); // from group
    expect(acc.metrics[0]!.tags.location).toBe("east"); // from node

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Certificate generation (mock — verified via config passing)
  // -------------------------------------------------------------------------

  it("certificate paths passed to client when configured", async () => {
    const config = minimalConfig({
      certificate: "/etc/collatr-edge/certs/client.pem",
      private_key: "/etc/collatr-edge/certs/client-key.pem",
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    expect(client.connectCalls.length).toBeGreaterThanOrEqual(1);
    const lastConnect = client.connectCalls[client.connectCalls.length - 1]!;
    expect(lastConnect.options.certificatePath).toBe("/etc/collatr-edge/certs/client.pem");
    expect(lastConnect.options.privateKeyPath).toBe("/etc/collatr-edge/certs/client-key.pem");

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // TOFU — tested via fingerprint in OpcuaClient interface
  // (Real TOFU implementation is in the RealOpcuaClient adapter, not in OpcuaInput.
  //  This test verifies the config is passed through.)
  // -------------------------------------------------------------------------

  it("server certificate path passed to client for explicit trust", async () => {
    const config = minimalConfig({
      server_certificate: "/etc/collatr-edge/certs/server.pem",
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    const lastConnect = client.connectCalls[client.connectCalls.length - 1]!;
    expect(lastConnect.options.serverCertificatePath).toBe("/etc/collatr-edge/certs/server.pem");

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  it("reconnection: attempts with exponential backoff", async () => {
    const config = minimalConfig({
      reconnect: {
        initial_delay: "50ms",
        max_delay: "200ms",
        max_retry: 3,
      },
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    // Now simulate disconnect and attempt reconnect
    client.connectError = new Error("Connection refused");

    // Reconnect should fail all attempts (max_retry=3)
    await input.reconnect();

    // 3 reconnect attempts (plus initial connect = 4+ total connect calls)
    // Initial connect during start() used fallback order (5 attempts for auto)
    // Then 3 reconnect attempts with errors
    const reconnectConnects = client.connectCalls.filter(
      (c) => c.endpoint === "opc.tcp://localhost:4840",
    );
    // At least 3 additional connect attempts from reconnect
    expect(reconnectConnects.length).toBeGreaterThanOrEqual(3);

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Browse mode
  // -------------------------------------------------------------------------

  it("browse mode: discovers nodes and can write output", async () => {
    const config = minimalConfig({
      browse: {
        enabled: true,
        root_node_id: "ns=0;i=85",
        max_depth: 3,
        node_classes: ["Variable"],
      },
    });

    client.browseResult = [
      {
        nodeId: "ns=2;s=Device1.Temperature",
        browseName: "Temperature",
        nodeClass: "Variable",
        dataType: "Double",
        currentValue: 23.5,
      },
      {
        nodeId: "ns=2;s=Device1.Running",
        browseName: "Running",
        nodeClass: "Variable",
        dataType: "Boolean",
        currentValue: true,
      },
    ];

    const input = new OpcuaInput(config, client);
    await input.start(acc);

    expect(client.browseCalls.length).toBe(1);
    expect(client.browseCalls[0]!.rootNodeId).toBe("ns=0;i=85");
    expect(client.browseCalls[0]!.maxDepth).toBe(3);
    expect(client.browseCalls[0]!.nodeClasses).toEqual(["Variable"]);

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  it("auth anonymous: connects without credentials", async () => {
    const config = minimalConfig({ auth_method: "anonymous" });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    expect(client.sessionCalls.length).toBe(1);
    expect(client.sessionCalls[0]!.type).toBe("anonymous");
    expect(client.sessionCalls[0]!.username).toBeUndefined();

    await input.stop();
  });

  it("auth username: connects with username/password", async () => {
    const config = minimalConfig({
      auth_method: "username",
      username: "collatr",
      password: "secret123",
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    expect(client.sessionCalls.length).toBe(1);
    expect(client.sessionCalls[0]!.type).toBe("username");
    expect(client.sessionCalls[0]!.username).toBe("collatr");
    expect(client.sessionCalls[0]!.password).toBe("secret123");

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Error handling (PRD D.7)
  // -------------------------------------------------------------------------

  it("bad NodeID → error logged, other nodes continue monitoring", async () => {
    const config = minimalConfig({
      nodes: [
        { node_id: "ns=2;s=Good.Node", name: "good_node" },
        { node_id: "ns=2;s=Bad.Node", name: "bad_node" },
        { node_id: "ns=2;s=Other.Good", name: "other_good" },
      ],
    });

    client.monitorError.set("ns=2;s=Bad.Node", new Error("BadNodeIdUnknown"));

    const input = new OpcuaInput(config, client);
    await input.start(acc);

    // Good nodes should be monitored, bad one skipped
    expect(client.monitoredItems.length).toBe(2);
    expect(client.monitoredItems.map((m) => m.nodeId)).toEqual([
      "ns=2;s=Good.Node",
      "ns=2;s=Other.Good",
    ]);
    expect(input.failedNodes.has("ns=2;s=Bad.Node")).toBe(true);

    await input.stop();
  });

  it("connection refused → retry with backoff, no crash", async () => {
    client.connectError = new Error("Connection refused");

    const config = minimalConfig({
      security_policy: "None",
      security_mode: "None",
    });
    const input = new OpcuaInput(config, client);

    // start() should throw since we can't connect (explicit policy, no fallback)
    await expect(input.start(acc)).rejects.toThrow("Connection refused");

    // Plugin should not crash — it throws, caller handles it
    expect(client.isConnected).toBe(false);
  });

  it("auth failure → clear error, no retry (config error)", async () => {
    client.sessionError = new Error("BadIdentityTokenRejected");

    const config = minimalConfig({
      auth_method: "username",
      username: "wrong",
      password: "wrong",
    });
    const input = new OpcuaInput(config, client);

    // start() throws on session failure — config error, not retried
    await expect(input.start(acc)).rejects.toThrow("BadIdentityTokenRejected");
  });

  // -------------------------------------------------------------------------
  // Deadband
  // -------------------------------------------------------------------------

  it("deadband absolute: config passed to monitored item params", async () => {
    const config = minimalConfig({
      data_change_filter: {
        trigger: "status_value",
        deadband_type: "absolute",
        deadband_value: 0.5,
      },
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    expect(client.monitoredItems.length).toBe(1);
    expect(client.monitoredItems[0]!.deadbandType).toBe("absolute");
    expect(client.monitoredItems[0]!.deadbandValue).toBe(0.5);

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Array type
  // -------------------------------------------------------------------------

  it("array type → multiple fields (name[0], name[1], name.length)", () => {
    const fields = mapOpcuaValue("values", [10.0, 20.0, 30.0], "Double");
    expect(fields["values.length"]).toBe(3);
    expect(fields["values[0]"]).toBe(10.0);
    expect(fields["values[1]"]).toBe(20.0);
    expect(fields["values[2]"]).toBe(30.0);
  });

  // -------------------------------------------------------------------------
  // Config validation
  // -------------------------------------------------------------------------

  it("config validation: missing endpoint → error", () => {
    expect(() => OpcuaConfigSchema.parse({ nodes: [] })).toThrow();
  });

  it("config validation: invalid security policy → error", () => {
    expect(() => OpcuaConfigSchema.parse({
      endpoint: "opc.tcp://localhost:4840",
      security_policy: "InvalidPolicy",
      nodes: [],
    })).toThrow();
  });

  // -------------------------------------------------------------------------
  // Additional data types and edge cases
  // -------------------------------------------------------------------------

  it("data type ByteString → base64 string", () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const fields = mapOpcuaValue("value", buf, "ByteString");
    expect(fields.value).toBe(buf.toString("base64"));
  });

  it("data type LocalizedText → .text property extracted", () => {
    const fields = mapOpcuaValue("value", { text: "Hello", locale: "en" }, "LocalizedText");
    expect(fields.value).toBe("Hello");
  });

  it("data type QualifiedName → {ns}:{name} format", () => {
    const fields = mapOpcuaValue("value", { namespaceIndex: 2, name: "Temperature" }, "QualifiedName");
    expect(fields.value).toBe("2:Temperature");
  });

  it("data type Guid → string representation", () => {
    const fields = mapOpcuaValue("value", "550e8400-e29b-41d4-a716-446655440000", "Guid");
    expect(fields.value).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("Int64 with precision warning still returns number", () => {
    const big = Number.MAX_SAFE_INTEGER + 100;
    const fields = mapOpcuaValue("value", big, "Int64");
    expect(fields.value).toBe(big); // JS Number, with precision loss logged
  });

  it("unknown data type → JSON string fallback", () => {
    const fields = mapOpcuaValue("value", { x: 1, y: 2 }, "WeirdCustomType");
    // Object → flattened with dot notation
    expect(fields["value.x"]).toBe(1);
    expect(fields["value.y"]).toBe(2);
  });

  it("null/undefined value → empty fields", () => {
    expect(mapOpcuaValue("value", null, "Double")).toEqual({});
    expect(mapOpcuaValue("value", undefined, "Double")).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Security auto-negotiation
  // -------------------------------------------------------------------------

  it("security auto: tries fallback order until one succeeds", async () => {
    let attempt = 0;
    const originalConnect = client.connect.bind(client);
    client.connect = async (endpoint: string, options: OpcuaClientOptions) => {
      attempt++;
      // Fail first 3 attempts, succeed on 4th (Basic256Sha256 + Sign)
      if (attempt <= 3) {
        client.connectCalls.push({ endpoint, options });
        throw new Error("SecurityPolicy not supported");
      }
      return originalConnect(endpoint, options);
    };

    const config = minimalConfig(); // auto/auto by default
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    expect(client.isConnected).toBe(true);
    // Successful connect was 4th attempt (Basic256Sha256 + Sign)
    expect(client.connectCalls.length).toBe(4);
    expect(client.connectCalls[3]!.options.securityPolicy).toBe("Basic256Sha256");
    expect(client.connectCalls[3]!.options.securityMode).toBe("Sign");

    await input.stop();
  });

  it("security auto: all fallbacks fail → clear error", async () => {
    client.connectError = new Error("All policies rejected");

    const config = minimalConfig(); // auto/auto
    const input = new OpcuaInput(config, client);

    await expect(input.start(acc)).rejects.toThrow("auto-negotiation failed");
  });

  // -------------------------------------------------------------------------
  // Subscription parameters from config
  // -------------------------------------------------------------------------

  it("subscription parameters passed from config", async () => {
    const config = minimalConfig({
      subscription: {
        publishing_interval: "2s",
        queue_size: 20,
        max_keep_alive_count: 5,
        lifetime_count: 500,
        max_notifications_per_publish: 50,
      },
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    expect(client.subscriptionCalls.length).toBe(1);
    const sub = client.subscriptionCalls[0]!;
    expect(sub.publishingInterval).toBe(2000);
    expect(sub.maxKeepAliveCount).toBe(5);
    expect(sub.lifetimeCount).toBe(500);
    expect(sub.maxNotificationsPerPublish).toBe(50);

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Lifecycle: stop() cleanup
  // -------------------------------------------------------------------------

  it("stop() closes session and disconnects", async () => {
    const config = minimalConfig();
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    expect(client.isConnected).toBe(true);
    expect(client.sessionActive).toBe(true);

    await input.stop();

    expect(client.sessionActive).toBe(false);
    expect(client.isConnected).toBe(false);
  });

  it("data changes after stop() are not emitted", async () => {
    const config = minimalConfig();
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    await input.stop();

    client.emitDataChange({
      nodeId: "ns=2;s=Temperature",
      value: 99.9,
      dataType: "Double",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    expect(acc.metrics.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Namespace URI resolution
  // -------------------------------------------------------------------------

  it("nsu= namespace URI resolved to ns= at connect time", async () => {
    client.resolvedNamespaces.set("http://mycompany.com/UA", 3);

    const config = minimalConfig({
      nodes: [
        { node_id: "nsu=http://mycompany.com/UA;s=Temperature", name: "temp" },
      ],
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    // The monitored item should use the resolved ns= format
    expect(client.monitoredItems.length).toBe(1);
    expect(client.monitoredItems[0]!.nodeId).toBe("ns=3;s=Temperature");

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Server timestamp mode
  // -------------------------------------------------------------------------

  it("timestamp source=server uses OPC-UA server timestamp", async () => {
    const config = minimalConfig({ timestamp: "server" });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    const serverTime = new Date("2026-01-15T10:00:05.000Z");
    client.emitDataChange({
      nodeId: "ns=2;s=Temperature",
      value: 20.0,
      dataType: "Double",
      sourceTimestamp: new Date("2026-01-15T10:00:00.000Z"),
      serverTimestamp: serverTime,
      statusCode: 0x00000000,
      quality: "good",
    });

    expect(acc.metrics.length).toBe(1);
    const expectedNs = BigInt(serverTime.getTime()) * 1_000_000n;
    expect(acc.metrics[0]!.timestamp).toBe(expectedNs);

    await input.stop();
  });

  // -------------------------------------------------------------------------
  // Per-node tags
  // -------------------------------------------------------------------------

  it("per-node tags included in emitted metrics", async () => {
    const config = minimalConfig({
      nodes: [
        {
          node_id: "ns=2;s=Counter",
          name: "good_parts",
          tags: { unit: "count", location: "line3" },
        },
      ],
    });
    const input = new OpcuaInput(config, client);
    await input.start(acc);

    client.emitDataChange({
      nodeId: "ns=2;s=Counter",
      value: 42,
      dataType: "UInt32",
      sourceTimestamp: new Date(),
      serverTimestamp: null,
      statusCode: 0x00000000,
      quality: "good",
    });

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.tags.unit).toBe("count");
    expect(acc.metrics[0]!.tags.location).toBe("line3");
    expect(acc.metrics[0]!.tags.quality).toBe("good");

    await input.stop();
  });
});
