Read CLAUDE.md for project rules and conventions.
Read plans/phase-7-sparkplug-hub.md for the full phase plan.
Read plans/phase-7-tasks.json for the task list.
Read plans/phase-7-progress.md for current progress.

You are implementing Phase 7 (Sparkplug B Hub Link) of CollatrEdge, **one task per session**.

## HOW THIS WORKS

1. Read `plans/phase-7-tasks.json`
2. Find the **first task** where `"passes": false`
3. That is YOUR task for this session. Do that ONE task only.
4. When done: set `"passes": true` in the JSON, update `plans/phase-7-progress.md`, commit, push.
5. Output: `TASK_COMPLETE — <task_id>`

If ALL tasks have `"passes": true`, output: `PHASE_7_COMPLETE — <total test count> tests, <failure count> failures`

**Do NOT continue to the next task.** Each task runs in a fresh context via the loop script.

## CONTEXT

Phase 6 (CLI) is complete. 560 tests pass, 0 failures. Phase 7 adds the Sparkplug B Hub link — the MQTT connection to Collatr Hub for device telemetry, birth/death certificates, and control plane commands.

The key PRD references are:
- `prd/09-hub-link-control-plane.md` — primary spec
- `prd/appendix-c-sparkplug-b-topic-map.md` — topic/payload structure
- `prd/10-network-policy-standalone-operation.md` — network modes (context only, enforcement is Phase 8)

## PER-TASK FLOW

1. Read the task's `steps` and `prd_refs` from the JSON
2. Read the referenced PRD sections
3. Read any existing source files you'll modify or depend on
4. Implement the task following the steps
5. Write tests (prioritise hard paths — Rule 9)
6. Run `bun test` — **ALL tests must pass** (not just new ones)
7. Commit with message format: `phase-7: <what> — <why if not obvious>`
8. Update `plans/phase-7-progress.md` (mark task done, record test count and commit hash)
9. Set `"passes": true` for this task in `plans/phase-7-tasks.json`
10. Commit the progress/JSON update
11. Push all commits
12. Output: `TASK_COMPLETE — <task_id>`

## IMPORTANT: Task 7.0 is a HARD GATE

Task 7.0 (sparkplug-payload spike) MUST pass before any other Phase 7 work. If the library doesn't work with Bun:
1. Try `@jcoreio/sparkplug-payload` (maintained fork)
2. Try using `protobufjs` directly
3. If nothing works, STOP and output: `SPIKE_FAILED — <details>`. Do not proceed.

## Key Design Decisions (already made — do not change)

- **Hub link is a runtime component, not a plugin.** Created by plugin factory when `[agent.hub]` is enabled, wired into PipelineRuntime lifecycle.
- **Device ID = plugin alias.** Each input plugin instance maps to one Sparkplug B device.
- **_device_id tag for metric routing.** Accumulator adds `_device_id` tag when input has an alias. MQTT output reads it for Sparkplug routing. Strip before encoding.
- **Auto-DBIRTH on first data.** Hub link tracks which devices have published DBIRTH. On first `publishDeviceData()`, publish DBIRTH automatically.
- **bdSeq starts at 0 for MVP.** Persistence via SQLite state is deferred. Add a TODO comment.
- **NCMD: only `Node Control/Rebirth` in Phase 7.** Config push is deferred.
- **MqttClientInterface is shared.** Extract types to `src/core/mqtt-types.ts`, wrapper to `src/core/mqtt-client.ts`.

## RULES

- Read the PRD section BEFORE implementing. The spec is detailed — don't guess.
- One task per session. One commit for the implementation, one for progress update.
- Run the FULL test suite after the task, not just new tests.
- Never use `any` type except in test fixtures where typing adds no value.
- Never swallow errors with empty catch blocks.
- Use `bun:test` (describe/it/expect). Not Jest, not Vitest.
- Use ESM imports. No require().
- Test with mock MQTT clients (DI pattern). Don't connect to real brokers in unit tests.
- The `mqtt` npm package is already installed. `sparkplug-payload` needs to be added (task 7.0).
- New files go in `src/hub/` (hub-link, codec), `src/plugins/outputs/` (mqtt output), or `src/core/` (mqtt types/client).
