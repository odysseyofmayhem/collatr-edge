// CollatrEdge — TOFU trust store (SQLite)
// PRD ref: Appendix D §D.4: "Plugin stores the certificate fingerprint in the local trust store (SQLite)"
// Phase 9 review fix MF-1: replaced JSON file trust store with SQLite

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export interface TrustedServer {
  endpoint: string;
  thumbprint: string;
  trustedAt: string;
}

/**
 * SQLite-backed trust store for OPC-UA server certificate TOFU.
 * Stores trusted server certificate fingerprints per endpoint.
 */
export class TrustStore {
  private db: Database;
  private _path: string;

  constructor(dbPath: string) {
    this._path = dbPath;

    // Ensure parent directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trusted_servers (
        endpoint    TEXT PRIMARY KEY,
        thumbprint  TEXT NOT NULL,
        trusted_at  TEXT NOT NULL
      )
    `);
  }

  get path(): string {
    return this._path;
  }

  /** Trust a server certificate. Updates existing entry for same endpoint. */
  trust(endpoint: string, thumbprint: string): void {
    this.db
      .prepare(
        `INSERT INTO trusted_servers (endpoint, thumbprint, trusted_at)
         VALUES (?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           thumbprint = excluded.thumbprint,
           trusted_at = excluded.trusted_at`,
      )
      .run(endpoint, thumbprint.toUpperCase(), new Date().toISOString());
  }

  /** Get trusted server info for a specific endpoint. Returns null if not trusted. */
  get(endpoint: string): TrustedServer | null {
    const row = this.db
      .prepare(
        "SELECT endpoint, thumbprint, trusted_at FROM trusted_servers WHERE endpoint = ?",
      )
      .get(endpoint) as { endpoint: string; thumbprint: string; trusted_at: string } | null;

    if (!row) return null;
    return {
      endpoint: row.endpoint,
      thumbprint: row.thumbprint,
      trustedAt: row.trusted_at,
    };
  }

  /** List all trusted servers. */
  list(): TrustedServer[] {
    const rows = this.db
      .prepare(
        "SELECT endpoint, thumbprint, trusted_at FROM trusted_servers ORDER BY endpoint",
      )
      .all() as Array<{ endpoint: string; thumbprint: string; trusted_at: string }>;

    return rows.map((r) => ({
      endpoint: r.endpoint,
      thumbprint: r.thumbprint,
      trustedAt: r.trusted_at,
    }));
  }

  /** Check if a specific endpoint+thumbprint combination is trusted. */
  isTrusted(endpoint: string, thumbprint: string): boolean {
    const entry = this.get(endpoint);
    return entry !== null && entry.thumbprint === thumbprint.toUpperCase();
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
