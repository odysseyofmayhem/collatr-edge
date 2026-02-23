// CollatrEdge — Stats collector interface
// PRD refs: §15 Observability
//
// Defines the interface that PipelineRuntime exposes for the internal
// metrics input plugin to read agent health and per-plugin statistics.

// ---------------------------------------------------------------------------
// Per-plugin stats
// ---------------------------------------------------------------------------

export interface InputStats {
  /** Plugin name or alias */
  name: string;
  /** Last gather duration in milliseconds */
  gatherTimeMs: number;
  /** Total metrics produced by this input */
  metricsCount: number;
}

export interface OutputStats {
  /** Plugin name or alias */
  name: string;
  /** Last write duration in milliseconds */
  writeTimeMs: number;
  /** Current buffer depth (metrics queued for write) */
  bufferSize: number;
}

// ---------------------------------------------------------------------------
// StatsCollector interface — read by internal metrics input
// ---------------------------------------------------------------------------

export interface StatsCollector {
  /** Agent start time (Unix ms) */
  readonly startTimeMs: number;
  /** Total metrics gathered across all inputs */
  readonly metricsGathered: number;
  /** Total metrics successfully written across all outputs */
  readonly metricsWritten: number;
  /** Total metrics dropped (buffer overflow, filter, error) */
  readonly metricsDropped: number;
  /** Total gather errors across all inputs */
  readonly gatherErrors: number;
  /** Total write errors across all outputs */
  readonly writeErrors: number;
  /** Per-input stats snapshot */
  getInputStats(): InputStats[];
  /** Per-output stats snapshot */
  getOutputStats(): OutputStats[];
}

// ---------------------------------------------------------------------------
// SimpleStatsCollector — mutable implementation for testing and standalone use
// ---------------------------------------------------------------------------

export class SimpleStatsCollector implements StatsCollector {
  startTimeMs: number;
  metricsGathered = 0;
  metricsWritten = 0;
  metricsDropped = 0;
  gatherErrors = 0;
  writeErrors = 0;

  private inputStats: InputStats[] = [];
  private outputStats: OutputStats[] = [];

  constructor(startTimeMs?: number) {
    this.startTimeMs = startTimeMs ?? Date.now();
  }

  getInputStats(): InputStats[] {
    return [...this.inputStats];
  }

  getOutputStats(): OutputStats[] {
    return [...this.outputStats];
  }

  /** Set per-input stats (test helper). */
  setInputStats(stats: InputStats[]): void {
    this.inputStats = stats;
  }

  /** Set per-output stats (test helper). */
  setOutputStats(stats: OutputStats[]): void {
    this.outputStats = stats;
  }
}
