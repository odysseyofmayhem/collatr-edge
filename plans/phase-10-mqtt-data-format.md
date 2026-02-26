# Phase 10 — MQTT Data Format Hardening

## Overview

Phase 10 addresses two related issues discovered during real-world smoke testing against public MQTT brokers (`configs/smoke-test-public.toml`):

1. **Parse error noise:** Wildcard subscriptions on public brokers deliver non-JSON payloads (NMEA GPS sentences, binary data). Every bad message produces two error-level log lines, flooding the console and hiding real errors.
2. **No auto-detection:** `data_format` only supports `"json"` and `"value"`. Real-world MQTT topics carry mixed payloads. An `"auto"` mode that tries JSON first and falls back to `"value"` is essential for wildcard subscriptions on brokers with heterogeneous devices.

**PRD impact:** Updates to §19 (MQTT consumer plugin notes) and Appendix A (config example) to document `data_format = "auto"` and `"string"` format options.

## PRD References

- §6 Plugin System — plugin error handling
- §14 Error Handling & Resilience — error logging conventions
- §19 MVP Plugin Inventory — `mqtt_consumer` plugin notes
- Appendix A — Full Config Example (mqtt_consumer section)

## Acceptance Criteria

- [ ] `data_format = "auto"` tries JSON parse first, falls back to `"value"` on failure — no error logged for the fallback
- [ ] `data_format = "string"` treats entire payload as a single string field (no numeric coercion)
- [ ] Parse errors (when `data_format = "json"`) are throttled: first 5 at `warn` level with full context, then periodic summary every 60s
- [ ] Parse errors downgraded from `error` to `warn` — parse failures from garbage data are expected noise, not system errors
- [ ] Binary/non-UTF8 payloads handled gracefully in all data formats (no crash, no infinite error loop)
- [ ] Existing tests still pass, new tests cover all new behaviour
- [ ] Smoke test config updated with comments documenting expected behaviour
- [ ] PRD §19 and Appendix A updated

## Tasks

### Task 10.0 — PRD Updates

**Files:** `prd/19-mvp-plugin-inventory.md`, `prd/appendix-a-full-config-example.md`

Update PRD to document:
1. In §19, expand `mqtt_consumer` notes: "Subscribe to MQTT topics. Supports JSON, plain value, string, and auto-detect payload formats. Auto mode tries JSON first, falls back to value parsing. Non-parseable payloads are silently treated as string values. Parse error logging is throttled to prevent log flooding from noisy wildcard subscriptions."
2. In Appendix A, update the mqtt_consumer config example to show `data_format = "json"` with a comment listing all options: `# Options: "json" (default), "value" (numeric or string), "string" (always string), "auto" (try json, fall back to value)`

### Task 10.1 — Add `data_format = "auto"` and `"string"` to MQTT Consumer

**File:** `src/plugins/inputs/mqtt-consumer.ts`

**Schema change:**
```typescript
data_format: z.enum(["json", "value", "string", "auto"]).default("json")
```

**Behaviour for each format:**

| Format | Behaviour |
|--------|-----------|
| `"json"` | Parse as JSON. Error on failure (throttled, see task 10.2). |
| `"value"` | Entire payload as single field. Try `Number()`, use string if NaN. |
| `"string"` | Entire payload as single string field. No numeric coercion. |
| `"auto"` | Try JSON parse. On failure, fall back to `"value"` behaviour silently (no error log, no `acc.addError()`). |

**Implementation in `handleMessage()`:**

Replace the current `if (this.config.data_format === "json")` / `else` block with a switch or if-chain covering all four formats. For `"auto"`:

```typescript
case "auto": {
  try {
    const parsed = JSON.parse(payloadStr);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      fields = flattenJson(parsed);
    } else {
      fields = { value: this.toFieldValue(parsed) };
    }
  } catch {
    // Auto mode: silent fallback to value — not an error
    const num = Number(payloadStr);
    fields = (isNaN(num) || payloadStr.trim() === "")
      ? { value: payloadStr }
      : { value: num };
  }
  break;
}
```

For `"string"`:
```typescript
case "string":
  fields = { value: payloadStr };
  break;
```

**Binary payload handling:** Before `JSON.parse`, check if `payloadStr` contains replacement characters (`\uFFFD`) or null bytes, which indicate binary data. For `"json"` format, this should trigger the throttled error path. For `"auto"`, skip straight to value fallback.

### Task 10.2 — Parse Error Throttling

**File:** `src/plugins/inputs/mqtt-consumer.ts`

Add private fields to `MqttConsumerInput`:
```typescript
private parseErrorCount = 0;
private lastParseErrorLogTime = 0;
private static readonly PARSE_ERROR_VERBOSE_LIMIT = 5;
private static readonly PARSE_ERROR_SUMMARY_INTERVAL_MS = 60_000;
```

Replace the catch block in `handleMessage()`:

