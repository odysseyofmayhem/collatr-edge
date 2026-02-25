// CollatrEdge — CSV export endpoint with UTC and local timezone columns
// PRD refs: §17 Local Web UI (Data Export), §11 Local Data Store, §22 Acceptance Criteria (Scenario 4)
// Phase 9 Task 9.5: CSV export with dual timestamps
//
// Approach: Post-process LocalStoreOutput.exportCSV() to prepend formatted timestamp columns.
// The existing exportCSV() returns CSV with nanosecond timestamp as the first column.
// We add timestamp_utc (ISO 8601 UTC) and timestamp_local (ISO 8601 with TZ offset) columns.

import type { WebUIAdapter } from "../adapter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NS_PER_MS = 1_000_000n;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/export?from=<iso>&to=<iso>&tz=<timezone>
 *
 * Export metrics from the local store as CSV with UTC and local timezone timestamp columns.
 *
 * - from/to: ISO 8601 timestamps (required)
 * - tz: IANA timezone name for the local timestamp column (optional, defaults to system TZ)
 *
 * Returns:
 * - 200 with text/csv and Content-Disposition: attachment on success
 * - 204 No Content when no data in range (not an empty CSV with just headers)
 * - 400 for invalid parameters
 * - 503 when no local store is configured
 */
export function handleExport(
  adapter: WebUIAdapter,
  query: { from?: string; to?: string; tz?: string },
): Response {
  // Validate from/to parameters
  if (!query.from || !query.to) {
    return new Response(
      JSON.stringify({ error: "from and to parameters are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const fromMs = new Date(query.from).getTime();
  const toMs = new Date(query.to).getTime();

  if (isNaN(fromMs) || isNaN(toMs)) {
    return new Response(
      JSON.stringify({ error: "invalid from/to timestamp format" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (fromMs > toMs) {
    return new Response(
      JSON.stringify({ error: "from must be before to" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Validate timezone if provided
  const tz = query.tz || undefined;
  if (tz) {
    try {
      // Validate IANA timezone name by attempting to format with it
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return new Response(
        JSON.stringify({ error: `invalid timezone: ${tz}` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  const store = adapter.getLocalStore();
  if (!store) {
    return new Response(
      JSON.stringify({ error: "local store not configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const fromNs = BigInt(fromMs) * NS_PER_MS;
  const toNs = BigInt(toMs) * NS_PER_MS;

  const rawCsv = store.exportCSV(fromNs, toNs);

  // Empty result — no data in range
  if (!rawCsv) {
    return new Response(null, { status: 204 });
  }

  // Post-process: prepend formatted timestamp columns
  const csv = addFormattedTimestamps(rawCsv, tz);

  const filename = `collatr-edge-export-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

/**
 * Post-process CSV to add timestamp_utc and timestamp_local columns.
 *
 * Input CSV has "timestamp" (nanoseconds) as the first column.
 * Output CSV replaces it with:
 *   timestamp_utc, timestamp_local, timestamp_ns, ...rest
 *
 * timestamp_utc:  ISO 8601 in UTC (Z suffix)
 * timestamp_local: ISO 8601 with timezone offset
 * timestamp_ns:  original nanosecond value (preserved for machine consumption)
 */
export function addFormattedTimestamps(csv: string, tz?: string): string {
  const lines = csv.split("\n");
  if (lines.length === 0) return csv;

  // Process header
  const header = lines[0]!;
  const headerParts = header.split(",");
  // Replace "timestamp" with the three columns
  headerParts.splice(0, 1, "timestamp_utc", "timestamp_local", "timestamp_ns");
  const newHeader = headerParts.join(",");

  // Process data rows
  const newLines = [newHeader];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue; // skip empty trailing line

    const parts = line.split(",");
    const nsStr = parts[0]!;
    const nsValue = BigInt(nsStr);
    const msValue = Number(nsValue / NS_PER_MS);
    const date = new Date(msValue);

    const utcStr = date.toISOString();
    const localStr = formatLocalTimestamp(date, tz);

    parts.splice(0, 1, csvEscape(utcStr), csvEscape(localStr), nsStr);
    newLines.push(parts.join(","));
  }

  return newLines.join("\n") + "\n";
}

/**
 * Format a Date as ISO 8601 with timezone offset.
 * Uses Intl.DateTimeFormat for timezone-aware formatting.
 */
function formatLocalTimestamp(date: Date, tz?: string): string {
  // Get the date/time parts in the target timezone
  const options: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  };

  const formatter = new Intl.DateTimeFormat("en-GB", options);
  const parts = formatter.formatToParts(date);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  const fractionalSecond = get("fractionalSecond");

  // Get the timezone offset in the target timezone
  const offset = getTimezoneOffset(date, tz);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${fractionalSecond}${offset}`;
}

/**
 * Get the UTC offset string (e.g., "+01:00", "-05:00", "+00:00") for a date
 * in the given timezone.
 */
function getTimezoneOffset(date: Date, tz?: string): string {
  // Format with both UTC and the target timezone to compute offset
  const utcFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const localFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const utcParts = utcFormatter.formatToParts(date);
  const localParts = localFormatter.formatToParts(date);

  const getNum = (parts: Intl.DateTimeFormatPart[], type: string): number =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

  const utcDate = new Date(Date.UTC(
    getNum(utcParts, "year"),
    getNum(utcParts, "month") - 1,
    getNum(utcParts, "day"),
    getNum(utcParts, "hour") === 24 ? 0 : getNum(utcParts, "hour"),
    getNum(utcParts, "minute"),
  ));

  const localDate = new Date(Date.UTC(
    getNum(localParts, "year"),
    getNum(localParts, "month") - 1,
    getNum(localParts, "day"),
    getNum(localParts, "hour") === 24 ? 0 : getNum(localParts, "hour"),
    getNum(localParts, "minute"),
  ));

  const diffMinutes = Math.round((localDate.getTime() - utcDate.getTime()) / 60000);

  if (diffMinutes === 0) return "+00:00";

  const sign = diffMinutes > 0 ? "+" : "-";
  const absDiff = Math.abs(diffMinutes);
  const hours = Math.floor(absDiff / 60);
  const minutes = absDiff % 60;

  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// CSV helper
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
