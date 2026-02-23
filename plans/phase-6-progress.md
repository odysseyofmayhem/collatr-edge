# Phase 6 Progress

## Status: IN PROGRESS

## Task Status

| Task | Description | Status |
|------|-------------|--------|
| 6.pre | Phase 5 review cleanup (Y-NEW-1 through G-NEW-2) | ✅ (already done, commit e89ad4f) |
| 6.0 | Structured logger | ✅ |
| 6.1 | CLI framework + arg parsing | ⬜ |
| 6.2 | version command | ⬜ |
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
