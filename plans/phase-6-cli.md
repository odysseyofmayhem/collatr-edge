# Phase 6: CLI — Implementation Plan

**Goal:** Wire the pipeline into a usable command-line application. Four core commands (`run`, `config init`, `config validate`, `version`) plus signal handling and systemd integration. This is the "make it actually run" phase.

**Estimated Duration:** 2-3 days
**PRD References:** §7 (Configuration), §8 (Pipeline Lifecycle), §14 (Error Handling), §15 (Observability — logging), §16 (Security — secrets), §18 (Deployment & CLI), §22 (MVP Acceptance Criteria — Scenarios 1, 4, 5)

---

## What Phase 6 Delivers

| Command | Purpose | Maps to MVP Acceptance Criteria |
|---|---|---|
| `collatr-edge run` | Start the agent from a config file | Scenario 1 (basic data collection), Scenario 5 (first-run setup) |
| `collatr-edge config init` | Generate a default config file with guided prompts | Scenario 5 (first-run setup) |
| `collatr-edge config validate` | Parse and validate a config file without running | — |
| `collatr-edge version` | Print version and build info | — |
| Signal handling | SIGINT/SIGTERM → graceful shutdown | Scenario 2 (process restart) |
| Structured logging | JSON logging to stdout/stderr with levels | §15 (Observability) |
| Plugin wiring | Config → real plugin instantiation → PipelineRuntime | Connects Phase 1-5 infrastructure to real usage |

---

## What Phase 6 Does NOT Do

- **No `config test` (dry-run plugin init).** Requires connecting to real devices — complex and risky. Deferred.
- **No `secrets set/list/delete`.** Secret store implementation is a Phase 7+ concern. Config validation will detect `@{secrets:...}` references and warn they can't be resolved yet.
- **No `plugins list`.** Requires the build-time manifest (PRD §6). Deferred.
- **No `service install/remove`.** Systemd unit file is provided as a static template, not CLI-generated. Manual install.
- **No `export`.** That's a Web UI / Phase 9 feature.
- **No hot-reload.** Config is loaded once at startup. Hot-reload (file watcher + SIGHUP) is post-MVP.
- **No network policy enforcement.** That's Phase 8.

---

## Module Dependency Order

```
6.0  Structured logger                 ← all other modules depend on this
6.1  CLI framework + arg parsing       ← entry point, subcommand routing
6.2  `version` command                 ← simplest command, validates CLI framework
6.3  `config validate` command         ← validates full config pipeline
6.4  `config init` command             ← generates default config template
6.5  Plugin instantiation from config  ← turns parsed config into real plugin instances
6.6  `run` command + signal handling   ← wires everything together
6.7  Systemd unit file                 ← static template, not code
```

**Build order rationale:**
- Logger first — every command needs structured output, and the pipeline runtime needs it for production logging (replacing bare `console.error`).
- CLI framework second — establishes the command routing pattern that all commands use.
- `version` is trivial — proves the CLI framework works.
- `config validate` before `config init` — validate exercises the config parser with real files, which informs what `config init` needs to generate.
- Plugin instantiation before `run` — the most complex piece. Turning a parsed TOML config into typed plugin instances with validated configs.
- `run` last — integrates everything.

---

## 6.0 Structured Logger

**PRD refs:** §15 (Observability — Logging)
**Source file:** `src/core/logger.ts`
**Test file:** `test/unit/core/logger.test.ts`

### What it does

Replace all `console.error` / `console.log` calls with a structured logger that outputs JSON to stderr. The pipeline currently uses bare `console.error` for error reporting — this works for tests but isn't production-ready.

### Specification (PRD §15)

```json
{
  "ts": "2026-02-22T10:30:00.123Z",
  "level": "warn",
  "plugin": "inputs.modbus.plc_01",
  "msg": "gather timeout",
  "timeout_ms": 5000,
  "consecutive_timeouts": 3
}
```

### Design

```typescript
type LogLevel = "debug" | "info" | "warn" | "error";

interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(context: Record<string, string>): Logger;
}
```

