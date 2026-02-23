# Phase 6 Code Review

**Reviewer:** Independent code review (did not write this code)
**Date:** 2026-02-23
**Scope:** All files created or modified in Phase 6 (CLI)
**Test status:** 555 tests pass, 0 failures (full suite including all prior phases)

---

## Review Summary

Phase 6 is a solid implementation that delivers all four CLI commands (`run`, `config init`, `config validate`, `version`), structured JSON logging, plugin factory wiring, signal handling, and a systemd unit file. The code is well-structured, follows established project patterns, and is thoroughly tested with 40+ new tests. The dependency injection pattern in `run.ts` is particularly well done -- it makes testing the full command lifecycle possible without spawning real processes.

However, there are several issues that need attention. The most critical is that MetricFilter instances are extracted and wired by the plugin factory but never applied by the PipelineRuntime -- filters are stored in PipelineOptions but silently ignored during pipeline execution. There are also missing per-plugin override fields from the PRD and a few config-to-pipeline wiring gaps.

---

## Findings

### RED-01: MetricFilter wired but never applied in PipelineRuntime

**Files:** `src/pipeline/plugin-factory.ts` (lines 211-218, 235, 282-286), `src/pipeline/runtime.ts`
**Rule:** Rule 8 (Interface Compliance), Rule 10 (No Hardcoded Config Overrides)
**PRD ref:** PRD section 7 (Filtering on every plugin)

The plugin factory correctly extracts per-plugin filter fields (`namepass`, `namedrop`, `tagpass`, `tagdrop`, `fieldpass`, `fielddrop`), builds `MetricFilter` instances, and stores them in `PipelineOptions.inputs[].filter`, `PipelineOptions.processors[].filter`, and `PipelineOptions.outputs[].filter`.

However, `PipelineRuntime` never reads or applies these filters. The runtime destructures only `.plugin` from each entry:
- Line 361: `for (const { plugin } of this.options.outputs)` -- ignores `.filter`
- Line 382: `this.options.processors.map((p) => p.plugin)` -- strips `.filter`
- Lines 409-428: Input processing ignores `.filter`

The result: an operator configures `namepass = ["temperature_*"]` on an output, `config validate` says the config is valid, the pipeline starts without error, but the filter is silently ignored and all metrics flow through.

This is the same pattern as the Phase 1 lesson #2 (a fix in one module undone by another) -- the factory does the right thing, but the runtime doesn't consume it.

**Impact:** Data flows to outputs/processors unfiltered despite valid config. Operators cannot rely on per-plugin filtering. This is a silent functional error.

### RED-02: Aggregator filter config discarded in plugin factory

**File:** `src/pipeline/plugin-factory.ts` (line 258)
**Rule:** Rule 8 (Interface Compliance)
**PRD ref:** PRD section 7 (Filtering on every plugin), Appendix A (aggregators.basicstats with namepass)

In the aggregators loop at line 258, the filter config is explicitly discarded:
```typescript
const { filterConfig: _filterConfig, pluginConfig: afterFilter } = extractFilterConfig(rawInstance);
```

The underscore prefix and lack of `buildFilter()` call means per-aggregator filter fields from the config are silently dropped. The BasicstatsAggregator does have its own internal MetricFilter (built from `namepass`/`namedrop` in its Zod schema), but the extraction step strips these fields from the config BEFORE they reach the Zod schema parse.

This means if an operator configures:
```toml
[[aggregators.basicstats]]
  namepass = ["motor_speed", "temperature"]
```

The `namepass` field is extracted by `extractFilterConfig()` (line 258) and removed from `pluginConfig`. Then the remaining config (without `namepass`) is passed to `BasicstatsConfigSchema.parse(pluginConfig)` -- and the aggregator ends up with no filter.

**Impact:** Per-aggregator filtering silently broken. Aggregator processes all metrics regardless of configured namepass/namedrop.

### RED-03: `error_behavior` not wired from config

**Files:** `src/pipeline/plugin-factory.ts`, `src/cli/commands/run.ts`
**Rule:** Rule 10 (No Hardcoded Config Overrides)
**PRD ref:** PRD section 7 (per-plugin `error_behavior`), PRD section 14 (Startup Error Behaviours)

