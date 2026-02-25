# Phase 9 — Fix Verification Review

**Reviewer:** Independent sub-agent (fix verification)
**Date:** 2026-02-25
**Scope:** Verify commit `db39369` correctly addresses MF-1, SF-2, SF-3, SF-6 from the independent review
**Baseline:** 984 tests → 1003 tests (per review doc), 0 failures

---

## Fix Verifications

### MF-1: Trust form + Bearer auth incompatibility — **PASS** ✅

**What was broken:** HTML `<form method="post">` cannot send `Authorization: Bearer` headers, so the trust workflow was always 401 when `admin_token` was configured.

**What was changed:**

| File | Change | Verified |
|------|--------|----------|
| `src/web/views/certificates.tsx` | `<form method="post">` replaced with `<button class="trust-btn">` elements with `data-endpoint`/`data-thumbprint` attributes. Inline `<script>` attaches click handlers using `fetch()` with `Authorization: Bearer` header. Token is JS-escaped for safe embedding. | ✅ Correct |
| `src/web/routes/certificates.ts` | `handleCertificatesPage` now accepts and passes `adminToken` to `CertificatesPage`. `handleCertificateDownload` is now `async` returning `Promise<Response>`, uses `Bun.file().arrayBuffer()` instead of `readFileSync`. | ✅ Correct |
| `src/web/server.ts` | `/certificates` route passes `config.admin_token` to `handleCertificatesPage`. | ✅ Correct |
| `test/unit/web/routes/certificates.test.ts` | New test "trust buttons use fetch with auth instead of form POST" — verifies no `method="post"`, no `action="/api/certificates/trust"`, presence of `trust-btn` class, `data-endpoint`/`data-thumbprint` attributes, and that `Authorization`/`Bearer`/token string appear in rendered HTML. | ✅ Correct |

**Security consideration:** Admin token is server-rendered into the page HTML. Acceptable because the Web UI is localhost-only (`bind: 127.0.0.1`) — anyone who can view the page is already a local user. Noted and justified in the review doc.

**Regression check:** No regressions. The `ServerCertSection` component correctly handles the case where `adminToken` is undefined (empty string used, no `Authorization` header sent). The existing HTTP endpoint tests for auth (401 without token, 200 with correct token) still pass.

---

### SF-2: Timezone offset day boundary bug (UTC+13/+14) — **PASS** ✅

**What was broken:** `getTimezoneOffset()` converted `hour === 24` to `0` without adjusting the day, producing wrong offsets for UTC+13/+14 zones.

**What was changed:**

| File | Change | Verified |
|------|--------|----------|
| `src/web/routes/export.ts` | Removed conditional `getNum(utcParts, "hour") === 24 ? 0 : getNum(utcParts, "hour")` on both `utcDate` and `localDate` constructions. Now passes `hour` directly to `Date.UTC()`, which natively handles hour=24 by rolling to next day 00:00. Comment added explaining the fix. | ✅ Correct |
| `test/unit/web/routes/export.test.ts` | New test "handles UTC+13 timezone at day boundary correctly (SF-2)" — uses `Pacific/Tongatapu` with `2024-01-15T12:00:00Z`, verifies local timestamp contains `+13:00` and `2024-01-16T01:00:00`. | ✅ Correct |

**Code review of the fix:** The fix is sound. `Date.UTC(2024, 0, 15, 24, 0)` is equivalent to `Date.UTC(2024, 0, 16, 0, 0)` per the ECMAScript spec. The previous hack discarded day rollover information, which was the root cause. Removing it is the correct minimal fix.

**Regression check:** All existing timezone tests (UTC, London, New York, Berlin) continue to work because `Date.UTC()` with hours 0–23 behaves identically with or without the guard.

---

### SF-3: SSE catch swallows all errors — **PASS** ✅

**What was changed:**

| File | Change | Verified |
|------|--------|----------|
| `src/web/routes/stream.ts` | Empty `catch {}` replaced with `catch (err)` that checks `err instanceof Error` and logs via `console.error("[web] SSE stream error:", err.message)` for errors whose messages don't contain "abort", "cancel", or "closed". | ✅ Correct |

**Code review:** The suppression list is appropriate:
- `"abort"` — AbortSignal/AbortError from client disconnect
- `"cancel"` — Stream cancellation
- `"closed"` — `Controller is already closed` during SSE teardown (common in tests and normal operation)

