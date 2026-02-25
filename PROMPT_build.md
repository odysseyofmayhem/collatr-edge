Read CLAUDE.md for project rules and conventions.

You are implementing Phase 9 (Local Web UI) of CollatrEdge. This is the final MVP phase.

## CONTEXT

Phases 1–8.5 are complete. 790+ tests pass, 0 failures. The full codebase is production-quality with 13 enforced rules in CLAUDE.md.

**What exists:**
- Full pipeline: inputs (OPC-UA, Modbus, MQTT, internal), processors (rename, filter), aggregators (basicstats), outputs (local-store, file, stdout, MQTT/Sparkplug B)
- CLI: run, config init, config validate, version
- Network policy: egress enforcement, mode presets, ingress parsing (not enforced yet)
- Hub link: Sparkplug B lifecycle
- LocalStoreOutput has `exportCSV(fromNs, toNs)` and `query(fromNs, toNs)` methods ready for the Web UI
- PipelineRuntime in `src/pipeline/runtime.ts` — currently has NO public getters for status/health. Task 9.0 adds the WebUIAdapter facade.

**What this phase builds:**
- Elysia HTTP server (same Bun process as pipeline) with Datastar SSE reactivity
- Dashboard: pipeline status, live metric values, trend charts, CSV export, network policy banner
- OPC-UA certificate helper page
- Config `[webui]` section, CLI wiring, ingress enforcement

**Stack (validated in spike):**
- Elysia + Kita JSX (`@elysia/html`) + Datastar RC.7 + ECharts (simple bundle)
- Spike code in `spike-web-ui/` — reference but don't copy blindly (spike code is quick-and-dirty)
- Spike findings in `plans/spike-web-ui-stack.md` — **read the "Spike Findings" and "Phase 9 Implications" sections before implementing**

## HOW THIS WORKS

1. Read `plans/phase-9-tasks.json` — find the first task with `"passes": false`
2. Read the task's `prd_refs` sections from `prd/`
3. Read the relevant spike findings from `plans/spike-web-ui-stack.md`
4. Implement the task following its steps
5. Run `bun test test/unit test/integration` — ALL tests must pass (not just new ones)
6. Update `"passes": true` in the task JSON
7. Update `plans/phase-9-progress.md` with what you built, decisions made, test counts
8. Commit: `phase-9: <what> (task 9.X)`
9. Do NOT push. Pushing is handled externally.
10. Output: TASK_COMPLETE

**One task per session. Do not start the next task.**

## KEY RULES FOR THIS PHASE

**Datastar RC.7 colon syntax is mandatory.** Use `data-on:click`, `data-signals:name`, `data-init`. NOT `data-on-click`, `data-signals-name`, `data-on-load`. The hyphen syntax silently fails — Datastar parses on `:` not `-`. Grep for `data-on-` (hyphen) to catch mistakes.

**Asset embedding.** Use `import ... with { type: 'file' }` for all static assets served to the browser. `Bun.file(import.meta.dir + '...')` breaks in compiled binaries because `import.meta.dir` becomes `/$bunfs/root/`.

**ECharts bridge.** Use `data-effect` to bridge Datastar signals to web component methods. Do NOT use `patchElements` for stateful web components — morph destroys their internal DOM (canvas, children).

**SSE format.** Events must be `datastar-patch-signals` and `datastar-patch-elements`. NOT the beta.11 names (`datastar-merge-signals`, `datastar-merge-fragments`).

**SDK import path.** Use `@starfederation/datastar-sdk/web` (returns standard Response objects). Not the default or `/node` path.

**Kita JSX produces strings.** JSX expressions evaluate to plain strings — no `renderToString()` needed. `const html = <div>hello</div>` gives `"<div>hello</div>"`.

**Guard initial signal values.** `data-signals="{val: 0}"` fires `data-effect` immediately with 0 before real SSE data arrives. Web components must guard: skip if `timestamp < 1e12`.

**ECharts config.** Set `animation: false` for live charts (prevents animation queue at 1Hz+). Set `yAxis: { min: 'dataMin', max: 'dataMax' }` to auto-scale (prevents anchoring at 0).

**Build command for compile test:** `bun build --compile --minify --asset-naming="[name].[ext]" --external=@serialport/bindings-cpp src/index.ts --outfile collatr-edge`

## PHASE-SPECIFIC NOTES

**Web UI source files go in `src/web/`.** Follow existing project structure conventions:
- `src/web/server.ts` — Elysia app creation and lifecycle
- `src/web/adapter.ts` — WebUIAdapter interface and implementation
- `src/web/routes/` — route handlers (stream.ts, export.ts, chart-data.ts, certificates.ts)
- `src/web/views/` — JSX page components (dashboard.tsx, certificates.tsx, layout.tsx)
- `src/web/views/fragments/` — JSX fragment components for SSE element patching
- `src/web/public/` — static assets (datastar.js, echarts.min.js, components/)

**Tests go in `test/unit/web/` and `test/integration/`.**

**Do NOT modify existing `src/` files unless explicitly needed** (e.g., adding state getter to PipelineRuntime, adding webui config to AgentConfig). When you do modify existing files, be surgical — don't reorganise or refactor adjacent code.

**The LocalStoreOutput.exportCSV() already exists.** It returns CSV with nanosecond timestamps. Task 9.5 needs to add formatted UTC + local timestamp columns per acceptance criteria.

**Plugin factory pattern.** Look at how existing components are created in `src/pipeline/plugin-factory.ts` before wiring the web server. Follow the established pattern.

## THREE-ATTEMPT RULE

If a test fails and you cannot fix it after 3 genuine attempts (not the same fix three times), STOP. Document:
1. What the test expects
2. What actually happens
3. What you tried
4. Your best theory for the root cause

Then output: TASK_BLOCKED — <reason>

## COMPLETION

When your single task is done and committed, output: TASK_COMPLETE

When ALL tasks in the task JSON have `"passes": true`:
1. Do NOT output PHASE_COMPLETE yet.
2. Spawn a sub-agent code review (see CLAUDE.md "Phase Work Pattern" step 4).
3. Write the review to `plans/phase-9-review.md`
4. Address all 🔴 Must Fix findings. Re-run `bun test test/unit test/integration` after each fix.
5. Commit fixes: `phase-9: address code review findings`
6. THEN output: PHASE_COMPLETE

## DO NOT

- Use React, Preact, or any SPA framework
- Fetch anything from CDNs at runtime — all assets must be embedded
- Add `git push` to any workflow — pushing is handled externally
- Run `bun test` without specifying `test/unit test/integration` (avoids E2E timeout)
- Use Datastar beta.11 event names or hyphen attribute syntax
- Use `Bun.file(import.meta.dir + ...)` for assets that need to work in compiled binaries
