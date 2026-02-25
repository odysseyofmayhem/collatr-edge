// CollatrEdge — WebUIAdapter
// PRD refs: §17 Local Web UI, §15 Observability, §4 Architecture Overview
// Phase 9 Task 9.0: Read-only facade exposing pipeline state for HTTP routes

import type { FieldValue, Metric } from "../core/metric";
import type { NetworkPolicy } from "../core/network-policy";
import type { PipelineOptions, PipelineState } from "../pipeline/runtime";
import type { LocalStoreOutput } from "../plugins/outputs/local-store";

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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PipelineWebUIAdapter implements WebUIAdapter {
  private _stateSource: PipelineStateSource;
  private _options: PipelineOptions;
  private _networkPolicy: NetworkPolicy | null;
  private _localStore: LocalStoreOutput | null;
  private _liveMetrics: Map<string, LiveMetricValue> = new Map();
  private _lastActivity: Map<string, number> = new Map();

  constructor(
    options: PipelineOptions,
    stateSource: PipelineStateSource,
    localStore?: LocalStoreOutput | null,
  ) {
    this._options = options;
    this._stateSource = stateSource;
    this._networkPolicy = options.networkPolicy ?? null;
    this._localStore = localStore ?? null;
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
}
