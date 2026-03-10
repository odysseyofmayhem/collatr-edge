// CollatrEdge — WebUIAdapter
// PRD refs: §17 Local Web UI, §15 Observability, §4 Architecture Overview
// Phase 9 Task 9.0: Read-only facade exposing pipeline state for HTTP routes
// Phase 9 Task 9.6: getCertificateInfo() for OPC-UA certificate helper page

import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { dirname, join } from "node:path";
import type { FieldValue, Metric } from "../core/metric";
import type { NetworkPolicy } from "../core/network-policy";
import type { PipelineOptions, PipelineState } from "../pipeline/runtime";
import type { LocalStoreOutput } from "../plugins/outputs/local-store";
import type { StatsCollector } from "../core/stats";
import { TrustStore } from "./trust-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginHealth {
  alias: string;
  type: "input" | "processor" | "aggregator" | "output";
  status: "ok" | "error" | "stopped";
  lastActivity: number | null;
  errorMessage?: string;
}

/** OPC-UA input configuration info passed to the adapter for certificate management. */
export interface OpcuaInputInfo {
  alias: string;
  endpoint: string;
  certificatePath?: string;
  privateKeyPath?: string;
}

/** Client certificate info parsed from disk. */
export interface ClientCertInfo {
  path: string;
  exists: boolean;
  thumbprint?: string;
  subject?: string;
  validFrom?: string;
  validTo?: string;
}

/** Per-OPC-UA-input connection status and optional server certificate info. */
export interface OpcuaConnectionInfo {
  alias: string;
  endpoint: string;
  connectionState: "connected" | "rejected" | "disconnected" | "unknown";
  errorMessage?: string;
  serverCert?: {
    thumbprint: string;
    subject: string;
    validFrom: string;
    validTo: string;
  };
}

/** Combined certificate information for the certificate helper page. */
export interface CertificateInfo {
  clientCert: ClientCertInfo | null;
  inputs: OpcuaConnectionInfo[];
}

export interface LiveMetricValue {
  name: string;
  fields: Record<string, FieldValue>;
  tags: Record<string, string>;
  timestamp: bigint;
  quality: number;
}

/** Read-only state source for pipeline lifecycle. */
export interface PipelineStateSource {
  readonly state: PipelineState;
  readonly startedAt: number | null;
}

// ---------------------------------------------------------------------------
// WebUIAdapter interface
// ---------------------------------------------------------------------------

export interface WebUIAdapter {
  getStatus(): { state: PipelineState; startedAt: number | null };
  getPluginHealth(): PluginHealth[];
  getLiveMetrics(): Map<string, LiveMetricValue>;
  getNetworkPolicy(): { mode: string; summary: string } | null;
  getUptime(): number;
  getMemoryUsage(): { heapUsed: number; heapTotal: number; rss: number };

  /** Metric sink callback — called by PipelineRuntime for each metric flowing to outputs. */
  handleMetric(metric: Metric): void;

  /** Access to the local data store for historical queries and CSV export. Null if not configured. */
  getLocalStore(): LocalStoreOutput | null;

  /** OPC-UA certificate info for the certificate helper page. PRD Appendix D §D.3-D.4. */
  getCertificateInfo(): CertificateInfo;

  /** SQLite trust store for TOFU server certificate trust. Null if no OPC-UA inputs configured. */
  getTrustStore(): TrustStore | null;

