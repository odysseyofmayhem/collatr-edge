# Phase 12: WebUI Redesign — Final Code Review (Tasks 12.7–12.9)

**Reviewer:** Claude Code (fresh context, separate from implementing agent)
**Date:** 2026-03-10
**Scope:** Review follow-up commits after initial review (2b21a71):
- 1719e43: extract duplicate collectMetricNames to shared module (task 12.7)
- 318d8af: staleness test imports actual module instead of re-implementing (task 12.8)
- 7bc95bd: wire pipeline stats into status panel, filter agent.* from equipment cards (task 12.9)

**Test results:** 68 tests pass across 3 reviewed test files, 0 failures.

---

## Prior Review Findings — Status

| Finding | Description | Status | Notes |
|---------|-------------|--------|-------|
| F-01 | staleness.js missing from ASSET_MAP | **FIXED** | `server.ts` line 33+40 now imports and registers `staleness.js` |
| F-02 | Duplicate collectMetricNames | **FIXED** | Extracted to `src/web/adapter-helpers.ts`, both consumers import it |
| F-03 | Hardcoded version string v0.1.0 | **OPEN** | Still present in `dashboard.tsx:171` and `trends.tsx:210` |
| F-04 | Staleness test re-implements logic | **FIXED** | Test now evaluates source via `Bun.file()` + `new Function()` |
| F-05 | SSE stream intervals hardcoded | **OPEN** | `stream.ts:85-86` still uses module-level constants |
| F-06 | Staleness thresholds hardcoded | **OPEN** | `staleness.js:16-18` still uses hardcoded 30s/60s values |

---

## New Findings from Tasks 12.7–12.9

### Must Fix

No must-fix findings. All three tasks are implemented correctly and the critical F-01 blocker from the prior review is resolved.

---

### Should Fix

**F-11: `toLocaleString()` in SSR context may produce inconsistent formatting**
Severity: **Should Fix (Priority 2)**
Files: `src/web/views/fragments/status-panel.tsx` (lines 81, 83, 89, 93, 97)

The status panel uses `stats.metricsGathered.toLocaleString()` etc. during server-side rendering. On the Raspberry Pi target hardware, the system locale may differ from the expected "en-GB" or "en-US" formatting. This could produce unexpected number formats (e.g., `12.345` instead of `12,345` in some locales).

The dashboard test at line 498 asserts `expect(html).toContain("12,345")` — this test will fail on systems with a non-comma-thousands locale.

**Suggested fix:** Use `.toLocaleString("en-GB")` or a simple formatting helper to ensure consistent output regardless of system locale.

---

**F-12: Integration test mockAdapter missing `getStats()` method initially**
Severity: **Should Fix (Priority 2)**
File: `test/integration/web-ui.test.ts` (line 86)

The integration test's `mockAdapter` returns `getStats: () => null` (line 86). This is correct for a minimal mock, but it means the integration tests never exercise the pipeline stats rendering path via HTTP. A full integration test with stats populated would increase confidence that the SSE patchElements for the status panel correctly includes stats counters at runtime.

**Suggested fix:** Add one integration test case with non-null stats in the mock adapter that verifies the dashboard HTML contains "Gathered" and "Written" labels.

---

### Nice to Have

**F-13: Staleness test uses `new Function()` eval pattern**
Severity: **Nice to Have**
File: `test/unit/web/staleness.test.ts` (lines 13-29)

The staleness test reads `staleness.js` as raw text, strips `export` keywords with regex, and evaluates via `new Function()`. This is creative and works around the Bun `{ type: "file" }` import conflict (well-documented in the comment). However, the regex `replace(/^export /gm, "")` is fragile — it would break if a future export used `export default`, `export const`, or `export {`. Currently safe because `staleness.js` only has `export function`, which the regex handles correctly by turning it into `function`.

No action needed now, but if `staleness.js` exports change, this test will silently stop extracting the right symbols.

---

**F-14: StatusBadge logic still duplicated between dashboard.tsx and trends.tsx**
Severity: **Nice to Have**
File: `src/web/views/dashboard.tsx` (lines 72-85), `src/web/views/trends.tsx` (lines 173-181)

This was F-07 in the prior review and remains unaddressed. The dashboard has a `StatusBadge` component, while the trends page inlines the same status label logic. Low priority since the logic is trivial and unlikely to diverge.

---

## PRD Compliance Table — Tasks 12.7–12.9

### adapter-helpers.ts (Task 12.7)

| Requirement | Status | Notes |
|---|---|---|
| collectMetricNames extracted to shared module | PASS | Single source of truth in `adapter-helpers.ts` |
| dashboard.tsx imports from shared module | PASS | Line 12: `import { collectMetricNames } from "../adapter-helpers"` |
| trends.tsx imports from shared module | PASS | Line 10: `import { collectMetricNames } from "../adapter-helpers"` |
| agent.* metrics filtered from equipment cards | PASS | Line 28: `.filter((name) => !name.startsWith("agent."))` |
| No duplicate implementations remain | PASS | Verified: no other files define collectMetricNames |