Key properties:
- **JSON output to stderr** — stdout is reserved for `stdout` output plugin data and user-facing CLI output
- **Level filtering** — global level set from `agent.log_level` config (default: `info`)
- **Per-plugin log_level override** — via `child()` context with per-instance level override
- **`child()` creates a sub-logger** with inherited context (e.g., `logger.child({ plugin: "inputs.modbus.plc_01" })`)
- **ISO 8601 timestamps** — `new Date().toISOString()`
- **No external dependencies** — `JSON.stringify` + `process.stderr.write` is sufficient
- **Global singleton** — `setGlobalLogger(logger)` / `getLogger()` pattern, so pipeline code can import and use without prop-drilling
- **Startup banner** — `info` level log with version, config path, plugin count, network policy mode

### Test scenarios

1. **Level filtering** — set level to "warn", verify debug/info are suppressed, warn/error are emitted
2. **JSON format** — verify output is valid JSON with required fields (ts, level, msg)
3. **Child logger** — verify context fields (plugin) are included in child's output
4. **Extra fields** — verify arbitrary extra fields are merged into output
5. **Per-plugin level override** — child logger can have different level than parent
6. **Global setter/getter** — setGlobalLogger + getLogger round-trips correctly

### Implementation notes

- **Do NOT use a logging library** (pino, winston, bunyan). We need ~50 lines of code, not a dependency.
- Output goes to `process.stderr.write()` — NOT `console.error()` (which adds its own formatting).
- Each log entry is one JSON line terminated by `\n`.
- After implementing, do a codebase grep for `console.error` and `console.log` in `src/` — replace all with logger calls. Keep `console.error`/`console.log` in test files only.

---

## 6.1 CLI Framework + Arg Parsing

**PRD refs:** §18 (CLI command list)
**Source file:** `src/cli/index.ts`, `src/cli/commands/*.ts`
**Test file:** `test/unit/cli/cli.test.ts`

### What it does

Minimal CLI framework: parse `process.argv`, route to subcommand handlers, handle `--help` and unknown commands.

### Design

```
collatr-edge [command] [options]

Commands:
  run              Start the agent
  config init      Generate default configuration
  config validate  Validate a configuration file
  version          Print version and build info

Global options:
  --help, -h       Show help
  --config, -c     Config file path (default: /etc/collatr-edge/config.toml)
```

**No CLI framework dependency.** `process.argv` parsing is trivial for 4 commands. A library would add weight to the binary for no benefit.

### Implementation

```typescript
// src/cli/index.ts
export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  
  switch (command) {
    case "run":
      return await runCommand(args.slice(1));
    case "config":
      return await configCommand(args.slice(1));
    case "version":
      return versionCommand();
    case "--help":
    case "-h":
    case undefined:
      return helpCommand();
    default:
      console.error(`Unknown command: ${command}\n`);
      helpCommand();
      return 1;
  }
}
```

Config subcommands:
```
collatr-edge config init [--output path] [--mode connected|local_network|standalone]
collatr-edge config validate [--config path]
```

### Entry point update

`src/index.ts` becomes:
```typescript
import { main } from "./cli/index";
process.exit(await main());
```

### Test scenarios

1. **Unknown command** — returns exit code 1, prints error + help
2. **No command** — prints help, returns 0
3. **--help flag** — prints help, returns 0
4. **Config path parsing** — `--config /path/to/file.toml` parsed correctly
5. **Config subcommand routing** — `config init` and `config validate` route to correct handlers

### Implementation notes

