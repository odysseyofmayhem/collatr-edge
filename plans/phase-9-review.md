# Phase 9 Code Review

**Reviewer:** Separate context (not the code author), per CLAUDE.md Phase Review Process
**Date:** 2026-02-25
**Phase:** Phase 9 — Local Web UI
**PRD Sections Reviewed:** §4 (Architecture), §7 (Configuration), §10 (Network Policy), §11 (Local Data Store), §15 (Observability), §16 (Security), §17 (Local Web UI), §22 (Acceptance Criteria), Appendix A (Full Config Example), Appendix D §D.3-D.4 (OPC-UA Certificate Workflow)

---

## Summary

Phase 9 delivers a functional local Web UI with dashboard, live metrics via SSE, trend charts via ECharts, CSV export with dual timestamps, and OPC-UA certificate management. The implementation is well-structured following an adapter pattern that cleanly separates pipeline state from HTTP concerns. Test coverage is thorough with 204 new tests (773 to 977 total). The SSE streaming uses the Datastar SDK correctly with RC.7 syntax. CSV export meets the acceptance criteria (3600 metrics in <5 seconds). Lifecycle ordering in `run.ts` is correct (metric sink registered before pipeline start, web server started after pipeline, stopped before pipeline).

Key concerns: the TOFU trust store uses a JSON file instead of SQLite as specified in PRD Appendix D §D.4; the POST /api/certificates/trust endpoint has no authentication; and the dashboard has hardcoded metric names that will not adapt to different deployments.

---

## 🔴 Must Fix

### MF-1: TOFU trust store uses JSON file, PRD specifies SQLite

**Files:** `src/web/routes/certificates.ts` (trust handler), `src/web/adapter.ts`
**PRD ref:** Appendix D §D.4: "Plugin stores the certificate fingerprint in the local trust store (SQLite)"

The trust store is implemented as a JSON file (`trusted-servers.json`) using `writeFileSync`/`readFileSync`. The PRD explicitly states the TOFU trust store should use SQLite. The local-store already uses `bun:sqlite`, so the pattern is established. JSON files have TOCTOU race conditions on concurrent read-modify-write, no transactional integrity, and will break if the process crashes mid-write.

**Fix:** Replace the JSON file trust store with a SQLite table, consistent with the PRD specification and the existing `bun:sqlite` pattern in the project.

### MF-2: No authentication on POST /api/certificates/trust

**Files:** `src/web/server.ts`, `src/web/routes/certificates.ts`
**PRD ref:** §16 Security: "Basic authentication on the Web UI with two roles" (Admin/Viewer). §17: "MVP: authentication for Admin access"

The POST /api/certificates/trust endpoint is the **only write operation** in the MVP Web UI, and it modifies the trust store — a security-critical file. It has zero authentication. Any process or user that can reach port 8080 can modify the trust store. While the server binds to localhost by default, this still allows any local process to inject a trusted server.

**Fix:** At minimum, add a simple bearer token or basic auth check to this one endpoint. Full Auth (Admin/Viewer roles) can be post-MVP, but the trust-modifying endpoint needs protection now.

### MF-3: `writeFileSync` in async HTTP handler creates blocking I/O

**Files:** `src/web/routes/certificates.ts` (trust handler)

`handleCertificateTrust` is declared `async` but uses `readFileSync`, `writeFileSync`, `existsSync`, and `mkdirSync` inside the handler. These are synchronous, blocking the event loop. While trust operations are infrequent, this pattern violates the project's async conventions (CLAUDE.md: "Use async/await").

**Fix:** Replace with `await Bun.file(path).text()` and `await Bun.write(path, data)` or async `fs/promises` equivalents. (Note: if MF-1 is addressed by switching to SQLite, this becomes moot as `bun:sqlite` is synchronous by design but non-blocking in Bun.)

---

## 🟡 Should Fix

### SF-1: Dashboard has hardcoded metric names (temperature, pressure, lineSpeed, humidity)

**Files:** `src/web/views/dashboard.tsx` (lines 158, 166-194, 228-274)

