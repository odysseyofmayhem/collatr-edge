// CollatrEdge — Local data store output plugin
// PRD refs: §11 Local Data Store

import { z } from "zod/v4";
import { Database } from "bun:sqlite";
import { pack, unpack } from "msgpackr";
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Output } from "@core/plugin-types";
import type { Metric, FieldValue } from "@core/metric";

// ---------------------------------------------------------------------------
// Config schema (PRD §11)
// ---------------------------------------------------------------------------

export const LocalStoreConfigSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default("/var/collatr/data"),
  retention_days: z.number().int().min(1).default(90),
  retention_max_gb: z.number().min(0.1).default(10),
  rotation: z.enum(["daily"]).default("daily"),
  downsample_after_days: z.number().int().min(1).default(7),
  downsample_interval: z.string().default("1m"),
  // PRD §8 step 6: optional integrity check on database open.
  // When true, runs PRAGMA integrity_check on each daily file at open.
  // If corruption is detected, the file is moved aside and a fresh DB is created.
  // TODO: Phase 6/7 — PRD uses `config.agent.integrity_check_on_startup` as a
  // global agent-level setting that applies to all SQLite databases (local store +
  // S&F buffer). Current implementation is per-output. Migrate to [agent] config
  // section when building the config parser, and wire it into S&F buffer too.
  integrity_check: z.boolean().default(false),
});

export type LocalStoreConfig = z.infer<typeof LocalStoreConfigSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAILY_FILE_PATTERN = /^data_(\d{4})_(\d{2})_(\d{2})\.db$/;
const NS_PER_MS = 1_000_000n;
const NS_PER_SEC = 1_000_000_000n;
const MS_PER_DAY = 86_400_000;

const CREATE_METRICS_TABLE = `
CREATE TABLE IF NOT EXISTS metrics (
  id          INTEGER PRIMARY KEY,
  timestamp   INTEGER NOT NULL,
  name        TEXT NOT NULL,
  tags_hash   INTEGER NOT NULL,
  tags        TEXT NOT NULL,
  fields      BLOB NOT NULL,
  quality     INTEGER DEFAULT 0
)`;

const CREATE_METRICS_TIME_INDEX = `
CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics (timestamp)`;

const CREATE_METRICS_NAME_TIME_INDEX = `
CREATE INDEX IF NOT EXISTS idx_metrics_name_time ON metrics (name, timestamp)`;

const CREATE_TAG_INDEX_TABLE = `
CREATE TABLE IF NOT EXISTS tag_index (
  name        TEXT NOT NULL,
  tags_hash   INTEGER NOT NULL,
  tags        TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (name, tags_hash)
)`;

const INSERT_METRIC = `
INSERT INTO metrics (timestamp, name, tags_hash, tags, fields, quality)
VALUES (?, ?, ?, ?, ?, ?)`;

const UPSERT_TAG_INDEX = `
INSERT INTO tag_index (name, tags_hash, tags, first_seen, last_seen)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(name, tags_hash) DO UPDATE SET last_seen = excluded.last_seen`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert metric quality tag to integer. */
function qualityToInt(metric: Metric): number {
  const quality = metric.getTag("quality");
  if (quality === "uncertain") return 1;
  if (quality === "bad") return 2;
  return 0; // default: good
}

