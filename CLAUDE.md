# CLAUDE.md — CollatrEdge Agent Instructions

> This file is the single source of truth for AI agents (Claude Code, OpenAI Codex, OpenClaw sub-agents) working on CollatrEdge. It is symlinked as AGENTS.md.

---

## What This Project Is

CollatrEdge is an IIoT data collection agent for UK SME manufacturers. It collects data from industrial protocols (OPC-UA, Modbus TCP, MQTT), processes it through a pipeline, and stores/forwards it. Think Telegraf, but built for manufacturing with standalone-first design.

**Runtime:** Bun 1.3.9+ (TypeScript, compiled to single binary)
**Architecture:** Four-stage pipeline (Inputs → Processors → Aggregators → Outputs) connected by async channels
**Target hardware:** Raspberry Pi 4, industrial gateways, commodity x64 servers

---

## Before You Write Any Code

### 1. Read the PRD

The PRD is in `prd/`. It is comprehensive (22 sections + 4 appendices + spike results). **Read the relevant sections before implementing anything.** The PRD contains exact TypeScript interfaces, schema definitions, config formats, and behaviour specifications. Don't guess — look it up.

Key files you'll reference constantly:
- `prd/README.md` — table of contents
- `prd/04-architecture-overview.md` — pipeline, channels, concurrency
- `prd/appendix-b-metric-interface.md` — all TypeScript interfaces
- `prd/21-mvp-build-sequence.md` — phased build plan
- `prd/22-mvp-acceptance-criteria.md` — definition of "done"
- `prd/spike-results-bun-runtime.md` — validated runtime capabilities and build commands

### 2. Check the Phase Plan

Work is organised into phases (0–9). Each phase has a plan document in `plans/` once created. **Never start a phase without a plan. Never start implementing without reading the plan.**

```
plans/
  phase-1-core.md          # Created before Phase 1 work begins
  phase-1-core-status.md   # Updated as work progresses
  phase-2-inputs.md
  ...
```

### 3. Check Current Status

Before doing anything, understand where we are:
- `git log --oneline -20` — what's been done recently
- `plans/phase-N-status.md` — current phase progress
- Run existing tests: `bun test` — everything must pass before you start

---

## The Rules

These are non-negotiable. Every agent working on this project must follow them.

### Rule 1: No Hand-Waving

**Never dismiss a test failure.** Never write "tests failed due to timing issues... moving on." Never say "this is probably fine." Never skip a failing test to make progress.

If a test fails:
1. **Understand why.** Read the error. Read the code. Trace the logic.
2. **Fix the root cause.** Not a retry loop. Not a sleep. Not a "skip if flaky" annotation.
3. **If you genuinely cannot fix it**, document exactly what's happening, what you tried, and why it's blocked. Then stop and ask for help.

If you find yourself writing `setTimeout` to "fix" a test, you have a design problem. Find it.

### Rule 2: Tests Prove Behaviour, Not Coverage

Every module needs tests. But we don't want test theatre — 100% coverage of trivial getters while core data flow is untested.

**Test priority order:**
1. **Data correctness** — does the right data come out? Types, values, ordering.
2. **Failure modes** — what happens when things break? Network loss, invalid input, full buffers.
3. **Contracts** — does this module honour its interface? Can other modules depend on it?
4. **Edge cases** — boundaries, empty inputs, maximum sizes, unicode, concurrent access.
5. **Performance** — only where the PRD specifies thresholds (e.g., "≤1 second data loss").

Write tests that would catch real bugs. If a test wouldn't catch any bug that matters, don't write it.

### Rule 3: Small, Verified Steps

**The Ralph Wiggum Loop:**
```
1. Plan what you're building (read PRD, write implementation plan)
2. Build the smallest testable unit
3. Write tests for it
4. Run the tests
5. ALL PASS? → commit, move to next unit
6. ANY FAIL? → fix the code (not the test), go to step 4
7. Unit complete? → integration test with previously built units
8. Integration passes? → commit, next unit. Fails? → step 6.
```

**Never skip step 4.** Never commit with failing tests. Never move to the next unit with broken tests behind you.

