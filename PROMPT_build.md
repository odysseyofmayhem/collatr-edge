Read CLAUDE.md for project rules and conventions.
Read plans/phase-5-essential-tests.md for the Phase 5 implementation plan.
Read plans/phase-5-tasks.json for the structured task list.
Read plans/phase-5-progress.md for current progress.
Check `git log --oneline -10` to see recent commits.

You are implementing Phase 5: Essential Tests for CollatrEdge.

## CONTEXT

Phases 1-4 are complete. You have:
- Core: Metric, Channel<T>, Broadcaster<T>, Ticker, Accumulator, Plugin Registry, Config Parser, Pipeline Runtime (with processor chain + aggregator fork)
- Inputs: Modbus TCP, OPC-UA, MQTT consumer, internal metrics
- Outputs: stdout, file, local data store (SQLite), store-and-forward buffer
- Processors: rename, filter
- Aggregators: basicstats
- Metric filtering framework (namepass/namedrop/tagpass/tagdrop/fieldpass/fielddrop)
- 426 passing tests across 36 files

Phase 5 adds targeted confidence tests that exercise the real system under realistic conditions. These are NOT exhaustive test suites — they're proofs that the architecture works.

**Test files go in `test/e2e/`.** Create that directory when starting task 5.0.

## WORKFLOW

1. Read the task list and find the FIRST task where "passes" is false.
2. Read the PRD sections listed in that task's "prd_refs" array.
3. Read the detailed plan in plans/phase-5-essential-tests.md for the corresponding section (5.0, 5.1, etc.) — it has implementation notes and edge case guidance.
4. Implement the tests following the steps in the task.
5. Run `bun test` — ALL tests must pass (not just your new ones).
6. If tests fail: understand the root cause. Fix the CODE, not the tests. If a test expectation is genuinely wrong (you can explain why), fix it — but document the reasoning in the progress file.
7. If you cannot fix a failure after 3 genuine attempts: STOP. Document the failure in plans/phase-5-progress.md with full error output and what you tried. Do NOT mark the task as passing.
8. When all tests pass: update the task's "passes" field to true in plans/phase-5-tasks.json.
9. Update plans/phase-5-progress.md with: what you built, decisions made, any notes for next task.
10. Git commit with message format: `phase-5: <what you built>`
11. ONLY WORK ON ONE TASK PER SESSION.

## RULES

- Read the relevant PRD sections BEFORE writing tests. The spec defines correct behaviour.
- Tests must verify behaviour described in the PRD, not just "it doesn't crash".
- Use **real plugin imports** — the whole point of Phase 5 is testing real plugins together, not mocks.
- Never use `any` type except in test fixtures where typing adds no value.
- Never swallow errors with empty catch blocks.
- Run the FULL test suite before committing, not just your new tests.
- Use `bun:test` (describe/it/expect). Not Jest, not Vitest.
- Use ESM imports. No require().
- Temp directories: use `mkdtempSync` + cleanup in `afterEach`. Don't leave test artifacts.
- Long tests (60s soak): mark with `// Long-running test (~60s)` comment.

## KEY NOTES

- **S&F buffer is NOT wired into PipelineRuntime.** The runtime writes directly to output plugins. Buffer tests (5.3) test the buffer in isolation. Runtime/buffer integration is a Phase 7 prerequisite — document it but don't build it.
- **Use InternalInput for E2E tests** — it's lightweight, no external dependencies, always available.
- **Query SQLite directly for local-store assertions** — open the daily file with `new Database(path)` and run SELECT queries.
- **For corruption detection (5.1.4)**: check if LocalStore already handles corruption. If not, implement the detection path (PRD §8 says: move corrupt file aside, create fresh) or document as TODO.
- **Memory measurement (5.2.2)**: use `process.memoryUsage().rss`. If unreliable in Bun, document and skip.

## COMPLETION

When your single task is done and committed, output: TASK_COMPLETE

If ALL tasks in phase-5-tasks.json have "passes": true, output: PHASE_COMPLETE
