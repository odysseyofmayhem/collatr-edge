// CollatrEdge — Metric data model
// PRD refs: §5 Data Model, Appendix B Metric Interface

export type FieldValue = number | bigint | string | boolean;
export type MetricType = "untyped" | "counter" | "gauge" | "summary" | "histogram";
export type MetricPriority = "normal" | "high" | "critical";

export interface Metric {
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

// FNV-64a constants
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function fnv64a(data: Uint8Array): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < data.length; i++) {
    hash ^= BigInt(data[i]!);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

const encoder = new TextEncoder();

function sortedMap(entries: Iterable<[string, string]>): Map<string, string> {
  const arr = Array.from(entries);
  arr.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new Map(arr);
}

class MetricImpl implements Metric {
  name: string;
  tags: Map<string, string>;
  fields: Map<string, FieldValue>;
  timestamp: bigint;
  type: MetricType;
  priority: MetricPriority;

  private _accepted = false;
  private _rejected = false;
  private _dropped = false;

  constructor(
    name: string,
    tags: Map<string, string>,
    fields: Map<string, FieldValue>,
    timestamp: bigint,
    type: MetricType,
    priority: MetricPriority,
  ) {
    this.name = name;
    this.tags = sortedMap(tags);
    this.fields = new Map(fields);
    this.timestamp = timestamp;
    this.type = type;
    this.priority = priority;
  }

  // TODO: Phase 2 — integrate with delivery tracking / buffer manager.
  // These flags are currently write-only. They will be read by the buffer
  // manager to track end-to-end delivery status per metric.
  accept(): void {
    this._accepted = true;
  }

  reject(): void {
    this._rejected = true;
  }

  drop(): void {
    this._dropped = true;
  }

  hashId(): bigint {
    // FNV-64a of name + sorted tags (not fields).
    // Format: "name\0key1=val1\0key2=val2"
    // Assumes metric names don't contain \0 and tag keys don't contain '='.
    // These are safe assumptions for IIoT metric naming conventions.
    let str = this.name;
    for (const [key, value] of this.tags) {
      str += "\0" + key + "=" + value;
    }
    return fnv64a(encoder.encode(str));
  }

  /**
   * Hand-rolled deep copy for fan-out (PRD §5).
   *
   * Safe because all FieldValue types are primitives (number, bigint, string,
   * boolean). If FieldValue is ever extended to include reference types (e.g.
   * Uint8Array for binary payloads), this must be updated to deep-copy those.
   *
   * Tracking state (_accepted/_rejected/_dropped) is deliberately NOT copied.
   * A copy is a new data point in the pipeline with its own delivery lifecycle.
   */
  copy(): Metric {
    const tagsCopy = new Map(this.tags);
    const fieldsCopy = new Map(this.fields);
    return new MetricImpl(
      this.name,
      tagsCopy,
      fieldsCopy,
      this.timestamp,
      this.type,
      this.priority,
    );
  }

  hasTag(key: string): boolean {
    return this.tags.has(key);
  }

  getTag(key: string): string | undefined {
    return this.tags.get(key);
  }

  addTag(key: string, value: string): void {
    this.tags.set(key, value);
    // Re-sort to maintain sorted invariant. O(N log N) per call —
    // acceptable for small tag sets typical in IIoT (rarely >10 tags).
    this.tags = sortedMap(this.tags);
  }

  removeTag(key: string): void {
    this.tags.delete(key);
  }

  hasField(key: string): boolean {
    return this.fields.has(key);
  }

  getField(key: string): FieldValue | undefined {
    return this.fields.get(key);
  }

  addField(key: string, value: FieldValue): void {
    this.fields.set(key, value);
  }

  removeField(key: string): void {
    this.fields.delete(key);
  }
}

export interface CreateMetricOptions {
  name: string;
  fields: Record<string, FieldValue>;
  tags?: Record<string, string>;
  timestamp?: bigint;
  type?: MetricType;
  priority?: MetricPriority;
}

export function createMetric(options: CreateMetricOptions): Metric {
  const tags = new Map(Object.entries(options.tags ?? {}));
  const fields = new Map(Object.entries(options.fields));
  const timestamp = options.timestamp ?? BigInt(Date.now()) * 1_000_000n;
  const type = options.type ?? "untyped";
  const priority = options.priority ?? "normal";

  return new MetricImpl(options.name, tags, fields, timestamp, type, priority);
}