/** Get UTC date string YYYY_MM_DD for a nanosecond timestamp. */
export function timestampToDateString(timestampNs: bigint): string {
  const ms = Number(timestampNs / NS_PER_MS);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}_${m}_${day}`;
}

/** Get daily DB filename for a nanosecond timestamp. */
function dailyFilename(timestampNs: bigint): string {
  return `data_${timestampToDateString(timestampNs)}.db`;
}

/** Encode metric fields to MessagePack blob. */
export function encodeFields(fields: Map<string, FieldValue>): Uint8Array {
  const obj: Record<string, FieldValue> = {};
  for (const [key, value] of fields) {
    obj[key] = value;
  }
  return pack(obj);
}

/** Decode MessagePack blob to field record. */
export function decodeFields(blob: Uint8Array): Record<string, FieldValue> {
  return unpack(blob) as Record<string, FieldValue>;
}

// FNV-64a constants (same as core/metric.ts — duplicated to avoid exporting internal hash fn)
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const textEncoder = new TextEncoder();

/**
 * Compute tags-only FNV-64a hash (PRD §11: "FNV-64a of sorted tags").
 * Unlike metric.hashId() which includes the metric name, this hashes only
 * the sorted tag key=value pairs. Ensures positive value for SQLite.
 */
function tagsHash(tags: Map<string, string>): number {
  // Assumes tags Map is already sorted by key (guaranteed by createMetric()).
  let str = "";
  for (const [key, value] of tags) {
    if (str.length > 0) str += "\0";
    str += key + "=" + value;
  }
  const data = textEncoder.encode(str);
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < data.length; i++) {
    hash ^= BigInt(data[i]!);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  // Mask to 53 bits (Number.MAX_SAFE_INTEGER) for lossless Number conversion
  return Number(hash & 0x1fffffffffffffn);
}

/** Serialise tags Map to sorted JSON string. */
function tagsToJSON(tags: Map<string, string>): string {
  const obj: Record<string, string> = {};
  for (const [key, value] of tags) {
    obj[key] = value;
  }
  return JSON.stringify(obj);
}

/** Parse a date string from a daily filename. Returns epoch ms at UTC midnight. */
function parseDailyFilename(filename: string): number | null {
  const match = filename.match(DAILY_FILE_PATTERN);
  if (!match) return null;
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m!) - 1, Number(d));
}

/** Parse downsample_interval string (e.g. "1m", "5m", "1h") to milliseconds. */
function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error(`Invalid downsample_interval: ${interval}`);
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60_000;
  if (unit === "h") return value * 3_600_000;
  throw new Error(`Invalid downsample_interval unit: ${unit}`);
}

// ---------------------------------------------------------------------------
// Local data store output
// ---------------------------------------------------------------------------

export class LocalStoreOutput implements Output {
  private config: LocalStoreConfig;
  private openDbs = new Map<string, Database>();

  constructor(config: LocalStoreConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // Create data directory if it doesn't exist
    mkdirSync(this.config.path, { recursive: true });

    // Open today's database (creates if new) — validates path is writable
    const todayFile = dailyFilename(BigInt(Date.now()) * NS_PER_MS);
    this.getOrOpenDb(todayFile);

    // Run retention on startup
    this.runRetention();
  }

  async write(batch: Metric[]): Promise<void> {
    if (batch.length === 0) return;

    // Group metrics by their daily file
    const grouped = new Map<string, Metric[]>();
    for (const metric of batch) {
      const file = dailyFilename(metric.timestamp);
      let arr = grouped.get(file);
      if (!arr) {
        arr = [];
        grouped.set(file, arr);
      }
      arr.push(metric);
    }

    // Write each group to its daily database
    for (const [file, metrics] of grouped) {
      this.writeToDailyDb(file, metrics);
    }
  }

  async close(): Promise<void> {
    // WAL checkpoint and close all open databases
    for (const [, db] of this.openDbs) {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (err) {
        console.warn(`[local_store] checkpoint error during shutdown: ${(err as Error).message}`);
      }
      db.close();
    }
    this.openDbs.clear();
  }

  // ---------------------------------------------------------------------------
  // Daily database management
  // ---------------------------------------------------------------------------

  private getOrOpenDb(filename: string, isRetry = false): Database {
    let db = this.openDbs.get(filename);
    if (db) return db;

    const dbPath = join(this.config.path, filename);

    try {
      db = new Database(dbPath);

      // PRAGMAs (PRD §11: WAL mode, synchronous=NORMAL, busy_timeout=5000)
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA busy_timeout = 5000");

      // WAL checkpoint on open (startup recovery per PRD §8 step 6)
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

      // Create tables
      db.exec(CREATE_METRICS_TABLE);
      db.exec(CREATE_METRICS_TIME_INDEX);
      db.exec(CREATE_METRICS_NAME_TIME_INDEX);
      db.exec(CREATE_TAG_INDEX_TABLE);

      // Integrity check (PRD §8 step 6: optional, move corrupt file aside)
      if (this.config.integrity_check) {
        const result = db.prepare("PRAGMA integrity_check").get() as {
          integrity_check: string;
        };
        if (result.integrity_check !== "ok") {
          throw new Error(`Integrity check failed: ${result.integrity_check}`);
        }
      }
    } catch (err) {
      // If integrity_check is enabled, treat any open/init error as corruption.
      // Guard against unbounded recursion: only attempt recovery once (isRetry).
      if (this.config.integrity_check && existsSync(dbPath) && !isRetry) {
        console.error(
          `[local_store] corruption detected in ${filename}: ${(err as Error).message}`,
        );
        try { db?.close(); } catch { /* ignore close errors on corrupt DB */ }
        // Move corrupt file aside (PRD §8: "move corrupt file aside, create fresh")
        const corruptPath = `${dbPath}.corrupt.${Date.now()}`;
        renameSync(dbPath, corruptPath);
        for (const ext of ["-wal", "-shm"]) {
          if (existsSync(dbPath + ext)) {
            try {
              renameSync(dbPath + ext, corruptPath + ext);
            } catch {
              // Ignore — WAL/SHM may already be cleaned up
            }
          }
        }
        // Retry once with a fresh database; isRetry=true prevents further recursion
        return this.getOrOpenDb(filename, true);
      }
      throw err;
    }

    this.openDbs.set(filename, db);
    return db;
  }

  private writeToDailyDb(filename: string, metrics: Metric[]): void {
    const db = this.getOrOpenDb(filename);

    const insertStmt = db.prepare(INSERT_METRIC);
    const upsertStmt = db.prepare(UPSERT_TAG_INDEX);

    const tx = db.transaction(() => {
      for (const metric of metrics) {
        const th = tagsHash(metric.tags);
        const tagsJson = tagsToJSON(metric.tags);
        const fieldsBlob = encodeFields(metric.fields);
        const quality = qualityToInt(metric);

        insertStmt.run(metric.timestamp, metric.name, th, tagsJson, fieldsBlob, quality);
        upsertStmt.run(metric.name, th, tagsJson, metric.timestamp, metric.timestamp);
      }
    });

    try {
      tx();
    } catch (e) {
      const err = e as Error;
      if (err.message.includes("SQLITE_BUSY")) {
        console.warn("[local_store] write blocked (SQLITE_BUSY), retrying once");
        try {
          tx();
        } catch (retryErr) {
          console.error("[local_store] write retry also failed:", (retryErr as Error).message);
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------

  /** Run retention policies: time-based and size-based. */
  runRetention(): void {
    this.retentionByTime();
    this.retentionBySize();
  }

  private retentionByTime(): void {
    const cutoffMs = Date.now() - this.config.retention_days * MS_PER_DAY;
    const files = this.listDailyFiles();

    for (const { filename, dateMs } of files) {
      if (dateMs < cutoffMs) {
        const filePath = join(this.config.path, filename);
        // Close if open
        const db = this.openDbs.get(filename);
        if (db) {
          db.close();
          this.openDbs.delete(filename);
        }
        try {
          unlinkSync(filePath);
        } catch {
          // Ignore if already deleted
        }
      }
    }
  }

  /**
   * Delete oldest daily files until total size is under retention_max_gb.
   * Note: the current day's file is never deleted (it's being actively written to),
   * so actual disk usage can exceed retention_max_gb by up to one day's data.
   */
  private retentionBySize(): void {
    const maxBytes = this.config.retention_max_gb * 1_073_741_824; // GB to bytes
    const files = this.listDailyFiles(); // sorted oldest first

    let totalSize = 0;
    for (const { filename } of files) {
      try {
        totalSize += statSync(join(this.config.path, filename)).size;
      } catch {
        // File may have been deleted by time-based retention
      }
    }

    // Delete oldest files until under limit
    for (const { filename } of files) {
      if (totalSize <= maxBytes) break;
      const filePath = join(this.config.path, filename);
      try {
        const fileSize = statSync(filePath).size;
        // Close if open
        const db = this.openDbs.get(filename);
        if (db) {
          db.close();
          this.openDbs.delete(filename);
        }
        unlinkSync(filePath);
        totalSize -= fileSize;
      } catch {
        // Ignore
      }
    }
  }

  /** List daily files sorted by date (oldest first). */
  private listDailyFiles(): { filename: string; dateMs: number }[] {
    if (!existsSync(this.config.path)) return [];
    const entries = readdirSync(this.config.path);
    const files: { filename: string; dateMs: number }[] = [];

    for (const entry of entries) {
      const dateMs = parseDailyFilename(entry);
      if (dateMs !== null) {
        files.push({ filename: entry, dateMs });
      }
    }

    files.sort((a, b) => a.dateMs - b.dateMs);
    return files;
  }

  // ---------------------------------------------------------------------------
  // Downsampling
  // ---------------------------------------------------------------------------

  /**
   * Downsample data older than downsample_after_days to downsample_interval.
   * Aggregates numeric fields to min/max/mean/count per interval boundary.
   * Non-numeric fields are dropped.
   */
  downsample(): void {
    const cutoffMs = Date.now() - this.config.downsample_after_days * MS_PER_DAY;
    const intervalMs = parseInterval(this.config.downsample_interval);
    const intervalNs = BigInt(intervalMs) * NS_PER_MS;
    const files = this.listDailyFiles();

    for (const { filename, dateMs } of files) {
      // Only downsample files older than threshold
      // Add one full day to dateMs since the file covers the entire day
      if (dateMs + MS_PER_DAY > cutoffMs) continue;

      const db = this.getOrOpenDb(filename);

      // Read all metrics from this file
      // TODO: Post-MVP — process in chunks via .iterate() or LIMIT/OFFSET to avoid
      // OOM on large daily files (100ms polling × 500 tags = 864K rows/day).
      const rows = db.prepare(
        "SELECT timestamp, name, tags_hash, tags, fields, quality FROM metrics ORDER BY timestamp",
      ).safeIntegers(true).all() as {
        timestamp: bigint;
        name: string;
        tags_hash: bigint;
        tags: string;
        fields: Uint8Array;
        quality: bigint;
      }[];

      if (rows.length === 0) continue;

      // Group by (name, tags_hash, interval_boundary)
      const buckets = new Map<string, {
        name: string;
        tags_hash: number;
        tags: string;
        quality: number;
        boundary: bigint;
        numericFields: Map<string, { min: number; max: number; sum: number; count: number }>;
      }>();

      for (const row of rows) {
        const ts = row.timestamp; // already bigint from safeIntegers
        const boundary = (ts / intervalNs) * intervalNs;
        const key = `${row.name}|${row.tags_hash}|${boundary}`;

        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            name: row.name,
            tags_hash: Number(row.tags_hash),
            tags: row.tags,
            quality: Number(row.quality),
            boundary,
            numericFields: new Map(),
          };
          buckets.set(key, bucket);
        }

        const fields = decodeFields(row.fields);
        for (const [fieldKey, value] of Object.entries(fields)) {
          // Aggregate number and bigint fields (PRD §11: "min/max/mean/count for each numeric field")
          let numVal: number;
          if (typeof value === "number") {
            numVal = value;
          } else if (typeof value === "bigint") {
            numVal = Number(value); // precision loss acceptable for aggregation
          } else {
            continue; // skip string and boolean fields
          }
          let agg = bucket.numericFields.get(fieldKey);
          if (!agg) {
            agg = { min: numVal, max: numVal, sum: numVal, count: 1 };
            bucket.numericFields.set(fieldKey, agg);
          } else {
            agg.min = Math.min(agg.min, numVal);
            agg.max = Math.max(agg.max, numVal);
            agg.sum += numVal;
            agg.count++;
          }
        }
      }

      // Replace original data with downsampled summaries
      const tx = db.transaction(() => {
        db.exec("DELETE FROM metrics");

        const insert = db.prepare(INSERT_METRIC);
        const upsertTag = db.prepare(UPSERT_TAG_INDEX);

        for (const bucket of buckets.values()) {
          const summaryFields: Record<string, number> = {};
          for (const [fieldKey, agg] of bucket.numericFields) {
            summaryFields[`${fieldKey}_min`] = agg.min;
            summaryFields[`${fieldKey}_max`] = agg.max;
            summaryFields[`${fieldKey}_mean`] = agg.sum / agg.count;
            summaryFields[`${fieldKey}_count`] = agg.count;
          }

          const fieldsBlob = pack(summaryFields);
          insert.run(bucket.boundary, bucket.name, bucket.tags_hash, bucket.tags, fieldsBlob, bucket.quality);
          upsertTag.run(bucket.name, bucket.tags_hash, bucket.tags, bucket.boundary, bucket.boundary);
        }
      });

      tx();
    }
  }

  // ---------------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------------

  /**
   * Export metrics in a time range to CSV.
   * Queries across all relevant daily files.
   * Returns CSV string (header + data rows).
   */
  exportCSV(fromNs: bigint, toNs: bigint): string {
    const files = this.listDailyFiles();
    const rows: { timestamp: bigint; name: string; tags: string; fields: Uint8Array; quality: bigint }[] = [];

    // Determine which daily files overlap with the time range
    const fromMs = Number(fromNs / NS_PER_MS);
    const toMs = Number(toNs / NS_PER_MS);

    for (const { filename, dateMs } of files) {
      // A daily file covers dateMs to dateMs + 1 day
      if (dateMs + MS_PER_DAY <= fromMs) continue;
      if (dateMs > toMs) continue;

      const db = this.getOrOpenDb(filename);
      const result = db.prepare(
        "SELECT timestamp, name, tags, fields, quality FROM metrics WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp",
      ).safeIntegers(true).all(fromNs, toNs) as typeof rows;

      rows.push(...result);
    }

    if (rows.length === 0) return "";

    // Collect all tag keys and field keys across all rows
    const tagKeys = new Set<string>();
    const fieldKeys = new Set<string>();
    const decodedRows: { timestamp: bigint; name: string; tags: Record<string, string>; fields: Record<string, FieldValue>; quality: bigint }[] = [];

    for (const row of rows) {
      const fields = decodeFields(row.fields);
      const tags = JSON.parse(row.tags) as Record<string, string>;
      for (const key of Object.keys(fields)) fieldKeys.add(key);
      for (const key of Object.keys(tags)) tagKeys.add(key);
      decodedRows.push({
        timestamp: row.timestamp,
        name: row.name,
        tags,
        fields,
        quality: row.quality,
      });
    }

    const sortedTagKeys = [...tagKeys].sort();
    const sortedFieldKeys = [...fieldKeys].sort();
    const header = ["timestamp", "name", ...sortedTagKeys.map(csvEscape), "quality", ...sortedFieldKeys.map(csvEscape)].join(",");
    const dataRows = decodedRows.map((row) => {
      const values = [
        String(row.timestamp),
        csvEscape(row.name),
        ...sortedTagKeys.map((key) => {
          const val = row.tags[key];
          return val !== undefined ? csvEscape(val) : "";
        }),
        String(row.quality),
        ...sortedFieldKeys.map((key) => {
          const val = row.fields[key];
          return val !== undefined ? csvEscape(String(val)) : "";
        }),
      ];
      return values.join(",");
    });

    return header + "\n" + dataRows.join("\n") + "\n";
  }

  // ---------------------------------------------------------------------------
  // Query (for testing and future use)
  // ---------------------------------------------------------------------------

  /**
   * Query metrics by time range across daily files.
   * Returns decoded rows sorted by timestamp.
   */
  query(fromNs: bigint, toNs: bigint): {
    timestamp: bigint;
    name: string;
    tags: Record<string, string>;
    fields: Record<string, FieldValue>;
    quality: number;
  }[] {
    const files = this.listDailyFiles();
    const results: {
      timestamp: bigint;
      name: string;
      tags: Record<string, string>;
      fields: Record<string, FieldValue>;
      quality: number;
    }[] = [];

    const fromMs = Number(fromNs / NS_PER_MS);
    const toMs = Number(toNs / NS_PER_MS);

    for (const { filename, dateMs } of files) {
      if (dateMs + MS_PER_DAY <= fromMs) continue;
      if (dateMs > toMs) continue;

      const db = this.getOrOpenDb(filename);
      const rows = db.prepare(
        "SELECT timestamp, name, tags, fields, quality FROM metrics WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp",
      ).safeIntegers(true).all(fromNs, toNs) as {
        timestamp: bigint;
        name: string;
        tags: string;
        fields: Uint8Array;
        quality: bigint;
      }[];

      for (const row of rows) {
        results.push({
          timestamp: row.timestamp,
          name: row.name,
          tags: JSON.parse(row.tags),
          fields: decodeFields(row.fields),
          quality: Number(row.quality),
        });
      }
    }

    results.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    return results;
  }
}

// ---------------------------------------------------------------------------
// CSV helper (local)
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function createLocalStoreOutput(config: LocalStoreConfig): LocalStoreOutput {
  return new LocalStoreOutput(config);
}