The dashboard renders exactly four metrics with hardcoded names, units, and chart IDs. Any deployment with different metric names will see "0" or "--" permanently.

**Fix:** Make the dashboard dynamic — render metric cards from the adapter's current metric list at page-load time.

### SF-2: PluginHealthTable and formatDuration duplicated 3 times (DRY violation)

**Files:** `src/web/views/dashboard.tsx`, `src/web/views/fragments/status-panel.tsx`, `src/web/views/fragments/plugin-table.tsx`

`PluginHealthTable` is copy-pasted identically in three files. `formatDuration` is duplicated in `dashboard.tsx` and `status-panel.tsx`.

**Fix:** Extract into shared modules (e.g., `src/web/views/components/`).

### SF-3: SSE stream catches all errors silently

**Files:** `src/web/routes/stream.ts` (catch block)

The `catch {}` block catches all errors including non-disconnect errors. Genuine bugs in the SSE loop will be silently swallowed.

**Fix:** Log non-connection errors before breaking.

### SF-4: `getTimezoneOffset()` has potential edge case at midnight boundary

**Files:** `src/web/routes/export.ts`

The timezone offset function computes UTC offset by formatting dates and diffing. Hour 24→0 conversion loses the day boundary, producing wrong offsets for UTC+13/+14 zones at certain times.

**Fix:** Add test cases for edge timezones and fix the day-boundary handling.

### SF-5: No health endpoints (PRD §15)

**PRD ref:** §15 Observability: "GET /health, /health/ready, /health/live"

Machine-readable health endpoints are missing. Important for monitoring and container orchestration.

**Fix:** Add `GET /health`, `/health/ready`, `/health/live` endpoints.

### SF-6: Synchronous file operations in adapter constructor

**Files:** `src/web/adapter.ts` (`_loadClientCert`)

`_loadClientCert()` uses `existsSync`/`readFileSync` in the constructor.

**Fix:** Accept as startup-time sync I/O (acceptable) and document, or make async with an `init()` method.

### SF-7: SSE intervals (1s signals, 2s elements) are hardcoded

**Files:** `src/web/routes/stream.ts`

Stream intervals are constants in the code rather than configurable values.

**Fix:** Low priority — acceptable for MVP. Note for future configurability.

---

## 🟢 Nice to Have

### NH-1: HTTPS support not implemented (PRD §16: "HTTPS optional")

Acceptable for MVP since server binds to localhost by default.

### NH-2: Many PRD §17 features not implemented

Configuration page, Logs viewer, Secrets management, Plugins list, Health Monitoring, Audit Trail, Storage Indicator, Basic Reporting, Ghost Features. These are likely aspirational beyond Phase 9 scope — should be explicitly tracked.

### NH-3: Version hardcoded in dashboard footer

`CollatrEdge v0.1.0` is hardcoded in JSX. Should use `packageJson.version`.

### NH-4: CSV export does not support JSON or Parquet formats (PRD §11)

Only CSV implemented. Acceptable for MVP.

### NH-5: No CSRF protection on POST /api/certificates/trust

Attack surface is limited to localhost, but a malicious page could make cross-origin requests.

### NH-6: `getFreePort()` in tests uses random ports which could collide

`Math.floor(Math.random() * 50000)` could collide. Using `{ port: 0 }` with OS allocation would be more robust.

---

## PRD Compliance Table