### staleness.test.ts (Task 12.8)

| Requirement | Status | Notes |
|---|---|---|
| Test imports actual classifyStaleness function | PASS | Via Bun.file() + eval (lines 13-29) |
| No re-implementation of classification logic | PASS | Previous TypeScript re-implementation removed |
| Tests use actual STALE_MS/DEAD_MS constants | PASS | Lines 58-63 test exact boundaries using exported constants |
| All staleness classification tests pass | PASS | 6 classification tests pass |

### adapter.ts — getStats() (Task 12.9)

| Requirement | Status | Notes |
|---|---|---|
| WebUIAdapter interface includes getStats() | PASS | Line 105: `getStats(): StatsCollector \| null` |
| PipelineWebUIAdapter accepts stats constructor param | PASS | Line 129: `stats?: StatsCollector \| null` |
| PipelineWebUIAdapter.getStats() returns stored stats | PASS | Lines 300-302 |
| Stats wired from run.ts via SimpleStatsCollector | PASS | run.ts line 204: `statsCollector` passed to adapter |

### status-panel.tsx — pipeline counters (Task 12.9)

| Requirement | Status | Notes |
|---|---|---|
| Renders Gathered/Written/Dropped/Gather Errors/Write Errors | PASS | Lines 79-99 |
| Conditional rendering when stats is null | PASS | Line 76: `stats ?` guard |
| stat-warn class on non-zero dropped | PASS | Line 89 |
| stat-error class on non-zero errors | PASS | Lines 93, 97 |
| Counters formatted with toLocaleString() | PASS | Lines 81, 83, 89, 93, 97 |
| CSS classes stat-warn/stat-error defined | PASS | layout.tsx lines 134-135 |

### signal-descriptors.ts — agent.* metadata (Task 12.9)

| Requirement | Status | Notes |
|---|---|---|
| agent.* signals in lookup table | PASS | Lines 165-173: 9 agent signal descriptors |
| Correct types (counter, numeric) | PASS | uptime/gathered/written/dropped/errors = counter; memory/input/output = numeric |

### dashboard.test.ts — stats tests (Task 12.9)

| Requirement | Status | Notes |
|---|---|---|
| Test renders pipeline stats counters | PASS | Lines 487-500 |
| Test stat-warn on drops | PASS | Lines 502-509 |
| Test stat-error on errors | PASS | Lines 511-521 |
| Test null stats omits counters | PASS | Lines 523-536 |
| Test agent.* excluded from equipment cards | PASS | Lines 540-555 |

---

## Rules Compliance — Tasks 12.7–12.9

| Rule | Status | Notes |
|---|---|---|
| Rule 1 (No hand-waving) | PASS | No skipped tests or dismissals |
| Rule 2 (Tests prove behaviour) | PASS | Stats rendering tested for all states (values, warnings, errors, null) |
| Rule 5 (PRD is spec) | PASS | agent.* filtering and stats panel match plan task 12.9 spec |
| Rule 8 (Interface compliance) | PASS | getStats() added to both interface and implementation |
| Rule 9 (Test hard paths) | PASS | null stats, error states, boundary conditions tested |
| Rule 10 (No hardcoded overrides) | PARTIAL | F-03 (version string) still open from prior review |
| Rule 11 (Handle async errors) | PASS | No new async code introduced |
| Rule 12 (Lifecycle ordering) | PASS | Stats wired at construction time before pipeline.start() |
| Rule 13 (Per-instance not global) | PASS | No per-instance vs global concerns |

---

## Phase 13 Readiness Assessment

Phase 12 is **complete and ready to proceed**. The critical blocker from the initial review (F-01: staleness.js ASSET_MAP) is fixed. All three follow-up tasks (12.7–12.9) are well-implemented:

- Task 12.7 cleanly extracts shared code with the agent.* filter added at the right abstraction level
- Task 12.8 finds a pragmatic workaround for the Bun `{ type: "file" }` import conflict
- Task 12.9 properly extends the adapter interface, wires stats through the constructor chain, and adds conditional rendering with appropriate warning/error styling

**Remaining open items (non-blocking):**
1. **F-03** (hardcoded version "v0.1.0") — Should be addressed early in Phase 13. Low effort.
2. **F-05** (SSE interval constants) — Defer to when config wiring is addressed broadly.
3. **F-06** (staleness thresholds) — Defer. Known limitation acknowledged in phase plan.
4. **F-11** (toLocaleString locale sensitivity) — Fix when internationalisation concerns arise, or add explicit locale parameter now to prevent CI failures on non-English systems.
5. **F-14** (StatusBadge duplication) — Cosmetic, defer indefinitely.

**Test suite:** 68 tests pass across the 3 reviewed files. All tests are meaningful and cover both happy paths and edge cases (null stats, error states, agent.* filtering, staleness boundaries).
