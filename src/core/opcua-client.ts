// CollatrEdge — RealOpcuaClient adapter (OpcuaClient → node-opcua)
// PRD refs: Appendix D (OPC-UA Input Plugin Specification)
// ──────────────────────────────────────────────────────────────────────
// This adapter bridges the OpcuaClient interface (defined in
// src/plugins/inputs/opcua.ts) to the node-opcua library. Tests inject
// mock OpcuaClient implementations; production uses this RealOpcuaClient,
// instantiated by the plugin factory via lazy require().
// ──────────────────────────────────────────────────────────────────────

import type {
  OpcuaClient,
  OpcuaClientOptions,
  OpcuaAuthOptions,
  OpcuaSubscriptionParams,
  OpcuaMonitoredItemParams,
  DataChangeEvent,
  BrowseResultNode,
  QualityCategory,
} from "../plugins/inputs/opcua";
import { qualityFromStatusCode } from "../plugins/inputs/opcua";
import { getLogger } from "./logger";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Lazy-loaded node-opcua types — these are resolved at runtime when the
// adapter is first instantiated. This file is only loaded when an OPC-UA
// input is configured (via lazy require() in the plugin factory).
// ---------------------------------------------------------------------------

import {
  OPCUAClient,
  type OPCUAClientOptions as NodeOpcuaClientOptions,
  type ClientSession,
  type ClientSubscription,
  type ClientMonitoredItem,
  SecurityPolicy,
  MessageSecurityMode,
  UserTokenType,
  AttributeIds,
  DataType,
  TimestampsToReturn,
  DataChangeFilter,
  DataChangeTrigger,
  DeadbandType,
  BrowseDirection,
  NodeClass,
  type DataValue,
  coerceNodeId,
  StatusCodes,
} from "node-opcua";

// ---------------------------------------------------------------------------
// Security policy / mode mapping: config string → node-opcua enum
// ---------------------------------------------------------------------------

const SECURITY_POLICY_MAP: Record<string, SecurityPolicy> = {
  None: SecurityPolicy.None,
  Basic256Sha256: SecurityPolicy.Basic256Sha256,
  Aes128_Sha256_RsaOaep: SecurityPolicy.Aes128_Sha256_RsaOaep,
  Aes256_Sha256_RsaPss: SecurityPolicy.Aes256_Sha256_RsaPss,
};

const SECURITY_MODE_MAP: Record<string, MessageSecurityMode> = {
  None: MessageSecurityMode.None,
  Sign: MessageSecurityMode.Sign,
  SignAndEncrypt: MessageSecurityMode.SignAndEncrypt,
};

/** Map config string to node-opcua SecurityPolicy enum. */
export function mapSecurityPolicy(policy: string): SecurityPolicy {
  const mapped = SECURITY_POLICY_MAP[policy];
  if (mapped === undefined) {
    throw new Error(`Unknown security policy: "${policy}". Valid: ${Object.keys(SECURITY_POLICY_MAP).join(", ")}`);
  }
  return mapped;
}

