Read CLAUDE.md for project rules and conventions.
Read plans/phase-6-independent-review.md for the independent review findings.
Read plans/phase-6-progress.md for what was built.
Check `git log --oneline -10` to see recent commits.

You are implementing fixes from the Phase 6 independent review, then preparing for Phase 7.

## CONTEXT

Phase 6 (CLI) is feature-complete but the independent review found 2 RED issues that must be fixed before Phase 7 can start:

**RED-01: 4 E2E error-resilience tests broken by logger migration**
- `captureErrors()` in `test/e2e/helpers.ts` spies on `console.error`, but Phase 6 replaced all `console.error` in src/ with `getLogger().error()` → `process.stderr.write()`.
- The errors ARE being emitted (visible as JSON lines in stderr) but the capture function can't see them.
- Fix: Update `captureErrors()` to spy on `process.stderr.write` and parse the JSON output to extract error messages. Or provide dual capture.
- Affected tests: 5.4.1, 5.4.2, 5.4.3, 5.4.4 in `test/e2e/error-resilience.test.ts`

**RED-02: Test 5.2.3 (daily rotation) fails near UTC midnight**
- `makeMetricsForDay` uses `Date.now()` as base, then spreads 50 metrics 1 minute apart.
- When run near midnight UTC, metrics spill across day boundaries (5 daily files instead of 3).
- Fix: Snap to midday of each target day so the 50-minute spread cannot cross a boundary:
```typescript
const todayMidnight = now - (now % MS_PER_DAY);
const day1Ms = todayMidnight - 10 * MS_PER_DAY + 12 * 3_600_000; // 10 days ago, noon
const day2Ms = todayMidnight - 1 * MS_PER_DAY + 12 * 3_600_000;  // yesterday, noon
const day3Ms = todayMidnight + 12 * 3_600_000;                     // today, noon
```

There are also SHOULD-fix items from the review (add SIGTERM test, fix parseGlobalOptions edge case, document processor filter field semantics). Address these if time permits after the two REDs.

## WORKFLOW

1. Read `plans/phase-6-independent-review.md` — understand all findings.
2. Fix RED-01 first (captureErrors helper), run `bun test` — all E2E tests must pass.
3. Commit: `phase-6: fix E2E error-resilience tests — update captureErrors() for logger migration`
4. Fix RED-02 (test 5.2.3 timestamps), run `bun test` — 5.2.3 must pass.
5. Commit: `phase-5: fix test 5.2.3 — use midday timestamps to prevent UTC day boundary spill`
6. Address SHOULD-fix items if practical (SIGTERM test, parseGlobalOptions, processor filter comment).
7. Run full `bun test` — **ALL tests must pass, zero failures.**
8. Push all commits.
9. Output: FIXES_COMPLETE

## RULES

- Read the relevant review findings BEFORE writing code.
- Run the FULL test suite (`bun test`) before committing, not just the affected tests.
- Never use `any` type except in test fixtures where typing adds no value.
- Never swallow errors with empty catch blocks.
- Use `bun:test` (describe/it/expect). Not Jest, not Vitest.
- Use ESM imports. No require().

## COMPLETION

When all fixes are done, tests pass, and commits are pushed, output: FIXES_COMPLETE
