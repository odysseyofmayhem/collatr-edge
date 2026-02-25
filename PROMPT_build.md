Read CLAUDE.md for project rules and conventions.
Read plans/spike-web-ui-stack.md for the full spike plan.

You are running the Web UI stack spike for CollatrEdge. This validates the Bun + Elysia + Datastar + ECharts stack before Phase 9 implementation.

## CONTEXT

Phases 1–8.5 are complete. 790+ tests pass, 0 failures. The spike is separate from the main codebase — all spike work goes in `spike-web-ui/` with its own `package.json`.

## HOW THIS WORKS

The spike plan has 6 spikes (1–6). Work through them in order. Each spike builds on the previous one.

The human will direct you interactively — they will tell you which spike to work on and provide feedback as you go. Do NOT rush ahead to the next spike without confirmation.

## SPIKE WORKFLOW

1. Read the spike section from the plan document
2. Implement it in `spike-web-ui/`
3. Test it — verify pass/fail criteria
4. Report results: what worked, what didn't, any surprises
5. Wait for direction before proceeding

## KEY RULES

- All spike code goes in `spike-web-ui/` — do NOT modify `src/` or add deps to the main `package.json`
- This is exploratory work. Quick and dirty is fine. We're finding holes, not writing production code.
- If something doesn't work, document WHY and try the fallback approach from the plan.
- Commit spike progress as you go: `spike: <what>`

## STACK

- **Runtime:** Bun
- **HTTP Framework:** Elysia
- **JSX:** `@elysia/html` (Kita runtime)
- **Reactivity:** Datastar (client ~11KB, server SDK `@starfederation/datastar-sdk`)
- **Charts:** ECharts (web component wrapper)
- **Transport:** SSE over HTTP/1.1

## DO NOT

- Add dependencies to the main `package.json`
- Modify anything in `src/`, `test/`, or `plans/`
- Use React, Preact, or any SPA framework
- Fetch anything from CDNs — all assets must be servable from local files