```typescript
catch (error: unknown) {
  this.parseErrorCount++;
  const msg = error instanceof Error ? error.message : String(error);

  if (this.parseErrorCount <= MqttConsumerInput.PARSE_ERROR_VERBOSE_LIMIT) {
    // First N errors: full context at warn level
    getLogger().warn("payload parse error", {
      plugin: "mqtt_consumer",
      topic: event.topic,
      error: msg,
      error_count: this.parseErrorCount,
    });
    if (this.acc) this.acc.addError(new Error(`Payload parse error: ${msg}`));
  } else {
    // After threshold: periodic summary
    const now = Date.now();
    if (now - this.lastParseErrorLogTime >= MqttConsumerInput.PARSE_ERROR_SUMMARY_INTERVAL_MS) {
      this.lastParseErrorLogTime = now;
      getLogger().warn("payload parse errors (throttled)", {
        plugin: "mqtt_consumer",
        total_errors: this.parseErrorCount,
        since_last_summary: this.parseErrorCount - MqttConsumerInput.PARSE_ERROR_VERBOSE_LIMIT,
      });
      if (this.acc) this.acc.addError(
        new Error(`Payload parse errors: ${this.parseErrorCount} total (throttled)`)
      );
    }
    // Between summaries: silently increment, no log, no acc.addError()
  }
}
```

**Key design decisions:**
- Downgrade from `error` to `warn` — parse errors from garbage data are expected noise
- `acc.addError()` only called for first 5 and once per summary — prevents internal metrics flooding
- Counter is per-plugin-instance, not global (Rule 13: per-instance, not global)
- Threshold and interval are static constants, not config — YAGNI per Rule 7. If operators need to tune these, add config fields post-MVP.
- This throttling ONLY applies to `data_format = "json"` errors. `"auto"` mode doesn't trigger the catch block for JSON parse failures (it falls through to value parsing).

### Task 10.3 — Tests for New Data Formats

**File:** `test/unit/plugins/inputs/mqtt-consumer.test.ts`

New test cases:

**`data_format = "auto"`:**
1. Auto mode parses valid JSON object → fields extracted
2. Auto mode parses valid JSON primitive (number) → `{ value: 42 }`
3. Auto mode with non-JSON string → falls back to value (`{ value: "$GNRMC,..." }`)
4. Auto mode with numeric string → falls back to value (`{ value: 123.45 }`)
5. Auto mode with binary payload (Buffer with non-UTF8 bytes) → falls back to string value
6. Auto mode does NOT call `acc.addError()` on JSON parse failure (silent fallback)
7. Auto mode does NOT log errors on JSON parse failure

**`data_format = "string"`:**
8. String mode with text → `{ value: "hello" }`
9. String mode with numeric text → `{ value: "123.45" }` (no coercion)
10. String mode with empty string → `{ value: "" }`

**Parse error throttling (`data_format = "json"`):**
11. First 5 invalid JSON messages: each produces one `acc.addError()` call and one warn log
12. Messages 6-20: no `acc.addError()` calls, no log lines (between summaries)
13. After 60s (mock timer): summary log line with total count, one `acc.addError()` call
14. Plugin continues processing valid messages after throttled errors
15. Error counter is per-instance (two instances have independent counters)

**Binary payload handling:**
16. Binary payload with null bytes in `json` mode → throttled error
17. Binary payload with null bytes in `auto` mode → falls back to string value
18. Binary payload in `string` mode → string value (with replacement chars)
19. Binary payload in `value` mode → string value (NaN from Number())

**Existing test update:**
- Test at ~line 652 ("invalid JSON payload") still passes but now expects `warn` level (not `error`)

### Task 10.4 — Smoke Test Config Update

**File:** `configs/smoke-test-public.toml`

1. Change EMQX broker input to use `data_format = "auto"`:
```toml
[[inputs.mqtt_consumer]]
  alias = "emqx_public"
  servers = ["tcp://broker.emqx.io:1883"]
  topics = [
    "sensor/#",
    "device/#",
    "iot/#",
    "temperature/#",
    "collatr/smoke-test/#",
  ]
  qos = 0
  data_format = "auto"  # Public brokers carry mixed payloads (JSON, NMEA, binary)
  topic_tag = "topic"
  tags = { broker = "emqx" }
```

2. Add comment block at top of MQTT section:
```toml
# NOTE: Public MQTT brokers carry heterogeneous payloads from many devices.
# Wildcard subscriptions will receive JSON, plain text, NMEA GPS sentences,
# binary data, etc. Use data_format = "auto" for best results.
# Parse errors from non-JSON payloads are throttled (first 5 verbose,
# then periodic summaries every 60s).
```

## What This Does NOT Do

- No new data_format modes beyond `"auto"` and `"string"` (no CSV, no InfluxDB line protocol, no Sparkplug B decoding — all post-MVP)
- No changes to `Accumulator.addError()` interface
- No per-topic error tracking (simple per-instance counter is sufficient)
- No configurable throttle thresholds (YAGNI — static constants for now)
- No changes to other input plugins (Modbus, OPC-UA, Internal)

## Risks

| Risk | Mitigation |
|------|-----------|
| Auto mode hides real JSON errors | Only used when explicitly configured. Default remains `"json"`. |
| Throttling hides persistent config errors | First 5 errors always logged with full context. Operators see the problem. |
| Binary payloads cause UTF-8 decoding issues | `Buffer.toString("utf-8")` replaces invalid bytes with `\uFFFD`. Test this path explicitly. |

## Build Order

10.0 (PRD) → 10.1 (schema + auto/string) → 10.2 (throttling) → 10.3 (tests) → 10.4 (smoke config)

Tasks 10.1 and 10.2 modify the same file but different sections. The implementation agent should do them in order to avoid merge conflicts. Task 10.3 tests everything from 10.1 and 10.2.
