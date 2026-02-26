Read CLAUDE.md for project rules and conventions.

You are implementing Phase 11 (Real OPC-UA Client Adapter) of CollatrEdge.

## CONTEXT

Phases 0–10 are complete. ~1006 tests, 0 failures. All phase plans, reviews, and progress files are in `plans/`.

Phase 11 builds the `RealOpcuaClient` adapter that bridges the `OpcuaClient` interface (defined in `src/plugins/inputs/opcua.ts`) to the `node-opcua` library. This is the last piece needed for CollatrEdge to connect to real OPC-UA servers. The entire `OpcuaInput` class (subscription handling, data type mapping, reconnection, security auto-negotiation, browse mode) is already built and tested with mock clients. This phase implements the real adapter and wires it into the plugin factory.

The Bun spike (Phase 0) confirmed `node-opcua` v4.x is pure JavaScript and works with Bun. The `node-opcua` dependency is already in `package.json` (added in Phase 2).

## CRITICAL: ONE TASK PER SESSION

You MUST implement exactly ONE task per session, then STOP.

1. Read `plans/phase-11-opcua-client.md` for the full plan
2. Read `plans/phase-11-tasks.json` to find the **first** task with `"passes": false`
3. Read the relevant PRD sections referenced in that task (especially Appendix D for OPC-UA)
4. Implement ONLY that single task: write code, write tests, run `bun test test/unit test/integration` — ALL tests must pass
5. Update `plans/phase-11-tasks.json`: set `"passes": true` for your completed task
6. Update `plans/phase-11-progress.md` with what you built and any decisions
7. Commit: `phase-11: <what> (task 11.X)`
8. Do NOT push. Pushing is handled externally.
9. Output TASK_COMPLETE and STOP. Do NOT continue to the next task. The loop script handles iteration.

## PHASE-SPECIFIC RULES

- **Rule 7 (YAGNI):** No TOFU persistence, no certificate generation, no OPC-UA write services, no Alarms & Conditions. These are all post-MVP.
- **Rule 8 (Interface compliance):** The `OpcuaClient` interface in `opcua.ts` is the contract. `RealOpcuaClient` MUST implement every method. Do not add extra public methods.
- **Lazy loading:** `node-opcua` is ~50MB. Use `require()` in the plugin factory, not top-level import. Only loaded when an OPC-UA input is configured.
- **Port allocation:** OPC-UA tests need in-process `OPCUAServer`. Use port `0` (OS-assigned) to avoid conflicts. Extract actual port after server start.
- **Test timeouts:** OPCUAServer startup is slow. Use `beforeAll` with extended timeout (10-15s). Individual tests can be 5s.
- **Existing tests:** All existing OPC-UA tests use mock clients. They MUST still pass unchanged after factory wiring changes.
- **The TODO at opcua.ts:531:** Remove the "OPC-UA client not provided" throw block. Replace with a safety assertion that should never trigger (factory always provides a client now).
- **DataValue mapping:** `node-opcua` DataValue → our `DataChangeEvent`. Key fields: `value.value` (the actual value), `value.dataType` (DataType enum → string name), `sourceTimestamp`, `serverTimestamp`, `statusCode.value` (numeric).
- **Security policy mapping:** Map string config values ("None", "Basic256Sha256", etc.) to `node-opcua` `SecurityPolicy` and `MessageSecurityMode` enums.

## STOPPING RULES

**After completing ONE task:** Output `TASK_COMPLETE` and stop immediately. Do not look for the next task. Do not start another task. The ralph.sh loop will call you again for the next iteration.

**When ALL tasks have `"passes": true`:** Instead of TASK_COMPLETE, do the following:
1. Do NOT output PHASE_COMPLETE yet.
2. Spawn a sub-agent code review (see CLAUDE.md "Phase Work Pattern" step 4).
3. Write the review to `plans/phase-11-review.md`
4. Address all 🔴 Must Fix findings. Re-run `bun test test/unit test/integration` after each fix.
5. Commit fixes: `phase-11: address code review findings`
6. Push all commits.
7. THEN output: PHASE_COMPLETE
