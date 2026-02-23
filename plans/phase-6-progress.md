# Phase 6 Progress

## Status: IN PROGRESS

## Task Status

| Task | Description | Status |
|------|-------------|--------|
| 6.pre | Phase 5 review cleanup (Y-NEW-1 through G-NEW-2) | ✅ (already done, commit e89ad4f) |
| 6.0 | Structured logger | ✅ |
| 6.1 | CLI framework + arg parsing | ✅ |
| 6.2 | version command | ✅ |
| 6.3 | config validate command | ✅ |
| 6.4 | config init command | ✅ |
| 6.5 | Plugin factory (config → pipeline) | ⬜ |
| 6.6 | run command + signal handling | ⬜ |
| 6.7 | Systemd unit file + docs | ⬜ |

## Task 6.0: Structured Logger

**What was built:**
- `src/core/logger.ts` — Logger interface, `createLogger()`, `setGlobalLogger()`, `getLogger()` global singleton
- JSON output to stderr via `process.stderr.write()`, ISO 8601 timestamps
- Level filtering: debug < info < warn < error
- `child()` method creates sub-logger with inherited context + optional level override
- 13 new tests in `test/unit/core/logger.test.ts`

**Decisions:**
- Used `getLogger()` per-call pattern (not module-level `const`) to ensure logger calls always get the configured global logger, even when `setGlobalLogger()` is called after module import time (which is the normal case — CLI startup configures the logger before starting the pipeline)
- Changed `StdoutOutput` plugin from `console.log()` to `process.stdout.write()` to be explicit about data output vs log output (stdout is for data, stderr is for logs)
- Updated all test files that spied on `console.error`/`console.warn` to spy on `process.stderr.write` instead

**Files changed:**
- New: `src/core/logger.ts`, `test/unit/core/logger.test.ts`
- Modified (logger integration): `src/index.ts`, `src/core/accumulator.ts`, `src/pipeline/runtime.ts`, `src/plugins/outputs/local-store.ts`, `src/plugins/outputs/stdout.ts`, `src/plugins/inputs/mqtt-consumer.ts`, `src/plugins/inputs/opcua.ts`, `src/plugins/inputs/modbus.ts`, `src/plugins/aggregators/basicstats.ts`
- Modified (test spy updates): `test/e2e/helpers.ts`, `test/unit/core/accumulator.test.ts`, `test/unit/pipeline/runtime.test.ts`, `test/unit/pipeline/service-input.test.ts`, `test/unit/plugins/inputs/modbus.test.ts`, `test/unit/plugins/outputs/stdout.test.ts`

**Test results:** 458 pass, 0 fail (445 existing + 13 new)

**Notes for next task:**
- Zero `console.error`/`console.log`/`console.warn` calls remain in `src/` — confirmed via grep
- Test files still use `console.*` for their own output, which is correct per the plan
- The global logger defaults to `info` level — task 6.6 (run command) will configure it from `agent.log_level`

## Task 6.1: CLI Framework + Arg Parsing

**What was built:**
- `src/cli/index.ts` — `main()` entry point with arg parsing and subcommand routing
- `parseGlobalOptions()` — extracts `--config`/`-c` from args, respects `COLLATR_EDGE_CONFIG` env var, defaults to `/etc/collatr-edge/config.toml`
- Help text with command list and global options
- Config subcommand routing (`config init`, `config validate`)
- Updated `src/index.ts` — now calls `main()` and `process.exit()`
- 17 new tests in `test/unit/cli/cli.test.ts`

**Decisions:**
- No CLI framework dependency — raw `process.argv` parsing for 4 commands. Simple switch/case routing.
- Subcommands (`run`, `version`, `config init`, `config validate`) are currently stubs returning exit code 1 with "not yet implemented" messages. Tasks 6.2–6.6 will fill them in.
- All user-facing output goes to `process.stdout.write()` (help text) or `process.stderr.write()` (errors). Logger is used for structured logging (unknown command).
- `--config` is parsed as a global option before subcommand routing, so it's available to both `run` and `config validate`.

**Files changed:**
- New: `src/cli/index.ts`, `src/cli/commands/` (empty dir for later), `test/unit/cli/cli.test.ts`
- Modified: `src/index.ts` (now calls `main()`)

**Test results:** 475 pass, 0 fail (458 existing + 17 new)

**Notes for next task:**
- `version` command (6.2) just needs to create `src/cli/commands/version.ts` and wire it into the switch case in `src/cli/index.ts`
- The `ParsedGlobalOptions` interface is exported for use by future command handlers

## Task 6.2: Version Command

**What was built:**
- `src/cli/commands/version.ts` — `versionCommand()` function printing version, runtime, platform, and build timestamp
- Wired into `src/cli/index.ts` switch case (replaced stub)
- 7 new tests in `test/unit/cli/version.test.ts`