- Return exit codes (0 = success, 1 = error) — don't call `process.exit()` directly inside commands (makes testing impossible). Only `src/index.ts` calls `process.exit()`.
- `--config` default: check `COLLATR_EDGE_CONFIG` env var first, then `/etc/collatr-edge/config.toml`.
- Global `--config` option is parsed before subcommand routing (it's shared across `run`, `config validate`).

---

## 6.2 `version` Command

**PRD refs:** §18
**Source file:** `src/cli/commands/version.ts`
**Test file:** `test/unit/cli/version.test.ts`

### What it does

```
$ collatr-edge version
CollatrEdge v0.1.0
Runtime: Bun 1.3.9
Platform: linux-x64
Build: 2026-02-23T20:30:00Z
```

### Implementation

- Version from `package.json` (import at build time)
- Runtime: `Bun.version`
- Platform: `process.platform`-`process.arch`
- Build timestamp: injected at compile time via `Bun.env.BUILD_TIME` or `new Date().toISOString()` fallback

### Test scenarios

1. **Output format** — contains version string, runtime, platform
2. **Returns exit code 0**

---

## 6.3 `config validate` Command

**PRD refs:** §7 (Configuration), §14 (Config Validation Errors)
**Source file:** `src/cli/commands/config-validate.ts`
**Test file:** `test/unit/cli/config-validate.test.ts`

### What it does

Parse and validate a TOML config file. Reports all validation errors clearly. Does NOT start any plugins or make any connections.

```
$ collatr-edge config validate --config ./config.toml
✓ TOML syntax valid
✓ [agent] section valid
✓ [global_tags] valid
✓ 2 input plugin(s) configured
  - inputs.modbus[0] (alias: plc_01) — valid
  - inputs.internal[0] — valid
✓ 1 processor(s) configured
  - processors.rename[0] — valid
✓ 1 aggregator(s) configured
  - aggregators.basicstats[0] — valid
✓ 2 output(s) configured
  - outputs.local_store[0] — valid
  - outputs.file[0] (alias: debug_log) — valid
⚠ Secret references found (not resolved during validation):
  - agent.hub.tls_cert: @{secrets:hub_cert}
  - agent.hub.tls_key: @{secrets:hub_key}
✓ Configuration valid
```

On error:
```
$ collatr-edge config validate --config ./bad.toml
✗ Invalid [agent] config:
  interval: Invalid duration string. Expected format: <number><unit> (e.g., "10s")
```

### Implementation

1. Load config file from path
2. Call `parseConfig()` (existing function — env var expansion, TOML parse, agent validation, plugin extraction, secret detection)
3. Validate each plugin instance config against its Zod schema (requires plugin schema registry — see implementation notes)
4. Report results to stdout (human-readable, not JSON — this is a user-facing command)
5. Return 0 if valid, 1 if invalid

### Plugin schema validation

The config parser (Phase 1) extracts plugin sections as `Record<string, PluginInstanceConfig[]>` but doesn't validate individual plugin configs against their schemas. Phase 6 adds this:

```typescript
// src/core/plugin-schemas.ts
// Map of plugin type/name → Zod schema for config validation
export const PLUGIN_SCHEMAS: Record<string, z.ZodType> = {
  "inputs.modbus": ModbusConfigSchema,
  "inputs.opcua": OpcuaConfigSchema,
  "inputs.mqtt_consumer": MqttConsumerConfigSchema,
  "inputs.internal": InternalConfigSchema,
  "processors.rename": RenameConfigSchema,
  "processors.filter": FilterConfigSchema,
  "aggregators.basicstats": BasicstatsConfigSchema,
  "outputs.local_store": LocalStoreConfigSchema,
  "outputs.file": FileConfigSchema,
  "outputs.stdout": StdoutConfigSchema,
};
```

Each plugin already defines its own Zod schema internally. This task exports them and registers them in a central map. **Do not duplicate schemas** — import from the plugin source files.

### Test scenarios

1. **Valid config** — full valid config, returns 0, output includes all "valid" markers
2. **Invalid agent section** — bad duration string, returns 1, clear error message
3. **Invalid TOML syntax** — returns 1, TOML parse error shown
4. **Unknown plugin type** — warns but doesn't error (forward-compatibility)
5. **Invalid plugin config** — modbus with bad controller URL, returns 1, plugin-specific error
6. **Secret references detected** — lists them as warnings, doesn't fail
7. **Missing config file** — returns 1, clear "file not found" message
8. **Empty config** — valid (all defaults), returns 0

### Implementation notes

- Plugin schemas must be **exported** from each plugin source file. Check existing exports — some may already export their schema, others will need a one-line addition.
- The schema registry (`PLUGIN_SCHEMAS`) is a static map, not the plugin registry from Phase 1. It only holds Zod schemas, not plugin classes.
- Config file path: `--config` flag, or `COLLATR_EDGE_CONFIG` env, or default `/etc/collatr-edge/config.toml`.
- Output is human-readable text to stdout (not JSON). Use `✓` / `✗` / `⚠` markers.

---

## 6.4 `config init` Command

**PRD refs:** §7 (Configuration), §18, §22 Scenario 5
**Source file:** `src/cli/commands/config-init.ts`
**Test file:** `test/unit/cli/config-init.test.ts`

### What it does

Generate a default TOML config file with comments explaining every option. The operator edits this to match their setup.

```
$ collatr-edge config init
Generated default config at ./collatr-edge.toml
Edit this file, then run:
  collatr-edge config validate --config ./collatr-edge.toml
  collatr-edge run --config ./collatr-edge.toml
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--output`, `-o` | `./collatr-edge.toml` | Output file path |
| `--mode` | `local_network` | Network policy mode preset: `connected`, `local_network`, `standalone` |
| `--force` | `false` | Overwrite existing file |

### Config template

The generated config is based on Appendix A (full config example) but stripped to essentials with all options commented out. It should be a valid config as-is (the internal input is always enabled, local store output is always enabled in standalone/local_network modes).

**Sections in generated config:**
1. `[agent]` — interval, log_level, precision (defaults, with comments explaining each)
2. `[global_tags]` — empty, with comment explaining usage
3. `[[inputs.internal]]` — enabled, interval 30s (self-metrics — always useful)
4. Example `[[inputs.modbus]]` — commented out, with register examples
5. Example `[[inputs.opcua]]` — commented out, with node_id examples
6. `[outputs.local_store]` — enabled, path `/var/collatr/data`, retention_days 90
7. Example `[[outputs.file]]` — commented out

The `--mode` flag adjusts the `[network_policy]` section and Hub config:
- `connected`: Hub section enabled, network policy allows Hub broker
- `local_network`: Hub section commented out, network policy restricts to local CIDRs
- `standalone`: Hub section commented out, network policy blocks all egress

### Test scenarios

1. **Default generation** — creates file, content is valid TOML
2. **File already exists** — returns 1 with error (without `--force`)
3. **--force overwrites** — creates file even if exists
4. **--output custom path** — writes to specified path
5. **--mode connected** — Hub section uncommented
6. **--mode standalone** — network policy blocks all egress
7. **Generated config validates** — output of `config init` passes `config validate`

### Implementation notes

- The config template is a **string literal** in the source code (not a separate file). This ensures it's bundled in the compiled binary.
- Every line that's commented out starts with `# ` (not `## ` — TOML treats those the same but single `#` is convention).
- The template should be self-documenting — operators should be able to configure the agent by reading comments alone, without consulting docs.
- Write to file with `Bun.write()`.

---

## 6.5 Plugin Instantiation from Config

**PRD refs:** §6 (Plugin System), §7 (Configuration), §8 (Pipeline Lifecycle steps 9-10)
**Source file:** `src/pipeline/plugin-factory.ts`
**Test file:** `test/unit/pipeline/plugin-factory.test.ts`

### What it does

This is the bridge between parsed config (`AgentConfig`) and the `PipelineOptions` expected by `PipelineRuntime`. It:

1. Takes a parsed `AgentConfig`
2. For each plugin section (inputs, processors, aggregators, outputs), looks up the plugin class and Zod schema
3. Validates the instance config against the schema
4. Instantiates the plugin with the validated config
5. Returns a fully-typed `PipelineOptions` ready for `PipelineRuntime`

### Design

```typescript
export interface PluginFactory {
  buildPipeline(config: AgentConfig): Promise<PipelineOptions>;
}
```

Internally:

```typescript
const PLUGIN_CONSTRUCTORS = {
  inputs: {
    modbus: (config: unknown) => new ModbusInput(ModbusConfigSchema.parse(config)),
    opcua: (config: unknown) => new OpcuaInput(OpcuaConfigSchema.parse(config)),
    mqtt_consumer: (config: unknown) => new MqttConsumerInput(MqttConsumerConfigSchema.parse(config)),
    internal: (config: unknown) => new InternalInput(InternalConfigSchema.parse(config)),
  },
  processors: {
    rename: (config: unknown) => new RenameProcessor(RenameConfigSchema.parse(config)),
    filter: (config: unknown) => new FilterProcessor(FilterConfigSchema.parse(config)),
  },
  aggregators: {
    basicstats: (config: unknown) => new BasicstatsAggregator(BasicstatsConfigSchema.parse(config)),
  },
  outputs: {
    local_store: (config: unknown) => new LocalStoreOutput(LocalStoreConfigSchema.parse(config)),
    file: (config: unknown) => new FileOutput(FileConfigSchema.parse(config)),
    stdout: (config: unknown) => new StdoutOutput(StdoutConfigSchema.parse(config)),
  },
};
```

### Config-to-PipelineOptions mapping

| Config field | PipelineOptions field | Notes |
|---|---|---|
| `agent.interval` | `gatherIntervalMs` | Parse duration string to ms |
| `agent.flush_interval` | `flushIntervalMs` | Parse duration string to ms |
| `agent.round_interval` | `roundInterval` | Boolean, default true |
| `agent.collection_jitter` | — | TODO: Phase 7+ jitter support in Ticker |
| `agent.collection_offset` | — | TODO: Phase 7+ offset support in Ticker |
| `agent.log_level` | — | Used to configure logger |
| `global_tags` | `globalTags` | Passed through |
| Per-input `interval` | `inputs[].interval` | Override parse duration |
| Per-input `timeout` | `inputs[].timeout` | Override parse duration |
| Per-output `metric_batch_size` | `outputs[].metricBatchSize` | Number |
| Per-aggregator `period` | `aggregators[].period` | Parse duration string to ms |
| Per-aggregator `drop_original` | `aggregators[].dropOriginal` | Boolean |
| `enabled: false` | — | Skip plugin entirely, don't instantiate |
| Per-plugin `namepass`/`namedrop`/etc. | — | Wrap plugin in MetricFilter (see below) |

### Metric filter wrapping

Each plugin instance can have `namepass`, `namedrop`, `tagpass`, `tagdrop`, `fieldpass`, `fielddrop` (PRD §7). These need to be applied as a `MetricFilter` wrapper around the plugin. For inputs, the filter is applied after gather; for outputs, before write.

The MetricFilter already exists from Phase 4. Plugin instantiation wraps plugins with their filters:

```typescript
// For inputs: filter is applied in the accumulator (already supported via ChannelAccumulator)
// For processors/aggregators: filter is built into the plugin base
// For outputs: wrap write() to filter before writing
```

**Check how MetricFilter is currently used in tests and wire it from config.** The per-plugin filter fields need to be extracted from the raw config and passed to `MetricFilter.fromConfig()` or equivalent.

### Test scenarios

1. **Minimal config** — internal input + stdout output → valid PipelineOptions
2. **Full config** — modbus + opcua + rename + filter + basicstats + local_store → all plugins instantiated
3. **Unknown plugin type** — throws clear error
4. **Invalid plugin config** — Zod validation error with plugin name context
5. **Duration parsing** — agent.interval "10s" → gatherIntervalMs 10000
6. **Per-plugin overrides** — input with custom interval and timeout
7. **enabled: false** — plugin skipped, not in PipelineOptions
8. **Global tags** — passed through to PipelineOptions
9. **drop_original wiring** — aggregator config `drop_original: true` → PipelineOptions
10. **Per-plugin filter fields** — namepass/namedrop from config → MetricFilter wired

### Implementation notes

- **Plugin constructors need to accept validated config.** Check existing constructors — they may need refactoring to accept a config object instead of individual parameters. This is the most likely source of friction.
- If a constructor currently takes `(path: string, options: {...})`, refactor it to accept the full Zod-parsed config object. Keep backward compatibility for tests that construct plugins directly.
- **Do not lazy-load plugins.** All MVP plugins are built-in. The lazy-loading pattern from PRD §6 is for post-MVP external plugins.
- **Plugin alias** is stored on the plugin instance for logging/metrics purposes but isn't part of the plugin interface. Consider adding an optional `alias` property or passing it to the logger child.

---

## 6.6 `run` Command + Signal Handling

**PRD refs:** §8 (Pipeline Lifecycle), §14 (Error Handling), §18 (CLI)
**Source file:** `src/cli/commands/run.ts`
**Test file:** `test/unit/cli/run.test.ts`, `test/e2e/cli-run.test.ts`

### What it does

The main command. Loads config, instantiates plugins, builds pipeline, runs until signal.

```
$ collatr-edge run --config ./config.toml
{"ts":"2026-02-23T20:30:00.123Z","level":"info","msg":"CollatrEdge starting","version":"0.1.0","config":"./config.toml"}
{"ts":"2026-02-23T20:30:00.234Z","level":"info","msg":"Pipeline started","inputs":2,"processors":1,"aggregators":1,"outputs":2}
... (runs until SIGINT/SIGTERM)
{"ts":"2026-02-23T20:35:00.000Z","level":"info","msg":"Received SIGINT, shutting down..."}
{"ts":"2026-02-23T20:35:00.456Z","level":"info","msg":"CollatrEdge stopped","uptime_s":300}
```

### Signal handling (PRD §8 shutdown sequence)

```typescript
const shutdown = async () => {
  logger.info("Shutting down...");
  await pipeline.stop();
  logger.info("CollatrEdge stopped", { uptime_s: Math.floor((Date.now() - startTime) / 1000) });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

Key behaviours:
- **SIGINT (Ctrl+C):** Graceful shutdown via `PipelineRuntime.stop()`
- **SIGTERM:** Same as SIGINT (systemd sends SIGTERM by default)
- **Double SIGINT/SIGTERM:** Force-exit with code 1 (if graceful shutdown hangs)
- **SIGKILL:** Can't handle (OS-level) — this is what Phase 5 tested recovery from

### Implementation flow

```
1. Parse --config path (CLI framework)
2. Load and parse config file (loadConfigFile)
3. Configure logger (level from agent.log_level)
4. Log startup banner (version, config path, node info)
5. Instantiate plugins (PluginFactory.buildPipeline)
6. Create PipelineRuntime with PipelineOptions
7. Start pipeline (pipeline.start())
8. Register signal handlers
9. Log "Pipeline started" + summary (input/processor/aggregator/output counts)
10. Await termination signal
11. Graceful shutdown (pipeline.stop())
12. Return exit code 0
```

### Error handling

| Error | Response |
|---|---|
| Config file not found | Log error, exit 1 |
| Config parse error | Log error with details, exit 1 |
| Plugin validation error | Log error with plugin name + field, exit 1 |
| Plugin connect() error | Log error, exit 1 (PRD §14: output error_behavior default = "error") |
| Service input start() error | Log warning, continue (PRD §14: input error_behavior default = "retry") |
| Shutdown timeout (>30s) | Force-exit with code 1 |

### Test scenarios (unit)

1. **Config load failure** — missing file → exit 1 with error message
2. **Config parse failure** — invalid TOML → exit 1 with parse error
3. **Plugin error on connect** — mock output throws in connect() → exit 1
4. **Double signal** — second SIGINT after first → force exit

### Test scenarios (E2E — optional, may be complex)

5. **Full run cycle** — spawn process with internal input + file output, send SIGTERM after 2s, verify output file has metrics and process exited cleanly
6. **Config env var expansion** — config uses `${TEST_VAR}`, env var set, pipeline starts correctly

### Implementation notes

- The `run` command needs a long-running event loop. Use a `Promise` that resolves on signal:
  ```typescript
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  ```
- **Shutdown timeout:** Use `setTimeout(() => process.exit(1), 30_000)` as a safety net. Unref the timer so it doesn't keep the process alive if shutdown completes first.
- **Don't test by spawning a real process in unit tests.** Mock the pipeline and signal. E2E process tests are optional — they're fragile and slow. The Phase 5 E2E tests already prove the pipeline works; the CLI tests prove the wiring is correct.

---

## 6.7 Systemd Unit File

**PRD refs:** §18 (Deployment)
**File:** `deploy/collatr-edge.service`

### Template

```ini
[Unit]
Description=CollatrEdge - IIoT Data Collection Agent
Documentation=https://docs.collatr.com/edge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=collatr-edge
Group=collatr-edge
ExecStart=/usr/local/bin/collatr-edge run --config /etc/collatr-edge/config.toml
Restart=on-failure
RestartSec=5
WatchdogSec=60

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/collatr /var/log/collatr-edge
PrivateTmp=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes

# Logging (journald captures stdout/stderr)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=collatr-edge

# Shutdown timeout matches agent's internal timeout
TimeoutStopSec=35

[Install]
WantedBy=multi-user.target
```

### No tests needed

This is a static file. Validation is manual (`systemd-analyze verify`).

### Installation docs (README addition)

```bash
# Install systemd service
sudo cp deploy/collatr-edge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable collatr-edge
sudo systemctl start collatr-edge

# View logs
sudo journalctl -u collatr-edge -f
```

---

## Phase 5 Review Cleanup (Pre-Phase-6)

Address these minor items from the Phase 5 independent review before starting Phase 6:

| Item | Effort | Description |
|---|---|---|
| Y-NEW-1 | 2 min | Import `captureErrors` from helpers in `error-resilience.test.ts`, delete local duplicate |
| Y-NEW-2 | 1 min | Add clarifying comment in test 5.1.1 about crash sim cleanup ordering |
| Y-NEW-3 | 1 min | Add comment in test 5.4.3 about coupling to runtime re-add pattern |
| Y-NEW-4 | 1 min | Add TODO comment in `runOutputFlushLoop` final flush for Phase 7 |

Commit as: `phase-5: address independent review findings (Y-NEW-1 through Y-NEW-4)`

---

## Acceptance Criteria for Phase 6

Phase 6 is complete when:

1. **`collatr-edge version` works** — prints version, runtime, platform
2. **`collatr-edge config init` generates valid config** — output passes `config validate`
3. **`collatr-edge config validate` validates correctly** — detects errors, lists plugins, warns on secrets
4. **`collatr-edge run` starts and stops cleanly** — loads config, instantiates plugins, runs pipeline, handles SIGINT/SIGTERM
5. **Structured JSON logging** — all runtime log output is valid JSON with ts/level/msg fields
6. **All existing tests still pass** — zero regressions
7. **New test count:** ≥ 20 tests across CLI and plugin factory modules
8. **Systemd unit file exists** — `deploy/collatr-edge.service`
9. **`console.error`/`console.log` replaced in `src/`** — all production code uses structured logger (test files are exempt)

---

## Risks

| Risk | Mitigation |
|---|---|
| Plugin constructors don't accept config objects cleanly | Refactor incrementally — one plugin at a time. Existing tests catch regressions. |
| Config schema exports require touching every plugin file | Small change per file (1-line export). Do it in task 6.3 as prep for 6.5. |
| Signal handling tests are fragile | Test with mocks, not real signals. Phase 5 E2E already proves pipeline start/stop. |
| `config init` template goes stale as config evolves | Template is a string literal — it'll be updated when config changes. Add a test that validates the template passes `parseConfig()`. |
| Binary build may break with new `src/cli/` structure | Test `bun build --compile` as part of task 6.6 to catch bundling issues early. |
