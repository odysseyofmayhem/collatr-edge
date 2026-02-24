Read CLAUDE.md for project rules and conventions.
Read plans/phase-8.5-hardening.md for the full phase plan.
Read plans/phase-8.5-tasks.json for the task list.
Read plans/phase-8.5-progress.md for current progress.

You are implementing Phase 8.5 (Pre-Web-UI Hardening) of CollatrEdge, **one task per session**.

## HOW THIS WORKS

1. Read `plans/phase-8.5-tasks.json`
2. Find the **first task** where `"passes": false`
3. That is YOUR task for this session. Do that ONE task only.
4. When done: set `"passes": true` in the JSON, update `plans/phase-8.5-progress.md`, commit, push.
5. Output: `TASK_COMPLETE — <task_id>`

If ALL tasks have `"passes": true`, output: `PHASE_8.5_COMPLETE — <total test count> tests, <failure count> failures`

**Do NOT continue to the next task.** Each task runs in a fresh context via the loop script.

## CONTEXT

Phases 1–8 are complete. 790 tests pass, 0 failures. Pre-Phase 9 gate review passed (GO). Phase 8.5 is a short hardening pass addressing quick wins and low-hanging fruit before building the Web UI (Phase 9).

These are small, surgical changes. Most tasks are < 15 minutes. The plan document has exact code snippets for each fix.

## PER-TASK FLOW

1. Read the task's `steps` from the JSON
2. Read the plan document section for this task (has exact code examples)
3. Read the source file(s) being modified
4. Implement the fix
5. Run `bun test` — **ALL tests must pass**
6. Commit with message format: `phase-8.5: <what>`
7. Update `plans/phase-8.5-progress.md` (mark task done, record test count and commit hash)
8. Set `"passes": true` for this task in `plans/phase-8.5-tasks.json`
9. Commit the progress/JSON update
10. Push all commits
11. Output: `TASK_COMPLETE — <task_id>`

## IMPORTANT NOTES

- Tasks 8.5.0–8.5.2 are trivial (2–5 min each). Don't overthink them.
- Task 8.5.3 (structured warnings) touches config.ts + config-validate.ts + their tests. Be careful to update ALL test files that check warnings.
- Task 8.5.4 (runtime logs) — only ADD log context fields. Don't restructure existing log lines. Existing tests that check log output must still pass.
- Task 8.5.5 (integrity check) — the simplest approach is to merge the agent-level flag into the local-store plugin config before Zod parsing. Don't create new plumbing if you can avoid it.

## AFTER PHASE 8.5

When all tasks are done, the local agent should also run its internal review cycle:
1. Spawn a sub-agent review (per CLAUDE.md Phase Work Pattern step 4)
2. Fix any must-fix findings
3. Update progress with review results

Then Phase 9 (Web UI) planning begins.

## RULES

- Read the plan document section BEFORE implementing. It has exact code examples.
- One task per session. One commit for the implementation, one for progress update.
- Run the FULL test suite after the task, not just new tests.
- Keep changes minimal and surgical. This is a hardening pass, not a refactor.
