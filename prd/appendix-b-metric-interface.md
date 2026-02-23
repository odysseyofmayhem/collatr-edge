## Appendix B: Metric Interface

```typescript
interface Metric {
  name: string;
  tags: Map<string, string>;
  fields: Map<string, FieldValue>;
  timestamp: bigint;
  type: MetricType;
  priority: MetricPriority;

  accept(): void;
  reject(): void;
  drop(): void;
  hashId(): bigint;
  copy(): Metric;

  hasTag(key: string): boolean;
  getTag(key: string): string | undefined;
  addTag(key: string, value: string): void;
  removeTag(key: string): void;

  hasField(key: string): boolean;
  getField(key: string): FieldValue | undefined;
  addField(key: string, value: FieldValue): void;
  removeField(key: string): void;
}

interface Accumulator {
  /** Create a new metric. Timestamp auto-assigned if not provided. */
  addFields(measurement: string, fields: Record<string, FieldValue>, tags?: Record<string, string>, timestamp?: bigint): void;
  /** Forward an existing metric (processors use this for pass-through/transform). */
  addMetric(metric: Metric): void;
  /** Report a non-fatal error (logged + counted). */
  addError(error: Error): void;
}

interface Input {
  init?(): Promise<void>;
  gather(acc: Accumulator): Promise<void>;
  close?(): Promise<void>;
}

interface ServiceInput extends Input {
  start(acc: Accumulator): Promise<void>;
  stop(): Promise<void>;
}

interface Processor {
  init?(): Promise<void>;
  process(metric: Metric, acc: Accumulator): Promise<void>;
  close?(): Promise<void>;
}

interface Aggregator {
  init?(): Promise<void>;
  add(metric: Metric): void;
  push(acc: Accumulator): void;
  reset(): void;
  close?(): Promise<void>;
}

interface Output {
  init?(): Promise<void>;
  connect(): Promise<void>;
  write(batch: Metric[]): Promise<void>;
  close(): Promise<void>;
}

interface StatefulPlugin {
  getState(): unknown;
  setState(state: unknown): void;
}
```
