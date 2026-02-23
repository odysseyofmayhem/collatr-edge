Read CLAUDE.md for project rules and conventions.
Read plans/phase-4-processors-aggregators.md for the Phase 4 implementation plan.
Read plans/phase-4-tasks.json for the structured task list.
Read plans/phase-4-progress.md for current progress.
Check `git log --oneline -10` to see recent commits.

You are implementing Phase 4: Processors & Aggregators for CollatrEdge.

## CONTEXT

Phases 1-3 are complete. You have:
- Core: Metric, Channel<T>, Broadcaster<T>, Ticker, Accumulator, Plugin Registry, Config Parser, Pipeline Runtime (with processor chain + aggregator fork)
- Inputs: Modbus TCP, OPC-UA, MQTT consumer, internal metrics
- Outputs: stdout, file, local data store (SQLite), store-and-forward buffer
- 338 passing tests across 28 files

Phase 4 adds processors (rename, filter), an aggregator (basicstats), and the per-plugin metric filtering framework.

**This is a lightweight phase.** The pipeline runtime already handles the processor chain and aggregator lifecycle. You're implementing the plugins that use those contracts.

## WORKFLOW

1. Read the task list and find the FIRST task where "passes" is false.
2. Read the PRD sections listed in that task's "prd_refs" array.
3. Implement the module following the steps in the task.
4. Write tests (using `bun:test`) that cover every item in the task's "tests" array.
5. Run `bun test` — ALL tests must pass (not just your new ones).
6. If tests fail: understand the root cause. Fix the CODE, not the tests. If a test expectation is genuinely wrong (you can explain why), fix it — but document the reasoning in the progress file.
7. If you cannot fix a failure after 3 genuine attempts: STOP. Document the failure in plans/phase-4-progress.md with full error output and what you tried. Do NOT mark the task as passing.
8. When all tests pass: update the task's "passes" field to true in plans/phase-4-tasks.json.
9. Update plans/phase-4-progress.md with: what you built, decisions made, any notes for next task.
10. Git commit with message format: `phase-4: <what you built>`
11. ONLY WORK ON ONE TASK PER SESSION.

## RULES

- Read the relevant PRD sections BEFORE writing code. The spec is in the PRD.
- Tests must verify behaviour described in the PRD, not just "it doesn't crash".
- Never use `any` type except in test fixtures where typing adds no value.
- Never swallow errors with empty catch blocks.
- Run the FULL test suite before committing, not just your new tests.
- Use `bun:test` (describe/it/expect). Not Jest, not Vitest.
- Use ESM imports. No require().

## KEY CONTRACTS (from Phase 1)

**Processor contract:** Receives one metric via `process(metric, acc)`. Emits zero or more via `acc.addMetric()` or `acc.addFields()`. **No auto-forwarding.** If the processor emits nothing, the metric is silently dropped.

**Aggregator contract:** `add(metric)` accumulates (called by runtime with copies). `push(acc)` emits summaries via `acc.addFields()`. `reset()` clears state. Runtime auto-forwards originals (unless `drop_original`). Runtime handles periodic push timing.

## COMPLETION

When your single task is done and committed, output: TASK_COMPLETE

If ALL tasks in phase-4-tasks.json have "passes": true, output: PHASE_COMPLETE