**Decisions:**
- Version read from `package.json` via direct import (Bun resolves JSON imports at build time)
- Build timestamp uses `Bun.env.BUILD_TIME` with `new Date().toISOString()` fallback — compile-time injection via env var
- Output goes to `process.stdout.write()` (user-facing data, not log output)
- Updated existing CLI test that asserted version stub returned exit code 1 — now returns 0

**Files changed:**
- New: `src/cli/commands/version.ts`, `test/unit/cli/version.test.ts`
- Modified: `src/cli/index.ts` (import + wired versionCommand), `test/unit/cli/cli.test.ts` (updated version stub test)

**Test results:** 482 pass, 0 fail (475 existing + 7 new)

**Notes for next task:**
- Task 6.3 (config validate) requires exporting Zod schemas from all plugin files and creating `src/core/plugin-schemas.ts`
- The plugin schema registry will also be reused by task 6.5 (plugin factory)

## Task 6.3: Config Validate Command

**What was built:**
- `src/core/plugin-schemas.ts` — central registry mapping `"type.name"` → Zod schema (e.g., `"inputs.modbus"` → `ModbusConfigSchema`)
- `src/cli/commands/config-validate.ts` — `configValidateCommand()` loads config, validates TOML + agent + per-plugin schemas, reports human-readable output with checkmarks/crosses/warnings
- Wired into `src/cli/index.ts` config subcommand routing
- 12 new tests in `test/unit/cli/config-validate.test.ts`

**Decisions:**
- All 10 plugin Zod schemas were already exported — no modifications to plugin files needed
- Unknown plugin types get a warning (`⚠`) but don't fail validation (forward-compatibility for future plugins)
- Output goes to `process.stdout.write()` (human-readable, not JSON — this is a user-facing command)
- Uses `✓` / `✗` / `⚠` Unicode markers per the plan
- Updated 2 existing CLI tests that asserted config validate stub behavior (now it returns real results)

**Files changed:**
- New: `src/core/plugin-schemas.ts`, `src/cli/commands/config-validate.ts`, `test/unit/cli/config-validate.test.ts`
- Modified: `src/cli/index.ts` (import + wired configValidateCommand), `test/unit/cli/cli.test.ts` (updated 2 tests for real behavior)

**Test results:** 494 pass, 0 fail (482 existing + 12 new)

**Notes for next task:**
- Task 6.4 (config init) should generate TOML that passes `configValidateCommand()` — good test to write
- The `PLUGIN_SCHEMAS` registry in `src/core/plugin-schemas.ts` will be reused by task 6.5 (plugin factory)

## Task 6.4: Config Init Command

**What was built:**
- `src/cli/commands/config-init.ts` — `configInitCommand()` generates a default TOML config template with comments
- Arg parsing for `--output/-o` (default: `./collatr-edge.toml`), `--mode` (`connected`/`local_network`/`standalone`, default: `local_network`), `--force`
- `generateConfigTemplate(mode)` — string literal template with mode-specific sections
- Wired into `src/cli/index.ts` config subcommand routing (replaced stub)
- 21 new tests in `test/unit/cli/config-init.test.ts`

**Decisions:**
- Template is a string literal in source code (bundled in compiled binary, no separate file)
- Mode-specific sections: `[agent.hub]` uncommented only in connected mode, `[network_policy]` with mode-appropriate settings in all modes
- Used `Bun.file().exists()` for pre-write check and `Bun.write()` for file creation (Bun-native, no `node:fs` dependency in production code)
- TOML structure: `[agent]` then `[agent.hub]` (subtable) then `[network_policy]` — valid TOML v1.0 ordering, parser handles it correctly
- `[outputs.local_store]` uses single-bracket notation (singleton plugin, consistent with PRD Appendix A)
- `[[inputs.internal]]` uses double-bracket notation (consistent with PRD Appendix A and other input plugins)
- Template includes commented examples for modbus, opcua, rename, filter, basicstats, file, stdout — self-documenting for operators

**Files changed:**
- New: `src/cli/commands/config-init.ts`, `test/unit/cli/config-init.test.ts`
- Modified: `src/cli/index.ts` (import + wired configInitCommand), `test/unit/cli/cli.test.ts` (updated config init stub test)

**Test results:** 515 pass, 0 fail (494 existing + 21 new)

**Notes for next task:**
- Task 6.5 (plugin factory) is the most complex remaining task — read all plugin constructors before implementing
- The `generateConfigTemplate()` function is exported for potential reuse in tests
- All three mode templates (connected, local_network, standalone) pass `configValidateCommand()` — confirmed by integration tests
