// CollatrEdge — File output plugin
// PRD refs: §19 MVP Plugin Inventory (file: JSON-lines or CSV), Appendix A

import { z } from "zod/v4";
import { appendFile, writeFile, access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Output } from "@core/plugin-types";
import type { Metric, FieldValue } from "@core/metric";
import { toJSON } from "@plugins/outputs/stdout";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export const FileOutputConfigSchema = z.object({
  path: z.string().describe("Output file path"),
  data_format: z.enum(["json", "csv"]).default("json")
    .describe("Output format: 'json' for JSON-lines, 'csv' for CSV with header"),
});

export type FileOutputConfig = z.infer<typeof FileOutputConfigSchema>;

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Escape a CSV field value. Wraps in quotes if it contains comma, quote, or newline. */
function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Format a FieldValue as a CSV-safe string. */
function fieldToCSV(value: FieldValue): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return csvEscape(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

export class FileOutput implements Output {
  private config: FileOutputConfig;
  private csvColumns: string[] | null = null;
  private headerWritten = false;

  constructor(config: FileOutputConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // Ensure parent directory exists
    const dir = dirname(this.config.path);
    await mkdir(dir, { recursive: true });

    // Create file if it doesn't exist (touch), otherwise leave existing content
    try {
      await access(this.config.path);
      // File exists — append mode, nothing to do
    } catch {
      // File doesn't exist — create empty
      await writeFile(this.config.path, "");
    }
  }

  async write(batch: Metric[]): Promise<void> {
    if (batch.length === 0) return;

    if (this.config.data_format === "csv") {
      await this.writeCSV(batch);
    } else {
      await this.writeJSON(batch);
    }
  }

  async close(): Promise<void> {
    // appendFile auto-flushes; nothing to close.
    // Reset CSV state for potential reuse.
    this.csvColumns = null;
    this.headerWritten = false;
  }

  // ---------------------------------------------------------------------------
  // Format writers
  // ---------------------------------------------------------------------------

  private async writeJSON(batch: Metric[]): Promise<void> {
    const lines = batch.map((m) => toJSON(m) + "\n").join("");
    await appendFile(this.config.path, lines);
  }

  private async writeCSV(batch: Metric[]): Promise<void> {
    // Determine columns from first batch if not yet established.
    // Note: column schema is fixed after first write — new fields appearing
    // in later batches are silently omitted. This is by design for append-only
    // CSV where re-writing the header is not feasible.
    if (!this.csvColumns) {
      this.csvColumns = this.buildColumns(batch);
    }

    let output = "";

    // Write header on first CSV write (strip internal tag:/field: prefixes)
    if (!this.headerWritten) {
      const headers = this.csvColumns.map((col) => {
        if (col.startsWith("tag:")) return csvEscape(col.slice(4));
        if (col.startsWith("field:")) return csvEscape(col.slice(6));
        return csvEscape(col);
      });
      output += headers.join(",") + "\n";
      this.headerWritten = true;
    }

    // Write data rows
    for (const metric of batch) {
      const row: string[] = [];
      for (const col of this.csvColumns) {
        if (col === "timestamp") {
          row.push(metric.timestamp.toString());
        } else if (col === "name") {
          row.push(csvEscape(metric.name));
        } else if (col.startsWith("tag:")) {
          const tagKey = col.slice(4);
          row.push(csvEscape(metric.getTag(tagKey) ?? ""));
        } else if (col.startsWith("field:")) {
          const fieldKey = col.slice(6);
          const value = metric.getField(fieldKey);
          row.push(value !== undefined ? fieldToCSV(value) : "");
        }
      }
      output += row.join(",") + "\n";
    }

    await appendFile(this.config.path, output);
  }

  /**
   * Build CSV column list from the first batch.
   * Order: timestamp, name, sorted tags (prefixed tag:), sorted fields (prefixed field:).
   * The prefixes are used internally for column lookup but stripped in the header.
   */
  private buildColumns(batch: Metric[]): string[] {
    const tagKeys = new Set<string>();
    const fieldKeys = new Set<string>();

    for (const metric of batch) {
      for (const key of metric.tags.keys()) tagKeys.add(key);
      for (const key of metric.fields.keys()) fieldKeys.add(key);
    }

    const columns = ["timestamp", "name"];
    for (const key of [...tagKeys].sort()) columns.push(`tag:${key}`);
    for (const key of [...fieldKeys].sort()) columns.push(`field:${key}`);

    return columns;
  }
}

export function createFileOutput(config: FileOutputConfig): FileOutput {
  return new FileOutput(config);
}
