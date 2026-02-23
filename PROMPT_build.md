Read CLAUDE.md for project rules and conventions.
Read plans/phase-6-cli.md for the Phase 6 implementation plan.
Read plans/phase-6-tasks.json for the structured task list.
Read plans/phase-6-progress.md for current progress.
Check `git log --oneline -10` to see recent commits.

You are implementing Phase 6: CLI for CollatrEdge.

## CONTEXT

Phases 1-5 are complete. You have:
- Core: Metric, Channel<T>, Broadcaster<T>, Ticker, Accumulator, Plugin Registry, Config Parser, Pipeline Runtime (with processor chain + aggregator fork)
- Inputs: Modbus TCP, OPC-UA, MQTT consumer, internal metrics
- Outputs: stdout, file, local data store (SQLite), store-and-forward buffer
- Processors: rename, filter
- Aggregators: basicstats
- Metric filtering framework (namepass/namedrop/tagpass/tagdrop/fieldpass/fielddrop)
- 445 passing tests across 41 files (including 19 E2E tests)
- Full pipeline proven end-to-end: real plugins, power loss recovery, 60s soak test, buffer overflow, error resilience

Phase 6 turns this into a usable CLI application. It wires the pipeline to real config files, adds structured logging, and provides the four core commands: `run`, `config init`, `config validate`, `version`.

## WORKFLOW

1. Read the task list and find the FIRST task where "passes" is false.
2. Read the PRD sections listed in that task's "prd_refs" array.
3. Read the detailed plan in plans/phase-6-cli.md for the corresponding section (6.0, 6.1, etc.) — it has implementation notes and edge case guidance.
4. Implement the code following the steps in the task.
5. Run `bun test` — ALL tests must pass (not just your new ones).
6. If tests fail: understand the root cause. Fix the CODE, not the tests. If a test expectation is genuinely wrong (you can explain why), fix it — but document the reasoning in the progress file.
7. If you cannot fix a failure after 3 genuine attempts: STOP. Document the failure in plans/phase-6-progress.md with full error output and what you tried. Do NOT mark the task as passing.
8. When all tests pass: update the task's "passes" field to true in plans/phase-6-tasks.json.
9. Update plans/phase-6-progress.md with: what you built, decisions made, any notes for next task.
10. Git commit with message format: `phase-6: <what you built>`
11. ONLY WORK ON ONE TASK PER SESSION.

## RULES

- Read the relevant PRD sections BEFORE writing code. The spec defines correct behaviour.
- Never use `any` type except in test fixtures where typing adds no value.
- Never swallow errors with empty catch blocks.
- Run the FULL test suite before committing, not just your new tests.
- Use `bun:test` (describe/it/expect). Not Jest, not Vitest.
- Use ESM imports. No require().
- Temp directories: use `mkdtempSync` + cleanup in `afterEach`. Don't leave test artifacts.

## KEY NOTES

- **Plugin constructors may need refactoring** to accept config objects. Check what each constructor currently takes and adapt carefully. Existing tests must still pass.
- **Zod schemas must be exported from each plugin file.** Some already are, others need a 1-line `export`. Do this in task 6.3 as prep for the schema registry and plugin factory.
- **Logger replaces console.error/console.log in src/.** After implementing the logger (6.0), grep src/ for remaining console calls and replace them. Test files can keep console calls.
- **CLI commands return exit codes, not call process.exit().** Only src/index.ts calls process.exit(). This makes testing possible.
- **Config template in 6.4 is a string literal** — bundled in the binary. Not a separate file.
- **Signal handling in 6.6:** Don't test with real signals in unit tests. Mock the pipeline and test the wiring. Phase 5 E2E tests already prove the pipeline works.
- **The plugin factory (6.5) is the most complex task.** Take your time. Read the existing plugin constructors carefully before designing the factory interface.

## IMPORTANT: Plugin Constructor Patterns

Existing plugins accept config in different ways. You'll need to understand and potentially refactor these:

- `InternalInput` — check constructor
- `ModbusInput` — check constructor (likely takes a config object already via Zod parse)
- `OpcuaInput` — check constructor
- `MqttConsumerInput` — check constructor
- `RenameProcessor` — check constructor
- `FilterProcessor` — check constructor
- `BasicstatsAggregator` — check constructor
- `LocalStoreOutput` — check constructor
- `FileOutput` — check constructor
- `StdoutOutput` — check constructor

Read each plugin file's constructor before implementing the factory. Document any refactoring needed in the progress file.

## COMPLETION

When your single task is done and committed, output: TASK_COMPLETE

If ALL tasks in phase-6-tasks.json have "passes": true, output: PHASE_COMPLETE
