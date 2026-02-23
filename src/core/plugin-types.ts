// CollatrEdge — Plugin type interfaces
// PRD refs: §6 Plugin System, Appendix B Metric Interface

import type { Accumulator } from "./accumulator";
import type { Metric } from "./metric";

export type PluginType = "input" | "processor" | "aggregator" | "output";

export interface Input {
  init?(): Promise<void>;
  gather(acc: Accumulator): Promise<void>;
  close?(): Promise<void>;
}

export interface ServiceInput extends Input {
  start(acc: Accumulator): Promise<void>;
  stop(): Promise<void>;
}

export interface Processor {
  init?(): Promise<void>;
  process(metric: Metric, acc: Accumulator): Promise<void>;
  close?(): Promise<void>;
}

export interface Aggregator {
  init?(): Promise<void>;
  add(metric: Metric): void;
  push(acc: Accumulator): void;
  reset(): void;
  close?(): Promise<void>;
}

export interface Output {
  init?(): Promise<void>;
  connect(): Promise<void>;
  write(batch: Metric[]): Promise<void>;
  close(): Promise<void>;
}

export interface StatefulPlugin {
  getState(): unknown;
  setState(state: unknown): void;
}