/** Map config string to node-opcua MessageSecurityMode enum. */
export function mapSecurityMode(mode: string): MessageSecurityMode {
  const mapped = SECURITY_MODE_MAP[mode];
  if (mapped === undefined) {
    throw new Error(`Unknown security mode: "${mode}". Valid: ${Object.keys(SECURITY_MODE_MAP).join(", ")}`);
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// DataValue → DataChangeEvent conversion
// ---------------------------------------------------------------------------

/** Get the string name of a DataType enum value. */
function dataTypeName(dt: DataType): string {
  return DataType[dt] ?? "Unknown";
}

/** Extract the raw JS value from a node-opcua DataValue. */
function extractValue(dataValue: DataValue): unknown {
  if (!dataValue.value) return null;
  return dataValue.value.value;
}

/** Convert a node-opcua DataValue to our DataChangeEvent. */
function toDataChangeEvent(nodeId: string, dataValue: DataValue): DataChangeEvent {
  const statusCodeValue = dataValue.statusCode?.value ?? 0;
  return {
    nodeId,
    value: extractValue(dataValue),
    dataType: dataValue.value ? dataTypeName(dataValue.value.dataType) : "Null",
    sourceTimestamp: dataValue.sourceTimestamp ?? null,
    serverTimestamp: dataValue.serverTimestamp ?? null,
    statusCode: statusCodeValue,
    quality: qualityFromStatusCode(statusCodeValue),
  };
}

// ---------------------------------------------------------------------------
// Deadband filter mapping
// ---------------------------------------------------------------------------

const TRIGGER_MAP: Record<string, DataChangeTrigger> = {
  status: DataChangeTrigger.Status,
  status_value: DataChangeTrigger.StatusValue,
  status_value_timestamp: DataChangeTrigger.StatusValueTimestamp,
};

const DEADBAND_TYPE_MAP: Record<string, DeadbandType> = {
  none: DeadbandType.None,
  absolute: DeadbandType.Absolute,
  percent: DeadbandType.Percent,
};

// ---------------------------------------------------------------------------
// SHA-256 fingerprint helper
// ---------------------------------------------------------------------------

/** Compute SHA-256 fingerprint of a certificate buffer. */
function computeFingerprint(certBuffer: Buffer | Uint8Array): string {
  const hash = createHash("sha256").update(certBuffer).digest("hex");
  // Format as colon-separated uppercase hex pairs
  return hash.match(/.{2}/g)!.join(":").toUpperCase();
}

// ---------------------------------------------------------------------------
// RealOpcuaClient — the adapter
// ---------------------------------------------------------------------------

export class RealOpcuaClient implements OpcuaClient {
  private client: InstanceType<typeof OPCUAClient> | null = null;
  private session: ClientSession | null = null;
  private subscription: ClientSubscription | null = null;

  private dataChangeHandler: ((event: DataChangeEvent) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  private _isConnected = false;
  private _sessionActive = false;

  /** Server certificate SHA-256 fingerprint, available after connect(). */
  private serverCertFingerprint: string | null = null;

  /** Subscription ID for transfer attempts. */
  private lastSubscriptionId: number | null = null;

  get isConnected(): boolean {
    return this._isConnected;
  }

  get sessionActive(): boolean {
    return this._sessionActive;
  }

  /** Get the server certificate fingerprint (for TOFU). */
  getServerCertificateFingerprint(): string | null {
    return this.serverCertFingerprint;
  }

  async connect(endpointUrl: string, options: OpcuaClientOptions): Promise<void> {
    const secPolicy = mapSecurityPolicy(options.securityPolicy);
    const secMode = mapSecurityMode(options.securityMode);

    const clientOptions: NodeOpcuaClientOptions = {
      securityPolicy: secPolicy,
      securityMode: secMode,
      connectionStrategy: { maxRetry: 0 },
      endpointMustExist: false,
      requestedSessionTimeout: options.sessionTimeout,
      defaultTransactionTimeout: options.requestTimeout,
      transportTimeout: options.connectTimeout,
    };

    // Client certificate paths
    if (options.certificatePath) {
      clientOptions.certificateFile = options.certificatePath;
    }
    if (options.privateKeyPath) {
      clientOptions.privateKeyFile = options.privateKeyPath;
    }

    this.client = OPCUAClient.create(clientOptions);

    // Wire connection loss event
    this.client.on("close", () => {
      this._isConnected = false;
      this._sessionActive = false;
      if (this.closeHandler) {
        this.closeHandler();
      }
    });

    this.client.on("connection_lost", () => {
      this._isConnected = false;
      this._sessionActive = false;
      if (this.closeHandler) {
        this.closeHandler();
      }
    });

    try {
      await this.client.connect(endpointUrl);
      this._isConnected = true;
    } catch (err) {
      this._isConnected = false;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OPC-UA connect failed for ${endpointUrl}: ${message}`);
    }

    // Extract server certificate fingerprint for TOFU
    try {
      const endpoints = await this.client.getEndpoints();
      if (endpoints.length > 0 && endpoints[0].serverCertificate) {
        const certBuf = endpoints[0].serverCertificate;
        if (certBuf && certBuf.length > 0) {
          this.serverCertFingerprint = computeFingerprint(
            Buffer.isBuffer(certBuf) ? certBuf : Buffer.from(certBuf),
          );
        }
      }
    } catch {
      // Non-fatal: some servers may not provide certificate via GetEndpoints
      getLogger().debug("could not extract server certificate fingerprint", { plugin: "opcua" });
    }
  }

  async createSession(auth?: OpcuaAuthOptions): Promise<void> {
    if (!this.client) {
      throw new Error("OPC-UA client not connected — call connect() first");
    }

    let userIdentity: unknown;
    if (auth && auth.type === "username") {
      userIdentity = {
        type: UserTokenType.UserName,
        userName: auth.username ?? "",
        password: auth.password ?? "",
      };
    } else {
      // Anonymous (default)
      userIdentity = { type: UserTokenType.Anonymous };
    }

    try {
      this.session = await this.client.createSession(userIdentity as any);
      this._sessionActive = true;
    } catch (err) {
      this._sessionActive = false;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OPC-UA session creation failed: ${message}`);
    }

    // "session_closed" exists on the ClientSession implementation but may not
    // be in node-opcua's TS type definitions — cast to avoid compilation error.
    // If node-opcua renames this event, the handler will silently stop firing.
    this.session.on("session_closed" as any, () => {
      this._sessionActive = false;
    });
  }

  async createSubscription(params: OpcuaSubscriptionParams): Promise<void> {
    if (!this.session) {
      throw new Error("OPC-UA session not active — call createSession() first");
    }

    try {
      this.subscription = await this.session.createSubscription2({
        requestedPublishingInterval: params.publishingInterval,
        requestedMaxKeepAliveCount: params.maxKeepAliveCount,
        requestedLifetimeCount: params.lifetimeCount,
        maxNotificationsPerPublish: params.maxNotificationsPerPublish,
        publishingEnabled: true,
        priority: 1,
      });
      this.lastSubscriptionId = this.subscription.subscriptionId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OPC-UA subscription creation failed: ${message}`);
    }
  }

  async addMonitoredItem(item: OpcuaMonitoredItemParams): Promise<void> {
    if (!this.subscription) {
      throw new Error("OPC-UA subscription not active — call createSubscription() first");
    }

    const nodeId = coerceNodeId(item.nodeId);
    const itemToMonitor = {
      nodeId,
      attributeId: AttributeIds.Value,
    };

    // Build monitoring parameters
    const monitoringParams: {
      samplingInterval: number;
      queueSize: number;
      discardOldest: boolean;
      filter?: DataChangeFilter;
    } = {
      samplingInterval: item.samplingInterval,
      queueSize: item.queueSize,
      discardOldest: true,
    };

    // Add deadband filter if specified
    if (item.deadbandType !== "none") {
      monitoringParams.filter = new DataChangeFilter({
        trigger: TRIGGER_MAP[item.trigger] ?? DataChangeTrigger.StatusValue,
        deadbandType: DEADBAND_TYPE_MAP[item.deadbandType] ?? DeadbandType.None,
        deadbandValue: item.deadbandValue,
      });
    }

    try {
      const monitoredItem: ClientMonitoredItem = await this.subscription.monitor(
        itemToMonitor,
        monitoringParams,
        TimestampsToReturn.Both,
      );

      monitoredItem.on("changed", (dataValue: DataValue) => {
        if (this.dataChangeHandler) {
          const event = toDataChangeEvent(item.nodeId, dataValue);
          this.dataChangeHandler(event);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OPC-UA monitor failed for node ${item.nodeId}: ${message}`);
    }
  }

  onDataChange(handler: (event: DataChangeEvent) => void): void {
    this.dataChangeHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async transferSubscriptions(): Promise<boolean> {
    if (!this.session || !this.lastSubscriptionId) {
      return false;
    }

    try {
      // transferSubscriptions exists on the implementation but isn't exposed
      // on the ClientSession interface type — cast to access it.
      const session = this.session as any;
      const result = await session.transferSubscriptions({
        subscriptionIds: [this.lastSubscriptionId],
        sendInitialValues: true,
      });

      if (
        result.results &&
        result.results.length > 0 &&
        result.results[0].statusCode.equals(StatusCodes.Good)
      ) {
        return true;
      }
      return false;
    } catch {
      // Transfer not supported or failed — caller will recreate
      return false;
    }
  }

  async browse(
    rootNodeId: string,
    maxDepth: number,
    nodeClasses: string[],
  ): Promise<BrowseResultNode[]> {
    if (!this.session) {
      throw new Error("OPC-UA session not active — call createSession() first");
    }

    const allowedClasses = new Set(nodeClasses);
    const results: BrowseResultNode[] = [];

    await this.browseRecursive(
      rootNodeId,
      0,
      maxDepth,
      allowedClasses,
      results,
    );

    return results;
  }

  private async browseRecursive(
    nodeId: string,
    depth: number,
    maxDepth: number,
    allowedClasses: Set<string>,
    results: BrowseResultNode[],
  ): Promise<void> {
    if (depth >= maxDepth || !this.session) return;

    try {
      const browseResult = await this.session.browse([{
        nodeId: coerceNodeId(nodeId),
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: true,
        resultMask: 0x3F, // all fields
      }]);

      if (!browseResult || browseResult.length === 0) return;
      const refs = browseResult[0].references;
      if (!refs) return;

      for (const ref of refs) {
        const refNodeClass = NodeClass[ref.nodeClass] ?? "Unknown";
        const refNodeId = ref.nodeId.toString();
        const browseName = ref.browseName?.name ?? "";

        if (allowedClasses.has(refNodeClass)) {
          const node: BrowseResultNode = {
            nodeId: refNodeId,
            browseName,
            nodeClass: refNodeClass,
          };

          // For Variable nodes, try to read DataType and current value
          if (ref.nodeClass === NodeClass.Variable) {
            try {
              const readResults = await this.session!.read([
                { nodeId: ref.nodeId.toString(), attributeId: AttributeIds.Value },
                { nodeId: ref.nodeId.toString(), attributeId: AttributeIds.DataType },
              ]);

              if (readResults[0] && readResults[0].statusCode.isGood()) {
                node.currentValue = readResults[0].value?.value;
              }
              if (readResults[1] && readResults[1].statusCode.isGood()) {
                const dtNodeId = readResults[1].value?.value;
                if (dtNodeId) {
                  // DataType NodeId → try to get the name
                  node.dataType = dataTypeName(dtNodeId.value ?? 0);
                }
              }
            } catch {
              // Non-fatal: skip value/type read
            }
          }

          results.push(node);
        }

        // Recurse into Objects (containers)
        if (ref.nodeClass === NodeClass.Object) {
          await this.browseRecursive(
            refNodeId,
            depth + 1,
            maxDepth,
            allowedClasses,
            results,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      getLogger().warn("browse error at node", { plugin: "opcua", node_id: nodeId, error: message });
    }
  }

  async resolveNamespaceUri(uri: string): Promise<number> {
    if (!this.session) {
      throw new Error("OPC-UA session not active — call createSession() first");
    }

    const nsArray = await this.session.readNamespaceArray();
    const index = nsArray.indexOf(uri);
    if (index === -1) {
      throw new Error(`Namespace URI not found on server: "${uri}"`);
    }
    return index;
  }

  async closeSession(): Promise<void> {
    if (this.subscription) {
      try {
        await this.subscription.terminate();
      } catch {
        // Ignore — subscription may already be terminated
      }
      this.subscription = null;
    }

    if (this.session) {
      try {
        await this.session.close();
      } catch {
        // Ignore — session may already be closed
      }
      this.session = null;
      this._sessionActive = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        // Ignore — client may already be disconnected
      }
      this.client = null;
      this._isConnected = false;
      this._sessionActive = false;
    }
  }
}
