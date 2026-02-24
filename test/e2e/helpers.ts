// Shared E2E test helpers
// Extracted to avoid duplication across test files (Phase 5 review finding Y2)

import { readdirSync } from "node:fs";
import { Database } from "bun:sqlite";

import { LocalStoreConfigSchema } from "@plugins/outputs/local-store";
import { decodeFields } from "@plugins/outputs/local-store";

// ---------------------------------------------------------------------------
// Daily DB helpers
// ---------------------------------------------------------------------------

/**
 * Find daily DB files in a directory, sorted alphabetically (= chronological).
 * Returns filenames only (not full paths) — caller must join with directory.
 */
export function findDailyFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith("data_") && f.endsWith(".db"))
    .sort();
}

/**
 * Open a daily SQLite DB file and return all metrics rows (decoded).
 * Takes a full path to the DB file.
 */
export function queryDailyDb(dbPath: string): {
  timestamp: bigint;
  name: string;
  tags: Record<string, string>;
  fields: Record<string, unknown>;
}[] {
  const db = new Database(dbPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const rows = db
    .prepare(
      "SELECT timestamp, name, tags, fields FROM metrics ORDER BY timestamp",
    )
    .safeIntegers(true)
    .all() as {
    timestamp: bigint;
    name: string;
    tags: string;
    fields: Uint8Array;
  }[];
  db.close();
  return rows.map((row) => ({
    timestamp: row.timestamp,
    name: row.name,
    tags: JSON.parse(row.tags) as Record<string, string>,
    fields: decodeFields(row.fields) as Record<string, unknown>,
  }));
}

/** Count metrics rows in a daily DB file. Takes a full path. */
export function countRows(dbPath: string): number {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const row = db.prepare("SELECT COUNT(*) as cnt FROM metrics").get() as {
    cnt: number;
  };
  db.close();
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Create a LocalStoreConfig with sensible test defaults. */
export function makeLocalStoreConfig(
  path: string,
  overrides: Record<string, unknown> = {},
) {
  return LocalStoreConfigSchema.parse({
    enabled: true,
    path,
    retention_days: 90,
    retention_max_gb: 10,
    rotation: "daily",
    downsample_after_days: 7,
    downsample_interval: "1m",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Error capture helper
// ---------------------------------------------------------------------------

/**
 * Capture error-level log output for assertions while still writing to stderr.
 *
 * Phase 6 replaced all console.error in src/ with getLogger().error() which
 * writes JSON lines to process.stderr.write(). This helper intercepts stderr,
 * parses JSON log lines, and captures error-level entries as human-readable
 * strings ("msg: error") so existing .includes() assertions still work.
 */
export function captureErrors(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);

  process.stderr.write = ((
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    // Try to parse each line as a JSON log entry
    for (const line of str.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry.level === "error") {
          // Reconstruct a human-readable string containing both msg and error
          const parts: string[] = [entry.msg];
          if (entry.error) parts.push(entry.error);
          errors.push(parts.join(": "));
        }
      } catch {
        // Not JSON — ignore (could be non-logger stderr output)
      }
    }
    // Still write to stderr for debugging visibility
    return originalWrite(chunk, encodingOrCb as BufferEncoding, cb as any);
  }) as typeof process.stderr.write;

  return {
    errors,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}