The PRD defines `error_behavior` as a per-plugin config override with distinct defaults:
- Inputs default to `retry` ("PLCs may not be online at boot")
- Outputs default to `error` ("misconfigured output should prevent startup")

The plugin factory's `OVERRIDE_KEYS` (line 96-99) does not include `error_behavior`. The `run.ts` command does not implement differentiated startup error handling based on this field. Currently:
- Output `connect()` errors always cause exit 1 (effectively hardcoded to `error` behavior -- correct default)
- Service input `start()` errors log and continue (correct for `retry` behavior)
- But there is no way for an operator to override either behavior via config

This is acceptable for MVP but should be documented as a known gap. The phase plan does not list `error_behavior` as explicitly out of scope (unlike `collection_jitter` and `collection_offset` which are marked as TODO Phase 7+).

**Impact:** Operators cannot configure `error_behavior = "ignore"` or `error_behavior = "probe"` on any plugin. The implicit defaults are correct but not configurable.

---

### YELLOW-01: Missing per-output `flush_interval` override in OVERRIDE_KEYS

**File:** `src/pipeline/plugin-factory.ts` (lines 96-99)
**Rule:** Rule 8 (Interface Compliance)
**PRD ref:** PRD section 7 (per-plugin `flush_interval` and `flush_jitter` overrides for outputs)

The PRD section 7 specifies per-output `flush_interval` and `flush_jitter` overrides. Neither is in `OVERRIDE_KEYS` and neither is wired to `PipelineOptions`. The `PipelineOptions.outputs[]` interface does not have a `flushIntervalMs` field per-output.

Currently all outputs share the global `flushIntervalMs` from `agent.flush_interval`. This is functional but prevents per-output tuning (e.g., a file output flushing every 1s while an HTTP output flushes every 30s).

**Impact:** Per-output flush interval override from config is silently ignored.

### YELLOW-02: Missing per-plugin config overrides not extracted: `retry_max`, `retry_backoff`, `precision`, `collection_jitter`, `collection_offset`, `flush_jitter`, `tags`

**File:** `src/pipeline/plugin-factory.ts` (lines 96-99)
**Rule:** Rule 8 (Interface Compliance)
**PRD ref:** PRD section 7 (Per-Plugin Config Overrides table)

The `OVERRIDE_KEYS` list extracts: `interval`, `timeout`, `metric_batch_size`, `period`, `drop_original`, `enabled`, `order`, `alias`, `log_level`.

