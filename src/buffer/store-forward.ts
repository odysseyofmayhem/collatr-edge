// CollatrEdge — Store-and-forward buffer
// PRD refs: §12 Buffers & Delivery Guarantees

import { z } from "zod/v4";
import { Database } from "bun:sqlite";
import { pack, unpack } from "msgpackr";
import type { Metric, FieldValue } from "@core/metric";
import { createMetric } from "@core/metric";

// ---------------------------------------------------------------------------
// Config schema (PRD §12)
// ---------------------------------------------------------------------------

export const StoreForwardConfigSchema = z.object({
  metric_buffer_limit: z.number().int().min(1).default(10000),
  metric_batch_size: z.number().int().min(1).default(1000),
  overflow_policy: z.enum(["drop_oldest", "disk_spill"]).default("drop_oldest"),
});

export type StoreForwardConfig = z.infer<typeof StoreForwardConfigSchema>;

// ---------------------------------------------------------------------------
// Metric encoding (full metric → MessagePack blob for buffer storage)
// ---------------------------------------------------------------------------

export function encodeMetric(metric: Metric): Uint8Array {
  const tags: Record<string, string> = {};
  for (const [k, v] of metric.tags) tags[k] = v;
  const fields: Record<string, FieldValue> = {};
  for (const [k, v] of metric.fields) fields[k] = v;

  return pack({
    name: metric.name,
    tags,
    fields,
    timestamp: metric.timestamp.toString(), // BigInt → string for portable encoding
    type: metric.type,
    priority: metric.priority,
  });
}