  /** Pipeline stats collector for operational counters (gathered/written/dropped/errors). */
  getStats(): StatsCollector | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PipelineWebUIAdapter implements WebUIAdapter {
  private _stateSource: PipelineStateSource;
  private _options: PipelineOptions;
  private _networkPolicy: NetworkPolicy | null;
  private _localStore: LocalStoreOutput | null;
  private _opcuaInputs: OpcuaInputInfo[];
  private _stats: StatsCollector | null;
  private _clientCertInfo: ClientCertInfo | null = null;
  private _trustStore: TrustStore | null = null;
  private _liveMetrics: Map<string, LiveMetricValue> = new Map();
  private _lastActivity: Map<string, number> = new Map();

  constructor(
    options: PipelineOptions,
    stateSource: PipelineStateSource,
    localStore?: LocalStoreOutput | null,
    opcuaInputs?: OpcuaInputInfo[],
    stats?: StatsCollector | null,
  ) {
    this._options = options;
    this._stateSource = stateSource;
    this._networkPolicy = options.networkPolicy ?? null;
    this._localStore = localStore ?? null;
    this._opcuaInputs = opcuaInputs ?? [];
    this._stats = stats ?? null;
    this._loadClientCert();
  }

  /** Read and parse the client certificate from disk at construction time. */
  private _loadClientCert(): void {
    const certInput = this._opcuaInputs.find((i) => i.certificatePath);
    if (!certInput?.certificatePath) {
      this._clientCertInfo = null;
      return;
    }

    const certPath = certInput.certificatePath;
    const trustDbPath = join(dirname(certPath), "trust-store.db");
    this._trustStore = new TrustStore(trustDbPath);

    if (!existsSync(certPath)) {
      this._clientCertInfo = { path: certPath, exists: false };
      return;
    }

    try {
      const data = readFileSync(certPath);
      const cert = new X509Certificate(data);
      this._clientCertInfo = {
        path: certPath,
        exists: true,
        thumbprint: cert.fingerprint, // SHA-1, colon-separated
        subject: cert.subject,
        validFrom: cert.validFrom,
        validTo: cert.validTo,
      };
    } catch {
      // File exists but unparseable (corrupt or not a certificate)
      this._clientCertInfo = { path: certPath, exists: true };
    }
  }

  handleMetric(metric: Metric): void {
    const fields: Record<string, FieldValue> = {};
    for (const [k, v] of metric.fields) {
      fields[k] = v;
    }
    const tags: Record<string, string> = {};
    for (const [k, v] of metric.tags) {
      tags[k] = v;
    }

    this._liveMetrics.set(metric.name, {
      name: metric.name,
      fields,
      tags,
      timestamp: metric.timestamp,
      quality: 1.0, // MVP: quality assumed good (OPC-UA quality mapping is post-MVP)
    });

    // Track last activity per input alias (from _device_id tag injected by ChannelAccumulator)
    const deviceId = metric.getTag("_device_id");
    if (deviceId) {
      this._lastActivity.set(deviceId, Date.now());
    }
  }

  getStatus(): { state: PipelineState; startedAt: number | null } {
    return {
      state: this._stateSource.state,
      startedAt: this._stateSource.startedAt,
    };
  }

  getPluginHealth(): PluginHealth[] {
    const health: PluginHealth[] = [];
    const isRunning = this._stateSource.state === "running";

    for (const input of this._options.inputs) {
      const alias = input.alias ?? "input";
      health.push({
        alias,
        type: "input",
        status: isRunning ? "ok" : "stopped",
        lastActivity: this._lastActivity.get(alias) ?? null,
      });
    }

    for (const proc of this._options.processors) {
      health.push({
        alias: proc.alias ?? "processor",
        type: "processor",
        status: isRunning ? "ok" : "stopped",
        lastActivity: null,
      });
    }

    for (const agg of this._options.aggregators) {
      health.push({
        alias: agg.alias ?? "aggregator",
        type: "aggregator",
        status: isRunning ? "ok" : "stopped",
        lastActivity: null,
      });
    }

    for (const output of this._options.outputs) {
      health.push({
        alias: output.alias ?? "output",
        type: "output",
        status: isRunning ? "ok" : "stopped",
        lastActivity: null,
      });
    }

    return health;
  }

  getLiveMetrics(): Map<string, LiveMetricValue> {
    return new Map(this._liveMetrics);
  }

  getNetworkPolicy(): { mode: string; summary: string } | null {
    if (!this._networkPolicy) return null;
    return {
      mode: this._networkPolicy.mode,
      summary: this._networkPolicy.summary(),
    };
  }

  getUptime(): number {
    const startedAt = this._stateSource.startedAt;
    if (!startedAt) return 0;
    return Date.now() - startedAt;
  }

  getMemoryUsage(): { heapUsed: number; heapTotal: number; rss: number } {
    const usage = process.memoryUsage();
    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
    };
  }

  getLocalStore(): LocalStoreOutput | null {
    return this._localStore;
  }

  getCertificateInfo(): CertificateInfo {
    const isRunning = this._stateSource.state === "running";

    return {
      clientCert: this._clientCertInfo,
      inputs: this._opcuaInputs.map((input) => ({
        alias: input.alias,
        endpoint: input.endpoint,
        connectionState: isRunning
          ? (this._lastActivity.has(input.alias) ? "connected" as const : "unknown" as const)
          : ("disconnected" as const),
      })),
    };
  }

  getTrustStore(): TrustStore | null {
    return this._trustStore;
  }

  getStats(): StatsCollector | null {
    return this._stats;
  }
}
