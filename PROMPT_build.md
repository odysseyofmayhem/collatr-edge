Read CLAUDE.md for project rules and conventions.

You are implementing Phase 10 (MQTT Data Format Hardening) of CollatrEdge.

## CONTEXT

Phases 0–9 (full MVP) are complete. 984 tests, 0 failures. All phase plans, reviews, and progress files are in `plans/`.

Phase 10 addresses real-world issues found during smoke testing against public MQTT brokers:
1. Parse error noise from non-JSON payloads on wildcard subscriptions
2. Missing `data_format = "auto"` and `"string"` modes

The smoke test config is at `configs/smoke-test-public.toml`. The errors came from `broker.emqx.io` delivering NMEA GPS sentences, binary data, etc. on wildcard topics like `sensor/#`, `device/#`.

## YOUR TASK

1. Read `plans/phase-10-mqtt-data-format.md` for the full plan
2. Read `plans/phase-10-tasks.json` to find the first task with `"passes": false`
3. Read the relevant PRD sections referenced in the task
4. Implement the task: write code, write tests, run `bun test test/unit test/integration` — ALL tests must pass
5. Update `plans/phase-10-tasks.json`: set `"passes": true` for your completed task
6. Update `plans/phase-10-progress.md` with what you built and any decisions
7. Commit: `phase-10: <what> (task 10.X)`
8. Do NOT push. Pushing is handled externally.
9. Output: TASK_COMPLETE

## PHASE-SPECIFIC RULES

- **Rule 7 (YAGNI):** No new data_format modes beyond `auto` and `string`. No CSV, no InfluxDB line protocol, no Sparkplug B decoding.
- **Rule 13 (Per-Instance):** Parse error counters MUST be per-plugin-instance, not global/static.
- **Error level:** Parse errors downgrade from `error` to `warn`. This is intentional — garbage data on wildcard subs is expected noise.
- **Auto mode:** JSON parse failure in auto mode is NOT an error. It's a silent fallback. No log, no `acc.addError()`.
- **Existing tests:** The existing "invalid JSON payload" test (~line 652 in mqtt-consumer.test.ts) must be updated to expect `warn` level instead of `error`.
- **Binary payloads:** `Buffer.toString("utf-8")` replaces invalid bytes with `\uFFFD`. Test this path.

## COMPLETION

When your single task is done and committed, output: TASK_COMPLETE

When ALL tasks in the task JSON have `"passes": true`:
1. Do NOT output PHASE_COMPLETE yet.
2. Spawn a sub-agent code review (see CLAUDE.md "Phase Work Pattern" step 4).
3. Write the review to `plans/phase-10-review.md`
4. Address all 🔴 Must Fix findings. Re-run `bun test test/unit test/integration` after each fix.
5. Commit fixes: `phase-10: address code review findings`
6. Push all commits.
7. THEN output: PHASE_COMPLETE