export function decodeMetric(blob: Uint8Array): Metric {
  const obj = unpack(blob) as {
    name: string;
    tags: Record<string, string>;
    fields: Record<string, FieldValue>;
    timestamp: string;
    type?: string;
    priority?: string;
  };

  return createMetric({
    name: obj.name,
    tags: obj.tags,
    fields: obj.fields,
    timestamp: BigInt(obj.timestamp),
    type: (obj.type as "untyped" | "counter" | "gauge" | "summary" | "histogram") ?? "untyped",
    priority: (obj.priority as "normal" | "high" | "critical") ?? "normal",
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitise output alias to a valid SQL identifier fragment. */
function sanitizeAlias(alias: string): string {
  return alias.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ---------------------------------------------------------------------------
// Buffer transaction (PRD §12 write transaction model)
// ---------------------------------------------------------------------------

export class BufferTransaction {
  private readonly ids: number[];
  private readonly _batch: Metric[];
  private readonly db: Database;
  private readonly tableName: string;
  private readonly onRemove: (count: number) => void;

  constructor(
    db: Database,
    tableName: string,
    ids: number[],
    metrics: Metric[],
    onRemove: (count: number) => void,
  ) {
    this.db = db;
    this.tableName = tableName;
    this.ids = ids;
    this._batch = metrics;
    this.onRemove = onRemove;
  }

  /** The metrics in this transaction batch. */
  get batch(): Metric[] {
    return this._batch;
  }

  /** All metrics delivered successfully — remove from buffer. */
  acceptAll(): void {
    if (this.ids.length === 0) return;
    this.deleteByIds(this.ids);
    this.onRemove(this.ids.length);
  }

  /** Total failure — leave all metrics for retry. */
  keepAll(): void {
    // No-op: metrics stay in buffer for retry
  }

  /** Partial success — remove successfully delivered metrics by batch index. */
  accept(indices: number[]): void {
    if (indices.length === 0) return;
    const idsToDelete = indices.map(i => this.ids[i]!);
    this.deleteByIds(idsToDelete);
    this.onRemove(indices.length);
  }

  /** Permanent rejection — remove permanently failed metrics by batch index (won't retry). */
  reject(indices: number[]): void {
    if (indices.length === 0) return;
    const idsToDelete = indices.map(i => this.ids[i]!);
    this.deleteByIds(idsToDelete);
    this.onRemove(indices.length);
  }

  private deleteByIds(ids: number[]): void {
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`,
    ).run(...ids);
  }
}

// ---------------------------------------------------------------------------
// Store-and-forward buffer (PRD §12)
// ---------------------------------------------------------------------------

export class StoreForwardBuffer {
  private db: Database | null = null;
  private readonly tableName: string;
  private readonly config: StoreForwardConfig;
  private readonly dbPath: string;
  private _length = 0;

  constructor(alias: string, dbPath: string, config: StoreForwardConfig) {
    this.dbPath = dbPath;
    this.config = config;
    this.tableName = `buffer_${sanitizeAlias(alias)}`;
  }

  /** Open the buffer database and create/recover the buffer table. */
  open(): void {
    this.db = new Database(this.dbPath);

    // PRAGMAs (PRD §12: WAL mode, synchronous=NORMAL, busy_timeout=5000)
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");

    // WAL checkpoint on open (startup recovery per PRD §8)
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    // Create buffer table (PRD §11 schema: buffer_TEMPLATE)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id          INTEGER PRIMARY KEY,
        timestamp   INTEGER NOT NULL,
        payload     BLOB NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_created ON ${this.tableName} (created_at)`,
    );

    // Count existing rows (recovery: unacknowledged metrics from previous session)
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM ${this.tableName}`,
    ).get() as { cnt: number };
    this._length = row.cnt;
  }

  /** Add metrics to the buffer. Enforces overflow policy after insertion. */
  add(metrics: Metric[]): void {
    if (metrics.length === 0) return;
    if (!this.db) throw new Error("Buffer not open");

    const db = this.db;
    const insert = db.prepare(
      `INSERT INTO ${this.tableName} (timestamp, payload, created_at) VALUES (?, ?, ?)`,
    );
    const now = Date.now();

    const tx = db.transaction(() => {
      for (const metric of metrics) {
        const payload = encodeMetric(metric);
        insert.run(Number(metric.timestamp), payload, now);
      }
    });
    tx();

    this._length += metrics.length;
    this.enforceLimit();
  }

  /** Begin a read transaction — returns oldest N metrics from the buffer. */
  beginTransaction(batchSize?: number): BufferTransaction {
    if (!this.db) throw new Error("Buffer not open");

    const size = batchSize ?? this.config.metric_batch_size;

    const rows = this.db.prepare(
      `SELECT id, payload FROM ${this.tableName} ORDER BY id ASC LIMIT ?`,
    ).all(size) as { id: number; payload: Uint8Array }[];

    const ids = rows.map(r => r.id);
    const metrics = rows.map(r => decodeMetric(r.payload));

    return new BufferTransaction(
      this.db,
      this.tableName,
      ids,
      metrics,
      (count) => { this._length -= count; },
    );
  }

  /** Current number of metrics in the buffer. */
  get length(): number {
    return this._length;
  }

  /** Close the buffer — WAL checkpoint and release DB handle. */
  close(): void {
    if (!this.db) return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Ignore checkpoint errors during shutdown
    }
    this.db.close();
    this.db = null;
  }

  /**
   * Enforce metric_buffer_limit by removing oldest metrics.
   *
   * Both drop_oldest and disk_spill enforce the same SQLite-level limit in the MVP.
   * All metrics are persisted to SQLite for at-least-once delivery guarantee.
   * The two-tier memory/disk distinction is a post-MVP optimisation — when added,
   * drop_oldest will discard from the memory tier, while disk_spill will overflow
   * to the SQLite tier first.
   */
  private enforceLimit(): void {
    if (!this.db) return;
    if (this._length <= this.config.metric_buffer_limit) return;

    const excess = this._length - this.config.metric_buffer_limit;

    this.db.exec(
      `DELETE FROM ${this.tableName} WHERE id IN (
        SELECT id FROM ${this.tableName} ORDER BY id ASC LIMIT ${excess}
      )`,
    );

    this._length -= excess;
  }
}
