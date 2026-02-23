Read CLAUDE.md for project rules and conventions.
Read plans/phase-3-outputs.md for the Phase 3 implementation plan.
Read plans/phase-3-tasks.json for the structured task list.
Read plans/phase-3-progress.md for current progress.
Check `git log --oneline -10` to see recent commits.

You are implementing Phase 3: Output Plugins for CollatrEdge.

## CONTEXT

Phase 1 (core pipeline) and Phase 2 (input plugins) are complete. You have:
- Core: Metric, Channel<T>, Broadcaster<T>, Ticker, Accumulator, Plugin Registry, Config Parser, Pipeline Runtime
- Inputs: Modbus TCP, OPC-UA, MQTT consumer, internal metrics
- 251 passing tests across 21 files
- All source in src/core/, src/pipeline/, src/plugins/inputs/

Phase 3 adds output plugins: stdout, file, local data store (SQLite), and store-and-forward buffer.

## WORKFLOW

1. Read the task list and find the FIRST task where "passes" is false.
2. Read the PRD sections listed in that task's "prd_refs" array.
3. Implement the module following the steps in the task.
4. Write tests (using `bun:test`) that cover every item in the task's "tests" array.
5. Run `bun test` — ALL tests must pass (not just your new ones).
6. If tests fail: understand the root cause. Fix the CODE, not the tests. If a test expectation is genuinely wrong (you can explain why), fix it — but document the reasoning in the progress file.
7. If you cannot fix a failure after 3 genuine attempts: STOP. Document the failure in plans/phase-3-progress.md with full error output and what you tried. Do NOT mark the task as passing.
8. When all tests pass: update the task's "passes" field to true in plans/phase-3-tasks.json.
9. Update plans/phase-3-progress.md with: what you built, decisions made, any notes for next task.
10. Git commit with message format: `phase-3: <what you built>`
11. ONLY WORK ON ONE TASK PER SESSION.

## RULES

- Read the relevant PRD sections BEFORE writing code. The spec is in the PRD.
- Tests must verify behaviour described in the PRD, not just "it doesn't crash".
- Never use `any` type except in test fixtures where typing adds no value.
- Never swallow errors with empty catch blocks.
- Never add setTimeout/sleep to "fix" a test. If timing matters, use proper async patterns.
- If a test is flaky, the implementation has a race condition. Find it and fix it.
- Run the FULL test suite before committing, not just your new tests.
- Use `bun:test` (describe/it/expect). Not Jest, not Vitest.
- Use ESM imports. No require().

## SQLITE NOTES

- Use `bun:sqlite` (built-in). NOT `better-sqlite3`.
- WAL mode: `PRAGMA journal_mode=WAL`
- Synchronous: `PRAGMA synchronous=NORMAL` (default, ≤1s loss on crash)
- Busy timeout: `PRAGMA busy_timeout=5000`
- Field encoding: `msgpackr` (already in package.json)
- Daily files: `data_YYYY_MM_DD.db` in the configured data directory
- BEGIN IMMEDIATE for write transactions
- Test with real SQLite (no mocking the database — it's built-in and fast)

## COMPLETION

When your single task is done and committed, output: TASK_COMPLETE

If ALL tasks in phase-3-tasks.json have "passes": true, output: PHASE_COMPLETE