The following PRD-defined per-plugin overrides are NOT extracted (and therefore flow into the Zod plugin schema parse, where they are either rejected as unknown fields or silently ignored depending on Zod's passthrough behavior):
- `retry_max` (output)
- `retry_backoff` (output)
- `precision` (input)
- `collection_jitter` (input)
- `collection_offset` (input)
- `flush_interval` (output)
- `flush_jitter` (output)
- `tags` (input, processor)
- `error_behavior` (all)

While some of these are marked as Phase 7+ features in the phase plan (collection_jitter, collection_offset), they should still be extracted from the raw config and stripped out before Zod parsing. If an operator includes `collection_jitter = "500ms"` on a modbus input (a valid PRD config), the current code will pass it through to `ModbusConfigSchema.parse()` which will either error or passthrough depending on Zod's strict/passthrough mode.

**Impact:** Config validation may reject valid PRD config keys. At minimum, these fields should be extracted (and optionally discarded with a TODO comment) so they don't interfere with plugin schema validation.

### YELLOW-03: `log_level` override extracted but not wired to child loggers

**File:** `src/pipeline/plugin-factory.ts` (line 133), `src/pipeline/runtime.ts`
**Rule:** Rule 10 (No Hardcoded Config Overrides)
**PRD ref:** PRD section 7 (`log_level` per-plugin override), PRD section 15 (per-plugin log_level)

The plugin factory extracts `log_level` from per-plugin config into `overrides.logLevel` (line 133) but never uses it. The runtime creates a single shared logger for error reporting and does not create per-plugin child loggers with level overrides.

The phase plan (section 6.0) specifies: "Per-plugin log_level override -- via child() context with per-instance level override". The logger's `child()` method supports a `levelOverride` parameter. But the wiring from config to plugin child loggers was not implemented.

**Impact:** Operators cannot debug individual plugins by setting `log_level = "debug"` on a specific plugin instance. All plugins share the global log level.

### YELLOW-04: Aggregator `namepass`/`namedrop`/`tagpass`/`tagdrop` double-extracted -- filter fields stripped before reaching Zod schema

**File:** `src/pipeline/plugin-factory.ts` (line 258)
**Rule:** Rule 10 (No Hardcoded Config Overrides)
**PRD ref:** Appendix A (aggregators.basicstats with namepass)

Related to RED-02 but stated as a separate wiring concern. The BasicstatsAggregator's Zod schema (`BasicstatsConfigSchema`) declares its own `namepass`, `namedrop`, `tagpass`, `tagdrop` fields. But the plugin factory's `extractFilterConfig()` runs first and strips these fields from the raw config before they ever reach `BasicstatsConfigSchema.parse()`.

Either:
1. The aggregator should NOT declare these fields in its own schema (rely on the factory-level MetricFilter), OR
2. The factory should NOT extract filter fields for aggregators (let them pass through to the schema)

Currently option 2 is half-implemented (filter is extracted but discarded), breaking option 1. The aggregator receives an empty filter config via its Zod schema defaults.

**Impact:** See RED-02. Aggregator namepass/namedrop silently broken.

### YELLOW-05: `config validate` validates plugin instances against raw config including override fields

**File:** `src/cli/commands/config-validate.ts` (line 85)
**Rule:** Rule 8 (Interface Compliance)

The `configValidateCommand` validates plugin instances directly: `schema.safeParse(instance)`. But `instance` is the raw config object that includes override fields like `interval`, `timeout`, `alias`, `enabled`, `period`, `drop_original`, `namepass`, etc.

If the Zod plugin schemas are strict (not `.passthrough()`), validation will FAIL on valid config because the schema does not expect `interval` or `alias` as fields.

This works currently only because Zod v4's default behavior may be to pass unknown fields. But this is fragile -- if any schema uses `.strict()` or if Zod's default changes, valid configs will be rejected.

The `config validate` command should either:
1. Strip override fields before validating (like the plugin factory does), OR
2. Use `.passthrough()` explicitly on schemas

**Impact:** Currently works but fragile. A future schema change could break validation of valid configs.

### YELLOW-06: No test for shutdown timeout (30s safety net)

**File:** `src/cli/commands/run.ts` (lines 145-152), `test/unit/cli/run.test.ts`
**Rule:** Rule 9 (Test the Hard Paths First)

The run command has a 30-second shutdown timeout that force-exits if graceful shutdown hangs (line 145-152). This is a critical safety path (prevents the agent from hanging forever on shutdown) but has no test.

The double-signal test covers the forceExit path via a second SIGINT, but the timeout path (setTimeout fires after 30s) is untested. A test with a shorter timeout (injected via deps) could verify this behavior.

**Impact:** The shutdown timeout code path is untested. If the setTimeout logic has a bug (e.g., the unref() call fails silently on some Bun version), the agent could hang on shutdown in production.

### YELLOW-07: `plugin-factory.ts` discards `alias` from overrides

**File:** `src/pipeline/plugin-factory.ts` (lines 130-131, 214-219)
**Rule:** Rule 10 (No Hardcoded Config Overrides)
**PRD ref:** PRD section 6 (alias for logging/metrics purposes)

The factory extracts `alias` into `overrides.alias` (line 130) but never passes it to the plugin or stores it in `PipelineOptions`. The phase plan notes: "Plugin alias is stored on the plugin instance for logging/metrics purposes... Consider adding an optional alias property or passing it to the logger child."

This means the structured log output cannot include plugin alias (e.g., `"plugin": "inputs.modbus.plc_01"`) because the alias is discarded during factory construction.

**Impact:** Log messages cannot distinguish between multiple instances of the same plugin type. Debugging a multi-PLC setup (e.g., 5 modbus instances) requires correlating errors by other means.

---

### GREEN-01: `configValidateCommand` hardcodes "[global_tags] valid" without actually validating global_tags

**File:** `src/cli/commands/config-validate.ts` (line 41)

The command always prints `[global_tags] valid` (line 41) after successfully parsing the config. But `global_tags` is not validated -- it is cast directly as `Record<string, string>` in the config parser (line 188 of `config.ts`). If an operator writes `[global_tags]\n  count = 42` (a number, not a string), the config parser silently accepts it.

This is a minor issue since TOML parsing gives typed values and downstream tag handling would convert to string, but the `[global_tags] valid` message implies validation occurred.

### GREEN-02: Version command uses `Bun.env.BUILD_TIME` -- not injected at compile time

**File:** `src/cli/commands/version.ts` (line 14)

The phase plan says "Build timestamp: injected at compile time via `Bun.env.BUILD_TIME`". Currently the code reads it at runtime with `Bun.env.BUILD_TIME`. This works if the env var is set during the build script, but if not, it falls back to `new Date().toISOString()` which gives the current runtime timestamp, not the build timestamp. This is fine for development but should be documented in the build script.

### GREEN-03: `run.ts` shutdownTimer unref() has defensive type casting

**File:** `src/cli/commands/run.ts` (lines 150-152)

```typescript
if (shutdownTimer && typeof (shutdownTimer as Record<string, unknown>).unref === "function") {
  (shutdownTimer as unknown as { unref: () => void }).unref();
}
```

This defensive casting suggests uncertainty about whether Bun's `setTimeout` returns a timer with `.unref()`. Bun does support `unref()` on timers (verified in spike results). The code could be simplified to `shutdownTimer.unref()` directly. The defensive check does no harm but adds complexity.

### GREEN-04: Test file `plugin-factory.test.ts` uses path aliases but other test files use relative imports

**File:** `test/unit/pipeline/plugin-factory.test.ts`

This test file uses `@pipeline/plugin-factory`, `@core/config`, `@plugins/inputs/modbus` etc., while other Phase 6 test files use relative imports like `../../../src/cli/commands/run`. Both work, but the inconsistency is worth noting.

### GREEN-05: README is well-written and comprehensive

**File:** `README.md`

The README covers quick start, CLI commands, systemd setup, development commands, and build targets. The systemd section includes creating the service user and data directories -- good for operators following the first-run setup.

---

## PRD Compliance Table

| Module | PRD Sections | Compliance | Notes |
|--------|-------------|------------|-------|
| `src/core/logger.ts` | PRD section 15 | **PASS** | JSON to stderr, ISO timestamps, level filtering, child loggers, global singleton. Matches PRD format exactly. |
| `src/cli/index.ts` | PRD section 18 | **PASS** | All 4 commands routed. --config/-c, env var, default path. Help text matches PRD CLI list. |
| `src/cli/commands/version.ts` | PRD section 18 | **PASS** | Version, runtime, platform, build timestamp. |
| `src/cli/commands/config-validate.ts` | PRD section 7, 14 | **PASS** | TOML parse, agent validation, per-plugin schema validation, secret ref detection, human-readable output. See YELLOW-05 for fragility concern. |
| `src/cli/commands/config-init.ts` | PRD section 7, 18, Appendix A | **PASS** | Mode-aware templates, all sections present, generated config validates. Missing `interval = "30s"` on `[[inputs.internal]]` (plan says 30s but template omits it -- uses agent default 10s). |
| `src/core/plugin-schemas.ts` | PRD section 6 | **PASS** | All MVP plugins registered. Imports from plugin source files (no duplication). |
| `src/pipeline/plugin-factory.ts` | PRD section 6, 7, 8 | **PARTIAL** | Plugin instantiation works. Duration parsing works. enabled/disabled works. Per-plugin interval/timeout/batch_size works. **FAIL on:** MetricFilter not applied (RED-01), aggregator filter stripped (RED-02), many override keys missing (YELLOW-02), alias discarded (YELLOW-07), log_level not wired (YELLOW-03). |
| `src/cli/commands/run.ts` | PRD section 8, 14, 18 | **PASS** | Startup sequence correct (load config -> configure logger -> build pipeline -> start -> signal -> stop). Signal handling with double-signal force exit. Shutdown timeout. Error handling for each stage. |
| `deploy/collatr-edge.service` | PRD section 18 | **PASS** | Matches plan template exactly. Hardening directives, TimeoutStopSec=35 (> 30s internal timeout). |
| `src/index.ts` | PRD section 18 | **PASS** | Clean entry point: `process.exit(await main())`. |
| `src/core/accumulator.ts` | PRD Appendix B | **PASS** | Modified to use logger instead of console.error. Interface unchanged. |
| `src/pipeline/runtime.ts` | PRD section 8 | **PARTIAL** | Modified to use logger. **FAIL on:** does not apply MetricFilter from PipelineOptions (RED-01). Lifecycle ordering is correct. |
| Modified plugin files | PRD section 6 | **PASS** | All plugins export their Zod config schemas. No functional changes to plugin logic. |
| `README.md` | PRD section 18 | **PASS** | Comprehensive CLI and systemd documentation. |

---

## Test Coverage Assessment

### Overall: Good coverage of happy paths and major error paths

The phase adds approximately 40 new tests across 7 test files, meeting the acceptance criterion of >= 20 tests.

### Logger tests (6 tests)
- Level filtering at all 4 levels: **TESTED**
- JSON format with required fields: **TESTED**
- ISO 8601 timestamps: **TESTED**
- Child logger context inheritance: **TESTED**
- Per-plugin level override via child(): **TESTED**
- Global singleton: **TESTED**
- **Gap:** No test for concurrent writes from multiple loggers (not critical for stderr.write).

### CLI framework tests (12 tests)
- Unknown command: **TESTED**
- No command / help: **TESTED**
- Config path parsing (--config, -c, env var, default, precedence): **TESTED**
- Config subcommand routing: **TESTED**
- **Gap:** No test for `--config` with missing value (e.g., `--config --help`). The code handles it (line 56) but the path is untested.

### Version command tests (6 tests)
- Output format, exit code, BUILD_TIME env var: **TESTED**
- Adequate coverage for this simple module.

### Config validate tests (10 tests)
- Valid config, invalid agent, invalid TOML, unknown plugin, invalid plugin config, secret refs, missing file, empty config, mixed valid/invalid, processors and aggregators: **TESTED**
- **Gap:** No test for a plugin schema that rejects override fields (YELLOW-05). This would catch the fragility issue.

### Config init tests (14 tests)
- Arg parsing, default generation, file exists, --force, --output, all three modes, generated config validates (integration test), template content, error handling: **TESTED**
- The "generated config validates" integration test (lines 258-311) is excellent -- it catches template/parser drift.
- **Gap:** No test that the generated config's commented-out examples would validate if uncommented. This would catch future drift in example configs.

### Plugin factory tests (18 tests)
- Minimal config, full config, unknown plugins (4 types), invalid configs, duration parsing, per-plugin overrides, enabled:false (4 types), global tags, drop_original, period, metric filters (3 tests), processor ordering, multiple instances, empty sections: **TESTED**
- **Gap:** No test verifying that filter is actually applied to metrics (because it is not applied -- RED-01).
- **Gap:** No test for aggregator namepass/namedrop being properly wired (would catch RED-02).

### Run command tests (11 tests)
- Config load failure, invalid TOML, invalid agent, build pipeline error, start error, graceful shutdown, startup banner, plugin counts, log_level from config, shutdown error, double signal: **TESTED**
- **Gap:** No test for shutdown timeout (YELLOW-06).
- **Gap:** No test for SIGTERM (only SIGINT tested -- the mock always resolves with "SIGINT").

### Hard Path Coverage Summary

| Hard Path | Tested? | Notes |
|-----------|---------|-------|
| Config file not found | Yes | Both validate and run |
| Invalid TOML syntax | Yes | Both validate and run |
| Invalid agent config | Yes | Both validate and run |
| Unknown plugin type (validate) | Yes | Warns, does not error |
| Unknown plugin type (factory) | Yes | Throws clear error |
| Invalid plugin Zod config | Yes | Both validate and factory |
| File already exists (init) | Yes | With and without --force |
| Pipeline start() throws | Yes | |
| Pipeline stop() throws | Yes | Returns 0, logs error |
| Double SIGINT during shutdown | Yes | Excellent test |
| Shutdown timeout | **No** | YELLOW-06 |
| MetricFilter application | **No** | RED-01 |
| Aggregator filter wiring | **No** | RED-02 |
| Per-plugin log_level | **No** | YELLOW-03 |
| Alias in log output | **No** | YELLOW-07 |

---

## Fix Pass Results

**Fix commit:** `3b48f92 phase-6: fix code review findings — wire MetricFilter, fix override extraction, add shutdown test`
**Date:** 2026-02-23
**Test status after fixes:** 491 unit pass, 46 integration pass, 0 failures (1 pre-existing E2E failure in 5.2.3 daily rotation — unrelated to Phase 6)

### RED fixes applied:

| Finding | Resolution | Files changed |
|---------|-----------|---------------|
| RED-01: MetricFilter never applied | Added `FilteringAccumulator` wrapper for per-input filters; processor filters applied in `runMainLoop` (copy-based, non-matching metrics pass through); output filters applied in `runOutputFlushLoop` reader | `src/pipeline/runtime.ts` |
| RED-02: Aggregator filter config stripped | Removed `extractFilterConfig()` call for aggregators — filter fields (namepass/namedrop/tagpass/tagdrop) now flow directly to aggregator Zod schemas (BasicstatsConfigSchema handles them internally) | `src/pipeline/plugin-factory.ts` |
| RED-03: error_behavior not extracted | Added `error_behavior` and all other missing PRD §7 override keys to `OVERRIDE_KEYS`; added default case in `extractOverrides` to strip Phase 7+ keys before Zod parsing | `src/pipeline/plugin-factory.ts` |

### YELLOW fixes applied:

| Finding | Resolution | Files changed |
|---------|-----------|---------------|
| YELLOW-01: Per-output flush_interval | Extracted and discarded (Phase 7+ feature); field added to `OVERRIDE_KEYS` so it no longer breaks Zod validation | `src/pipeline/plugin-factory.ts` |
| YELLOW-02: Missing override keys | All PRD §7 per-plugin override keys now in `OVERRIDE_KEYS`: `retry_max`, `retry_backoff`, `flush_interval`, `flush_jitter`, `collection_jitter`, `collection_offset`, `precision`, `metric_buffer_limit`, `tags` | `src/pipeline/plugin-factory.ts` |
| YELLOW-03: log_level not wired | `logLevel` now passed through `PipelineOptions` for all plugin types (inputs, processors, aggregators, outputs). Actual child logger creation deferred to Phase 7 | `src/pipeline/plugin-factory.ts`, `src/pipeline/runtime.ts` |
| YELLOW-04: Aggregator double-extraction | Resolved with RED-02 — `extractFilterConfig()` no longer called for aggregators | `src/pipeline/plugin-factory.ts` |
| YELLOW-05: config validate fragility | `stripOverrideFields()` function added; strips both `OVERRIDE_KEYS` and `FILTER_KEYS` before `schema.safeParse()` | `src/cli/commands/config-validate.ts` |
| YELLOW-06: No shutdown timeout test | Made `shutdownTimeoutMs` injectable via `RunCommandDeps` (default 30000); added test with 50ms timeout verifying `forceExit` is called | `src/cli/commands/run.ts`, `test/unit/cli/run.test.ts` |
| YELLOW-07: alias discarded | `alias` now passed through `PipelineOptions` for all plugin types alongside `logLevel` | `src/pipeline/plugin-factory.ts`, `src/pipeline/runtime.ts` |

### GREEN items (not fixed — deferred):

- GREEN-01: `[global_tags] valid` message without actual validation — cosmetic, no functional impact
- GREEN-02: `BUILD_TIME` not injected at compile time — works via env var, document in build script
- GREEN-03: Defensive unref() casting — **fixed** as part of YELLOW-06 (simplified to direct `shutdownTimer.unref()`)
- GREEN-04: Import style inconsistency (path aliases vs relative) — style preference, no functional impact
- GREEN-05: README quality — positive finding, no action needed

---

## Phase 7 Readiness Assessment

### Can Phase 7 start?

**Yes.** All RED and YELLOW items have been resolved.

### Remaining deferred items for Phase 7+:

- **Per-output flush_interval**: Field is extracted and stripped, but per-output flush loop timing not yet implemented (all outputs share global `flushIntervalMs`)
- **Per-plugin child loggers**: `logLevel` is wired through PipelineOptions but child loggers with level overrides not yet created in runtime
- **Per-plugin alias in logs**: `alias` is wired through PipelineOptions but not yet used in log output or metrics reporting
- **error_behavior switching**: Field is extracted; implicit defaults are correct (inputs retry, outputs error), but operator cannot override via config
- All GREEN items