| Module | PRD Section | Status | Notes |
|--------|-------------|--------|-------|
| WebUIAdapter | §17, §4 | ✅ | Clean read-only facade. Correct Broadcaster observer pattern. |
| Elysia server | §17 (Technology) | ✅ | Correctly uses Elysia + Kita JSX + Datastar SDK. |
| Config parsing | §7, §16 | ✅ | `[webui]` section with correct defaults. |
| Dashboard page | §17 (Live Values) | ⚠️ | Live values work but metric names are hardcoded. |
| Network policy banner | §10 | ✅ | Color-coded: standalone=red, local_network=amber, connected=green. |
| SSE streaming | §17 | ✅ | Correct RC.7 syntax. Signals + element patches in single stream. |
| Trend charts | §17 | ✅ | ECharts web component with history load + live append. |
| CSV export | §17, §11, §22 Scenario 4 | ✅ | Dual timestamps, performance test passes (<5s). |
| Certificate page | Appendix D §D.3-D.4 | ⚠️ | Client cert view/download works. Trust store is JSON not SQLite. |
| Trust endpoint | Appendix D §D.4 | ❌ | No auth (MF-2). Wrong storage format (MF-1). Sync I/O (MF-3). |
| Authentication | §16 | ❌ | Admin/Viewer roles not implemented. Trust endpoint unprotected. |
| Health endpoints | §15 | ❌ | GET /health, /health/ready, /health/live not implemented. |
| Lifecycle ordering | §8 | ✅ | Correct: register sink → start pipeline → start web → stop web → stop pipeline. |
| Pipeline runtime | §4 | ✅ | State machine (stopped→starting→running→stopping→stopped). |
| Config init/validate | §7 | ✅ | WebUI section in all three network modes. Validate shows status. |

---

## Rules Compliance

| Rule | Status | Notes |
|------|--------|-------|
| Rule 1: No Hand-Waving | ✅ | Tests are thorough. No skipped tests or timing workarounds. |
| Rule 2: Tests Prove Behaviour | ✅ | Good priority: data correctness, failure modes, edge cases. 204 new tests. |
| Rule 3: Small Verified Steps | ✅ | 9 tasks in logical order, each tested before commit. |
| Rule 4: One Thing at a Time | ✅ | Clear task decomposition (9.0–9.8). |
| Rule 5: PRD Is the Spec | ⚠️ | TOFU trust store deviates from PRD (JSON vs SQLite). Dashboard metrics hardcoded. |
| Rule 6: Commit Discipline | ✅ | Clear commit messages with phase prefix and context. |
| Rule 7: No Premature Abstraction | ✅ | No over-engineering. WebUIAdapter is appropriately scoped. |
| Rule 8: Interface Compliance | ✅ | WebUIAdapter interface matches documented behavior. |
| Rule 9: Test Hard Paths | ✅ | Tests cover invalid params, missing stores, cert failures, edge cases. |
| Rule 10: No Hardcoded Config | ⚠️ | SSE intervals hardcoded. Dashboard metrics hardcoded. Port/bind from config. |
| Rule 11: Async Error Handling | ⚠️ | SSE catch swallows all errors (SF-3). Sync I/O in async handler (MF-3). |
| Rule 12: Lifecycle Ordering | ✅ | Correct ordering in run.ts. |
| Rule 13: Per-Instance Not Global | ✅ | No global flag issues. Per-adapter, per-route instances. |

---

## Phase Completion Assessment

**Phase 9 delivers a functional Web UI** meeting core acceptance criteria:
- Dashboard with live metrics via SSE — working
- Trend charts with historical load and live append — working
- CSV export with dual timestamps in <5 seconds — working
- OPC-UA certificate management page — working (with caveats)
- Config parsing and CLI integration — working
- Lifecycle correctly wired in run.ts — working

**Blocking issues before completion:**
1. **MF-1** (TOFU trust store: JSON → SQLite) — PRD explicitly specifies SQLite
2. **MF-2** (No auth on trust endpoint) — Security-critical write with zero access control
3. **MF-3** (Sync I/O in async handler) — Violates project async conventions

**Recommended fix ordering:** MF-1 first (addresses MF-3 as side effect if using bun:sqlite), then MF-2.

**Should Fix priority for Phase 10:**
- SF-1 (hardcoded metrics) — highest impact on usability
- SF-3 (SSE error swallowing) — debugging concern
- SF-5 (health endpoints) — monitoring integration
- SF-2, SF-4, SF-6, SF-7 — lower priority

**Test health:** All 977 tests pass. No flaky tests. Strong coverage on happy and error paths.
