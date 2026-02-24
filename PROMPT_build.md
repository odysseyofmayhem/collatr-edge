Read CLAUDE.md for project rules and conventions.
Read plans/phase-7-sparkplug-hub.md for the full phase plan.
Read plans/phase-7-tasks.json for the task list.
Read plans/phase-7-progress.md for current progress.
Check `git log --oneline -10` to see recent commits.

You are implementing Phase 7 (Sparkplug B Hub Link) of CollatrEdge.

## CONTEXT

Phase 6 (CLI) is complete. 560 tests pass, 0 failures. Phase 7 adds the Sparkplug B Hub link — the MQTT connection to Collatr Hub for device telemetry, birth/death certificates, and control plane commands.

The key PRD references are:
- `prd/09-hub-link-control-plane.md` — primary spec
- `prd/appendix-c-sparkplug-b-topic-map.md` — topic/payload structure
- `prd/10-network-policy-standalone-operation.md` — network modes (context only, enforcement is Phase 8)

## WORKFLOW

This phase has 8 tasks (7.0 through 7.7). Execute them IN ORDER — each builds on the previous.

### Per-Task Flow

1. Read the task in `plans/phase-7-tasks.json`
2. Read the PRD sections listed in `prd_refs`
3. Read any existing source files you'll modify or depend on
4. Implement the task following the steps
5. Write tests (prioritise hard paths — Rule 9)
6. Run `bun test` — **ALL tests must pass** (not just new ones)
7. Commit with message format: `phase-7: <what> — <why if not obvious>`
8. Update `plans/phase-7-progress.md` (mark task done, record test count and commit hash)
9. Move to next task

### IMPORTANT: Task 7.0 is a HARD GATE

Task 7.0 (sparkplug-payload spike) MUST pass before any other Phase 7 work. If the library doesn't work with Bun:
1. Try `@jcoreio/sparkplug-payload` (maintained fork)
2. Try using `protobufjs` directly
3. If nothing works, STOP and report the issue. Do not proceed.

### Key Design Decisions (already made — do not change)

- **Hub link is a runtime component, not a plugin.** It's created by the plugin factory when `[agent.hub]` is enabled, and wired into PipelineRuntime lifecycle.
- **Device ID = plugin alias.** Each input plugin instance maps to one Sparkplug B device. The alias is the device_id.
- **_device_id tag approach for metric routing.** The accumulator adds a `_device_id` tag when the input has an alias. The MQTT output reads this to route metrics to the correct Sparkplug device. Strip the tag before encoding.
- **Auto-DBIRTH on first data.** Hub link tracks which devices have published DBIRTH. On first `publishDeviceData()` call, it publishes DBIRTH automatically.
- **bdSeq starts at 0 for MVP.** Persistence via SQLite state is deferred. Add a TODO comment.
- **NCMD: only `Node Control/Rebirth` in Phase 7.** Config push is deferred.
- **MqttClientInterface is shared.** Extract types to `src/core/mqtt-types.ts`, wrapper to `src/core/mqtt-client.ts`.

### Internal Review Step

After completing ALL tasks (7.0–7.7), perform a self-review:
1. Re-read `plans/phase-7-sparkplug-hub.md` acceptance criteria
2. Run `bun test` one final time
3. Check for any regressions in existing tests
4. Verify commit history is clean and well-described
5. Update `plans/phase-7-progress.md` with final status

## RULES

- Read the PRD section BEFORE implementing. The spec is detailed — don't guess.
- One task per commit (or logical sub-commits within a task). Never batch multiple tasks.
- Run the FULL test suite after each task, not just new tests.
- Never use `any` type except in test fixtures where typing adds no value.
- Never swallow errors with empty catch blocks.
- Use `bun:test` (describe/it/expect). Not Jest, not Vitest.
- Use ESM imports. No require().
- Test with mock MQTT clients (DI pattern). Don't connect to real brokers in unit tests.
- The `mqtt` npm package is already installed. `sparkplug-payload` needs to be added.
- All new files go in `src/hub/` (hub-link, codec) or `src/plugins/outputs/` (mqtt output) or `src/core/` (mqtt types/client).

## COMPLETION

When all 8 tasks pass and the self-review is done, output:

PHASE_7_COMPLETE — <total test count> tests, <failure count> failures
