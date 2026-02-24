Read CLAUDE.md for project rules and conventions.
Read plans/phase-8-network-policy.md for the full phase plan.
Read plans/phase-8-tasks.json for the task list.
Read plans/phase-8-progress.md for current progress.

You are implementing Phase 8 (Network Policy & Standalone Operation) of CollatrEdge, **one task per session**.

## HOW THIS WORKS

1. Read `plans/phase-8-tasks.json`
2. Find the **first task** where `"passes": false`
3. That is YOUR task for this session. Do that ONE task only.
4. When done: set `"passes": true` in the JSON, update `plans/phase-8-progress.md`, commit, push.
5. Output: `TASK_COMPLETE — <task_id>`

If ALL tasks have `"passes": true`:
1. Do NOT output PHASE_8_COMPLETE yet.
2. Spawn a sub-agent code review (see CLAUDE.md "Phase Work Pattern" step 4).
3. Write the review to `plans/phase-8-review.md`
4. Address all 🔴 Must Fix findings. Re-run `bun test` after each fix.
5. Commit fixes: `phase-8: address code review findings`
6. Push all commits.
7. THEN output: `PHASE_8_COMPLETE — <total test count> tests, <failure count> failures`

**Do NOT continue to the next task.** Each task runs in a fresh context via the loop script.

## CONTEXT

Phase 7 (Sparkplug B Hub Link) is complete. 665 tests pass, 0 failures. Phase 8 adds network policy — the config-driven system that controls which network destinations the edge agent can reach, with fail-fast startup enforcement.

The key PRD references are:
- `prd/10-network-policy-standalone-operation.md` — primary spec (three modes, preset table, enforcement architecture)
- `prd/16-security.md` — network policy enforcement section
- `prd/07-configuration.md` — config structure
- `prd/appendix-a-full-config-example.md` — full config showing [network_policy] section

## PER-TASK FLOW

1. Read the task's `steps` and `prd_refs` from the JSON
2. Read the referenced PRD sections
3. Read any existing source files you'll modify or depend on
4. Implement the task following the steps
5. Write tests (prioritise hard paths — Rule 9)
6. Run `bun test` — **ALL tests must pass** (not just new ones)
7. Commit with message format: `phase-8: <what> — <why if not obvious>`
8. Update `plans/phase-8-progress.md` (mark task done, record test count and commit hash)
9. Set `"passes": true` for this task in `plans/phase-8-tasks.json`
10. Commit the progress/JSON update
11. Push all commits
12. Output: `TASK_COMPLETE — <task_id>`

## Key Design Decisions (already made — do not change)

- **Enforcement at the output plugin layer.** Not inside MQTT/HTTP client code. Visible, auditable, testable.
- **Fail at startup, not at runtime.** If policy blocks an output, the pipeline refuses to start with a FATAL log. Never silently drop data.
- **Mode is a preset, overrides are the truth.** `mode = "local_network"` expands to default rules. Explicit `[network_policy.egress]` fields override defaults. Resolved rules are what gets enforced.
- **NetworkPolicy is immutable after construction.** Frozen object, no runtime mutations.
- **Ingress rules are parsed but NOT enforced in Phase 8.** They'll be used in Phase 9 (Web UI).
- **Hub link config + policy conflict = startup error.** If `[agent.hub]` enabled but policy blocks hub egress, fail immediately in plugin factory (before creating HubLink).
- **NetworkPolicy is optional in constructors.** Existing code passes `undefined` — backward compatible. Only enforced when present.
- **Host matching is string-based.** No DNS resolution during matching (we might not have DNS). Parse `allowed_hosts` as `"host:port"` or `"host"` entries.
- **No OS-level DNS blocking.** The `allowDns: false` check rejects hostnames (vs IP addresses) at the application layer. True DNS blocking would require iptables/nftables — post-MVP.
- **Config without `[network_policy]` defaults to connected mode.** Backward compatible.

## WHAT THIS PHASE DOES NOT BUILD

Do not implement any of these — they are explicitly deferred:
- OS-level DNS blocking (iptables/nftables)
- Ingress enforcement (CIDR binding for Web UI)
- Mode transition Sparkplug messages ("going standalone" NDATA)
- NTP reachability checks
- `allow_local_subnet` rule (requires subnet detection)
- Runtime policy changes (policy is startup-only)

## RULES

- Read the PRD section BEFORE implementing. The spec is detailed — don't guess.
- One task per session. One commit for the implementation, one for progress update.
- Run the FULL test suite after the task, not just new tests.
- Never use `any` type except in test fixtures where typing adds no value.
- Never swallow errors with empty catch blocks.
- Use `bun:test` (describe/it/expect). Not Jest, not Vitest.
- Use ESM imports. No require().
- New NetworkPolicy code goes in `src/core/network-policy.ts`.
- Integration tests go in `test/integration/network-policy-enforcement.test.ts`.
- The existing MQTT output and plugin factory already work — add to them, don't rewrite them.
- NetworkPolicy constructor param must be optional to avoid breaking existing tests.
