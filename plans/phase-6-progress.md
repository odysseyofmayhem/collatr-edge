# Phase 6 Progress

## Status: IN PROGRESS

## Task Status

| Task | Description | Status |
|------|-------------|--------|
| 6.pre | Phase 5 review cleanup (Y-NEW-1 through G-NEW-2) | ✅ (already done, commit e89ad4f) |
| 6.0 | Structured logger | ✅ |
| 6.1 | CLI framework + arg parsing | ✅ |
| 6.2 | version command | ✅ |
| 6.3 | config validate command | ⬜ |
| 6.4 | config init command | ⬜ |
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