The loop is fractal — it applies at every level:
- Function level: write function → test → verify
- Module level: write module → test → verify → integrate
- Phase level: complete phase → integration tests → verify → next phase

### Rule 4: One Thing at a Time

Don't implement three modules in parallel then try to debug them all at once. Build one module, test it, verify it works, commit it, then move on.

If you're a sub-agent working on a specific module, stay in your lane. Don't "helpfully" refactor adjacent modules.

### Rule 5: The PRD Is the Spec

If the PRD says something, that's what we build. If you think the PRD is wrong, raise it — don't silently deviate.

**Prose trumps pseudocode.** The PRD contains both prose descriptions and TypeScript pseudocode. If they contradict each other, the **prose is authoritative** — pseudocode is illustrative. When you spot a contradiction: (1) flag it explicitly in a code comment, (2) implement what the prose says, (3) mention the discrepancy in your status update so the PRD can be corrected. Never silently pick whichever version is easier to implement.

If the PRD is ambiguous on something, check these in order:
1. Other PRD sections (cross-reference — the answer is often in another section)
2. `prd/spike-results-bun-runtime.md` (runtime capabilities and limitations)
3. The existing codebase (prior art, established patterns)
4. Ask (don't guess)

### Rule 6: Commit Discipline

- **Commit after each verified unit** (tests pass, module works)
- **Commit messages describe what and why**, not "WIP" or "fixes"
- **Never commit commented-out code**, TODOs without ticket references, or dead code
- **Format:** `<phase>: <what> — <why if not obvious>`
  - Example: `phase-1: implement Channel<T> with drop-oldest overflow`
  - Example: `phase-2: add Modbus byte order decoding — ABCD/CDAB/BADC/DCBA`

### Rule 7: No Premature Abstraction

Build what the PRD specifies. Don't add extension points, plugin hooks, or abstractions "for the future" unless the PRD explicitly calls for them. You aren't gonna need it.

The PRD already has the right abstractions. Trust it.

### Rule 8: Interface Compliance Check

When implementing a TypeScript interface defined in the PRD, **diff your implementation against the PRD definition field-by-field** before committing. Check:

1. **Every field/property present** — don't silently drop fields even if the current phase doesn't use them. If a field is present in the PRD interface but not needed yet, include it with a `// TODO: Phase N` comment, or throw "not implemented" if it's a method.
2. **Default values match** — if the PRD says "default: X", your code must default to X. Search your code for `?? ` and `|| ` and verify each default against the PRD.
3. **Option types match** — if the PRD interface has `overflow: 'drop-oldest' | 'block'`, your options type must include that field. Accepting and validating the option is separate from implementing all variants — you can throw on unimplemented variants, but the type must exist.

This prevents "interface drift" where the implementation quietly diverges from the spec. Downstream modules will be coded against the PRD interfaces and will break if the real interfaces don't match.

### Rule 9: Test the Hard Paths First

There's a natural tendency to write thorough tests for happy paths and skip the complex edge-case branches. **Invert this.** The most important tests are for:

1. **Error recovery paths** — clock jump detection, reconnection logic, corruption handling
2. **Branching conditions** — every `if` that handles a non-obvious case needs a test proving it triggers correctly and does the right thing
3. **Configurable behaviours** — if an option exists (`aligned`, `offset`, `jitter`, `overflow`), every supported value must have at least one test exercising it

**The rule:** If a code path exists but has no test, it's not implemented — it's a guess. Untested error-recovery code is worse than no error-recovery code, because it gives false confidence.

Before committing a module, scan it for branches and ask: "Which of these branches has zero test coverage?" Then write those tests first.

### Rule 10: No Hardcoded Config Overrides

**Never hardcode a value that should come from config.** If the PRD defines a configurable option with a default, your code must respect both the config value AND the default. Examples of violations:

- Passing `{ aligned: false }` to a function when the config or PRD says the default is `true`
- Using a literal number where `config.batchSize` should be read
- Ignoring a parsed config field and using a constant instead

**Before committing,** search for literals (numbers, booleans, strings) passed to functions that accept options objects. Ask: "Should this be coming from config?"

### Rule 11: Handle Return Values and Errors in Async Code

In async code, **every Promise and every return value that signals success/failure must be handled:**

1. **`send()` / `write()` return values** — if a function returns `boolean` or `Promise<boolean>` to indicate success, **check it**. Fire-and-forgetting a `Promise<boolean>` hides data loss.
2. **`async` functions in loops** — wrap in `try/catch`. An unhandled rejection in a flush loop or gather loop crashes the pipeline silently.
3. **`Promise.race()` doesn't cancel losers** — if you race a timeout against an async operation, the loser keeps running. Document this with a TODO when cancellation isn't feasible yet.

**The test:** After writing an async function, ask: "What happens if every `await` in this function throws?" If the answer is "the pipeline crashes with no logging," add error handling.

### Rule 12: Lifecycle Ordering Matches the PRD

The PRD §8 defines a specific startup and shutdown sequence. **Follow it exactly.** Common mistakes:

- Connecting outputs inside their flush loop (lazy) instead of during startup (fail-fast)
- Starting data collection before outputs are ready
- Not draining channels before closing outputs during shutdown

If you're writing lifecycle code (`start()`, `stop()`, `connect()`, `close()`), **read PRD §8 and verify your ordering matches step-by-step.**

### Rule 13: Per-Instance, Not Global

When the PRD defines a per-plugin or per-instance option, **implement it per-instance.** Don't collapse multiple instances into a single global flag. Examples:

- `drop_original` is per-aggregator, not a global "any aggregator wants to drop" flag
- Intervals can be per-input, not just global
- Timeouts can be per-output, not just global

If you're tempted to write `plugins.some(p => p.option)` to compute a global flag, stop and ask whether the PRD intends per-instance semantics.

---

## Technical Standards

### Project Structure

```
collatr-edge/
├── prd/                    # Product requirements (read-only reference)
├── plans/                  # Phase plans and status
├── src/
│   ├── core/               # Channel, Broadcaster, Ticker, Metric, config parser
│   ├── plugins/
│   │   ├── inputs/         # OPC-UA, Modbus TCP, MQTT, internal
│   │   ├── processors/     # rename, filter
│   │   ├── aggregators/    # basicstats
│   │   └── outputs/        # local-store, file, stdout, sparkplug-b
│   ├── pipeline/           # Pipeline runtime, plugin lifecycle
│   ├── buffer/             # Store-and-forward buffer manager
│   ├── cli/                # CLI commands (run, config init, config validate, version)
│   ├── web/                # Web UI server
│   └── index.ts            # Entry point
├── test/
│   ├── unit/               # Per-module unit tests (mirror src/ structure)
│   ├── integration/        # Cross-module integration tests
│   └── e2e/                # End-to-end pipeline tests
├── CLAUDE.md               # This file
├── AGENTS.md               # Symlink → CLAUDE.md
├── package.json
├── tsconfig.json
├── bunfig.toml             # Bun configuration
└── README.md
```

### TypeScript Conventions

- **Strict mode.** `"strict": true` in tsconfig. No `any` except in test fixtures where typing adds no value.
- **No enums.** Use `as const` objects or union types. Enums are a TypeScript footgun.
- **Explicit return types** on exported functions. Inferred types on internal/private functions are fine.
- **Error handling:** Never swallow errors. Catch → log → re-throw or handle. No empty catch blocks.
- **Async:** Use `async/await`. No raw Promise chains. No callback-style APIs in new code.

### Bun-Specific

- **SQLite:** Use `bun:sqlite` (built-in). Not `better-sqlite3`.
- **Testing:** Use `bun:test`. Not Jest, not Vitest.
- **HTTP server:** Use `Bun.serve()`. Not Express, not Fastify.
- **Build:** `bun build --compile --minify --sourcemap --external=@serialport/bindings-cpp`
- **ARM64:** Add `--target=bun-linux-arm64` for Pi builds
- **Import syntax:** Use ESM imports. No `require()`.
- **Compile from project root.** Not from /tmp or subdirectories (known Bun issue with output paths).

### Dependencies

Only use validated dependencies. These are confirmed working with Bun compilation:

| Package | Purpose | Notes |
|---------|---------|-------|
| `bun:sqlite` | SQLite (all 6 roles) | Built-in, no install needed |
| `bun:test` | Testing | Built-in, no install needed |
| `node-opcua` | OPC-UA client | Pure JS in v4.x, no native addons |
| `modbus-serial` | Modbus TCP client | Exclude `@serialport/bindings-cpp` at compile time |
| `msgpackr` | MessagePack encoding | For SQLite field storage |

**Adding a new dependency requires justification.** Check if Bun has a built-in alternative first. If you must add one, verify it works in `bun build --compile` before using it.

---

## Phase Work Pattern

When starting a new phase:

### 1. Create the Plan

Read the relevant PRD sections. Write `plans/phase-N-<name>.md` containing:
- **Goal:** What this phase delivers (copy from PRD §21)
- **PRD References:** Which sections define the spec
- **Modules:** Ordered list of modules to build, with dependencies
- **Test Strategy:** What tests prove each module works
- **Integration Points:** How this phase connects to previous phases
- **Risks:** What might go wrong, how to detect it early
- **Acceptance Criteria:** How we know the phase is complete

### 2. Execute Module by Module

For each module in the plan:
1. Read the PRD sections for this module
2. Write the implementation (types first, then logic)
3. **Interface compliance check** (Rule 8) — diff every exported type/interface against the PRD definition
4. **Branch coverage audit** — list every `if`/`switch`/`??` branch in the module. Mark which are tested. Write tests for the untested ones, *especially* error/recovery paths (Rule 9)
5. Write unit tests (prioritise hard paths per Rule 9)
6. Run tests — all must pass
7. Commit
8. Integration test with prior modules
9. Commit

### 3. Phase Completion

When all modules pass:
1. Run full test suite (`bun test`)
2. Run integration tests for this phase
3. Update `plans/phase-N-status.md` with final status
4. Update README.md if public API changed
5. Commit with message: `phase-N: complete — <summary>`

### 4. Code Review (Sub-Agent)

**Every phase gets a code review before it's considered done.** This is not optional. The Phase 1 reviews caught a wrong algorithm, a silent config override, missing error handling, and a lifecycle ordering bug — all in code that passed its tests.

**How to request the review:**

If you are a human using Claude Code interactively, ask Dex (OpenClaw) to run the review. If you are Dex, spawn a sub-agent. The review must be done by a **separate context** — not the agent that wrote the code. Fresh eyes catch what the author's eyes skip.

**Review prompt for the sub-agent:**

> You are reviewing Phase N of CollatrEdge. Read `CLAUDE.md` for project rules. Read the PRD sections listed in `plans/phase-N-<name>.md`. Then review every source file and test file changed or created in this phase.
>
> For each file, check:
> 1. **PRD compliance** — does the implementation match the spec? Field-by-field interface check.
> 2. **Rules 1–13 compliance** — any violations? (especially Rules 8–13)
> 3. **Error handling** — what happens when things fail? Are Promises handled? Are return values checked?
> 4. **Test coverage of hard paths** — are the complex branches tested, or just the happy path?
> 5. **Lifecycle ordering** — does startup/shutdown match PRD §8?
> 6. **Config wiring** — are configurable values actually wired from config, or hardcoded?
>
> Output format: `plans/phase-N-review-final.md` with 🔴 Must Fix, 🟡 Should Fix, 🟢 Nice to Have findings. Include a PRD compliance table per module and a Phase N+1 readiness assessment.

**Review output:** `plans/phase-N-review-final.md`

The review is **not a gate** — it doesn't block all progress. But its 🔴 findings must be fixed before the next phase starts (see step 5).

### 5. Pre-Next-Phase Fix Pass

Before starting Phase N+1, check `plans/phase-N-review-final.md` for:
- **🔴 Must Fix** — resolve these before ANY new work
- **🟡 Should Fix (Priority 1)** — resolve these before building on top of the affected module
- **🟡 Should Fix (Priority 2)** — can fix during Phase N+1 when the context arises

This prevents technical debt from compounding. Phase 2 outputs will break if Phase 1 runtime issues (error handling, lifecycle ordering, global flags) aren't addressed first.

---

## Lessons from Phase 1

These patterns were caught in code review. Don't repeat them.

1. **PRD pseudocode had the same bug as the implementation.** The clock jump detection pseudocode compared the wrong clocks — and the implementation faithfully copied the pseudocode bug. **Rule 5 exists for this reason:** prose trumps pseudocode. When implementing from pseudocode, cross-check against the prose description.

2. **A fix in one module was undone by a hardcode in another.** The Ticker default was corrected to `aligned: true`, but the PipelineRuntime hardcoded `{ aligned: false }` when calling the Ticker — silently reverting the fix. **Rule 10 exists for this reason.** After fixing a default, grep for call sites that override it.

3. **`send()` return values were silently discarded.** The Accumulator called `channel.send(metric)` without checking the `boolean` return. On a closed channel during shutdown, metrics vanish with no trace. **Rule 11 exists for this reason.**

4. **The output connection happened in the wrong lifecycle phase.** `output.connect()` was called inside the flush loop instead of during `start()`, so a connection failure wouldn't be detected until shutdown. **Rule 12 exists for this reason.**

5. **`drop_original` was collapsed into a global flag across all aggregators.** One aggregator's `drop_original = true` would suppress originals for ALL aggregators. **Rule 13 exists for this reason.**

6. **Tests covered happy paths thoroughly but skipped the complex branches.** Clock jump detection, aligned mode, offset — the most interesting ticker logic — had zero test coverage initially. Rule 9 was added to counter this, and the fix pass added the missing tests.

---

## When You're Stuck

1. **Re-read the PRD section.** The answer is usually there.
2. **Read the test output carefully.** The error message matters. The stack trace matters.
3. **Simplify.** Can you reproduce the failure with fewer moving parts?
4. **Check Bun docs.** Some Node.js patterns don't translate 1:1.
5. **Check spike results.** `prd/spike-results-bun-runtime.md` documents known quirks.
6. **Ask.** Don't spend 30 minutes guessing when a 30-second question gets the answer.

---

## Sub-Agent Instructions

If you are a sub-agent (spawned to work on a specific module or task):

1. **Read this file first.** All rules apply to you.
2. **Read the relevant PRD sections** for your assigned work.
3. **Read the phase plan** in `plans/`.
4. **Stay in scope.** Do your assigned task. Don't refactor other modules.
5. **Run tests before reporting completion.** All tests must pass — not just yours.
6. **Report clearly:** What you built, what tests you wrote, what passes, what doesn't.
7. **Never report success if tests fail.** A partial implementation with honest status is worth more than a "complete" implementation with hidden failures.

---

## Quick Reference

### Commands
```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test test/unit/      # Run unit tests only
bun test --watch         # Watch mode
bun run src/index.ts     # Run in development
bun build --compile --minify --sourcemap --external=@serialport/bindings-cpp --outfile collatr-edge src/index.ts  # Production build
```

### Key Interfaces (from PRD Appendix B)
```typescript
// The core data type flowing through the pipeline
interface Metric {
  name: string;
  tags: Map<string, string>;
  fields: Map<string, FieldValue>;
  timestamp: bigint;
}

// What inputs use to emit metrics
interface Accumulator {
  addFields(measurement: string, fields: Record<string, FieldValue>, tags?: Record<string, string>): void;
  addMetric(metric: Metric): void;
  addError(error: Error): void;
}

// The four plugin types
interface Input { gather(acc: Accumulator): Promise<void>; }
interface ServiceInput extends Input { start(acc: Accumulator): Promise<void>; stop(): Promise<void>; }
interface Processor { process(metric: Metric, acc: Accumulator): Promise<void>; }
interface Aggregator { add(metric: Metric): void; push(acc: Accumulator): void; reset(): void; }
interface Output { connect(): Promise<void>; write(batch: Metric[]): Promise<void>; close(): Promise<void>; }
```

### Build Targets
```bash
# x64 Linux
bun build --compile --minify --sourcemap --external=@serialport/bindings-cpp --outfile collatr-edge src/index.ts

# ARM64 Linux (Raspberry Pi 4+)
bun build --compile --minify --sourcemap --target=bun-linux-arm64 --external=@serialport/bindings-cpp --outfile collatr-edge-arm64 src/index.ts
```
