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
 * Capture console.error calls for assertions while still logging to stderr.
 * Returns captured error strings and a restore function.
 */
export function captureErrors(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
    original.apply(console, args); // still log to stderr for debugging visibility
  };
  return {
    errors,
    restore: () => {
      console.error = original;
    },
  };
}