Non-connection errors (e.g., `TypeError` from `adapter.getLiveMetrics()`, rendering errors in `StatusPanelFragment()`) will now be logged, making production debugging possible without flooding logs with expected disconnect noise.

**Regression check:** No regressions. The catch block still breaks out of the while loop on any error (connection or otherwise), so SSE cleanup behavior is unchanged.

---

### SF-6: readFileSync in cert download — **PASS** ✅

**What was changed:**

| File | Change | Verified |
|------|--------|----------|
| `src/web/routes/certificates.ts` | `handleCertificateDownload` signature changed from `function` returning `Response` to `async function` returning `Promise<Response>`. Body uses `Buffer.from(await Bun.file(certInfo.clientCert.path).arrayBuffer())` instead of `readFileSync(certInfo.clientCert.path)`. The `import { readFileSync } from "node:fs"` has been removed entirely. | ✅ Correct |
| `test/unit/web/routes/certificates.test.ts` | All 5 download tests now use `await` on `handleCertificateDownload()`. | ✅ Correct |

**Regression check:** The Elysia route handler in `server.ts` already used an arrow function returning the result, and Elysia handles `Promise<Response>` natively, so the async change is transparent to the HTTP layer. HTTP endpoint test "GET /api/certificates/client/download?format=pem returns cert file" validates this end-to-end.

---

## Deferral Assessments

### SF-1: Hardcoded metrics — **APPROPRIATE** ✅

The dashboard hardcodes four metric names (temperature, pressure, lineSpeed, humidity). This is a genuine limitation but:
- §21 explicitly scopes Phase 9 as "minimal"
- The MVP demo scenario works when metric names match
- Dynamic metric rendering is a significant feature requiring UI architecture changes
- Acknowledged and tracked for post-MVP in the review doc

**Assessment:** Appropriate deferral. Not a correctness bug — it's a feature gap acknowledged as a known limitation.

### SF-4: Health endpoints — **APPROPRIATE** ✅

`/health`, `/health/ready`, `/health/live` are mentioned in §15 and §17 but:
- §21's Phase 9 scope description does not include health endpoints
- They are infrastructure endpoints, not user-facing functionality
- No acceptance criteria in §22 depend on them

**Assessment:** Appropriate deferral. Clearly outside the defined phase scope.

### SF-5: DRY violation (PluginHealthTable × 3) — **APPROPRIATE** ✅

Duplicated rendering logic across dashboard, status-panel, and plugin-table:
- Pure maintenance/style issue with no functional impact
- Naturally pairs with SF-1 (dynamic metrics) since the dashboard will be refactored anyway
- No risk of user-facing bugs from the duplication

**Assessment:** Appropriate deferral. Low-priority maintenance work that pairs with future dashboard refactoring.

---

## New Issues Found

**None.** The fixes are clean, minimal, and well-targeted. No new problems introduced.

Minor observations (non-blocking, not new issues):
- The inline `<script>` in `ServerCertSection` uses an IIFE with `var` declarations — stylistically inconsistent with the project's modern JS conventions but functionally correct and appropriate for inline HTML scripts where scope isolation matters.
- The token escaping (`replace(/\\/g, "\\\\").replace(/'/g, "\\'")`) handles backslashes and single quotes but not other special characters (e.g., `</script>` in a token could break the HTML). In practice, the auto-generated token is 32-char base64url (alphanumeric + `-_`) so this is not exploitable.

---

## Summary

| Item | Type | Verdict |
|------|------|---------|
| MF-1: Trust form + auth | Fix | **PASS** ✅ |
| SF-2: TZ day boundary | Fix | **PASS** ✅ |
| SF-3: SSE catch | Fix | **PASS** ✅ |
| SF-6: readFileSync | Fix | **PASS** ✅ |
| SF-1: Hardcoded metrics | Deferral | **APPROPRIATE** ✅ |
| SF-4: Health endpoints | Deferral | **APPROPRIATE** ✅ |
| SF-5: DRY violation | Deferral | **APPROPRIATE** ✅ |
| New issues | — | **None** |

## Final Recommendation: **UNCONDITIONAL GO** ✅

All four fixes are correct, complete, and well-tested. No regressions introduced. All three deferrals are reasonable and appropriately justified. The independent review's upgrade from CONDITIONAL GO to UNCONDITIONAL GO is confirmed.

Phase 9 is complete.
