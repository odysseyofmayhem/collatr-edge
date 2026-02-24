# CollatrEdge Development Workflow

## Overview

CollatrEdge uses a **multi-agent phased development workflow** with two distinct AI agents operating in a coordinated loop. The workflow was developed organically during Phases 1–5 and refined based on real lessons learned. It produces high-quality, PRD-compliant code with strong test coverage and multiple layers of review.

### The Agents

| Agent | Environment | Role |
|---|---|---|
| **Claude Code** (local) | Lee's machine, interactive + headless | Implementation. Writes code, tests, reviews. Runs the Ralph Wiggum loop. |
| **Dex** (OpenClaw) | Cloud-hosted, persistent | Architecture, planning, independent review, quality gate. Writes phase plans and PROMPT files. Spawns sub-agents for code review. |

### Key Principle: Separation of Concerns

The agent that writes the code **never** reviews its own work as the final gate. Claude Code does an internal review (sub-agent within Claude Code), then Dex does an independent review from a completely fresh context. This two-layer review consistently catches issues the implementation agent missed — including bugs that passed all tests.

---

## Phase Lifecycle

Each phase follows this lifecycle. The entire CollatrEdge MVP (Phases 0–9) is built by repeating this cycle.

```
┌─────────────────────────────────────────────────────────────┐
│                    PHASE N LIFECYCLE                         │
│                                                             │
│  1. PRD REVIEW & PLANNING          (Dex)                   │
│  2. PLAN + PROMPT CREATION         (Dex → push to git)     │
│  3. IMPLEMENTATION LOOP            (Claude Code, headless)  │
│  4. INTERNAL CODE REVIEW           (Claude Code sub-agent)  │
│  5. INTERNAL FIX PASS              (Claude Code → push)     │
│  6. INDEPENDENT REVIEW             (Dex sub-agent)          │
│  7. GO/NO-GO DECISION              (Dex)                    │
│  8. FINAL FIX PASS                 (Claude Code)            │
│  9. PHASE COMPLETE                 (both agents)            │
│                                                             │
│  ──── repeat for Phase N+1 ────                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step

### Step 1: PRD Review & Planning (Dex)

**Who:** Dex
**Input:** PRD sections for this phase, previous phase review artifacts, CLAUDE.md
**Output:** Phase plan document, task list JSON, progress file

Dex reads the relevant PRD sections, reviews the current codebase state (git log, test results, previous phase reviews), and writes a comprehensive implementation plan.

**Artifacts created:**
- `plans/phase-N-<name>.md` — Detailed plan with module breakdown, test strategy, implementation notes, edge cases, risks, and acceptance criteria. This is the specification the implementation agent follows.
- `plans/phase-N-tasks.json` — Structured task list with ordered tasks, PRD references, implementation steps, and a `passes: false` flag that gets flipped as each task completes.
- `plans/phase-N-progress.md` — Empty progress file that the implementation agent fills in as it works.

**Quality bar:** The plan must be detailed enough that the implementation agent can work through tasks one-at-a-time without needing to make architectural decisions. Ambiguity in the plan causes implementation drift.

**What makes a good plan:**
- Each task has clear PRD references and can be implemented + tested independently
- Implementation notes address known edge cases and potential pitfalls
- Dependencies between tasks are explicit (build order)
- Acceptance criteria are measurable (test counts, specific behaviours)
- Risks are identified with mitigations

---

### Step 2: PROMPT Creation (Dex)

**Who:** Dex
**Input:** Phase plan
**Output:** Updated `PROMPT_build.md` (and `PROMPT_plan.md` if planning mode is used)

Dex updates `PROMPT_build.md` — the instruction file that drives Claude Code's headless loop. This file:

- Points to the phase plan, task list, and progress file
- Provides context about what's already built (previous phases)
- Defines the single-task-per-session workflow
- Lists key rules and gotchas specific to this phase
- Includes completion signals (`TASK_COMPLETE`, `PHASE_COMPLETE`)

Both the plan and PROMPT are committed and pushed to git so Claude Code picks them up.

---

### Step 3: Implementation Loop (Claude Code)

**Who:** Claude Code (local, headless via `ralph.sh`)
**Input:** `PROMPT_build.md`, phase plan, task list, CLAUDE.md
**Output:** Implemented code + tests, committed per-task

The Ralph Wiggum Loop (`ralph.sh`) runs Claude Code headlessly in a loop:

```bash
./ralph.sh 10        # Build mode: up to 10 iterations
./ralph.sh plan      # Plan mode: gap analysis only
```

Each iteration:
1. Claude Code reads `PROMPT_build.md`
2. Finds the first task with `passes: false` in the task JSON
3. Reads the relevant PRD sections
4. Reads the detailed implementation notes in the phase plan
5. Implements the code and tests
6. Runs `bun test` — **all** tests must pass (not just new ones)
7. Updates `passes: true` in the task JSON
8. Updates the progress file with what was built and decisions made
9. Commits with format: `phase-N: <what> (task N.X)`
10. Outputs `TASK_COMPLETE` (or triggers internal review if all tasks done — see below)

**The loop auto-pushes to git after each iteration** so Dex can monitor progress.

**Key constraints enforced by PROMPT_build.md:**
- **One task per session** — prevents context bleed and keeps commits atomic
- **All tests must pass** — no partial implementations, no "fix it later"
- **Progress file must be updated** — breadcrumbs for the next iteration and for reviewers
- **3-attempt failure rule** — if a test can't be fixed after 3 genuine attempts, STOP and document. Don't hack around it.
- **Internal review is part of the loop** — when all tasks pass, the PROMPT must instruct the agent to spawn a code review sub-agent before declaring PHASE_COMPLETE. This is not optional and must not be left to manual prompting.

**Task granularity:** Each task typically produces one source file + one test file + one commit. Integration tests are separate tasks from implementation (e.g., task 2.1 = implement Modbus, task 2.1i = Modbus integration tests).

---

### Step 4: Internal Code Review (Claude Code sub-agent)

**Who:** Claude Code spawns a sub-agent for review
**Input:** All source files changed in this phase, CLAUDE.md rules, PRD
**Output:** `plans/phase-N-review.md`

After all tasks pass, Claude Code spawns a fresh-context sub-agent to review the phase. The review checks:

1. **PRD compliance** — field-by-field interface verification against spec
2. **Rules 1–13 compliance** — especially Rules 8–13 (added based on Phase 1 lessons)
3. **Error handling** — are Promises handled? Return values checked? Empty catches?
4. **Test coverage of hard paths** — are complex branches tested, not just happy paths?
5. **Lifecycle ordering** — does startup/shutdown match PRD §8?
6. **Config wiring** — are configurable values wired from config, or hardcoded?

**Review output format:**
- 🔴 **Must Fix** — blocks Phase N+1
- 🟡 **Should Fix** — should be addressed, prioritised by impact
- 🟢 **Nice to Have** — suggestions, minor improvements
- PRD compliance table per module
- Phase N+1 readiness assessment

---

### Step 5: Internal Fix Pass (Claude Code)

**Who:** Claude Code
**Input:** `plans/phase-N-review.md`
**Output:** Fix commit(s), pushed to git

Claude Code addresses all 🔴 findings and as many 🟡 findings as practical. Each fix is committed. All tests must still pass after fixes. The review may run again if fixes are substantial.

**Typical commit:** `phase-N: address code review findings (R1 + Y1-Y5)`

---

### Step 6: Independent Review (Dex sub-agent)

**Who:** Dex spawns a sub-agent with fresh context
**Input:** Full phase code (pulled from git), Claude Code's review + fixes, PRD, CLAUDE.md
**Output:** `plans/phase-N-independent-review.md` (or `phase-N-review-final.md` in earlier phases)

This is the **critical quality gate**. A completely fresh agent — with no prior involvement in implementation or the internal review — examines:

1. **Everything the internal review checked** (independent verification)
2. **Quality of the internal review itself** — was it thorough? Did it miss anything?
3. **Quality of the fix pass** — were fixes correct? Were any findings only partially addressed?
4. **Architectural concerns** — broader patterns that a single-phase reviewer might miss
5. **Phase N+1 readiness** — explicit GO/NO-GO with evidence

**Why this catches things the internal review doesn't:**
- Fresh context = no implementation bias
- Reviews the reviewer — catches incomplete fix passes (e.g., Phase 5: Y2 fix missed one file)
- Different perspective may spot different patterns
- Evaluates review quality with a letter grade (A-/B+/etc.)

**Naming convention (evolved over phases):**
- Phase 1–4: `phase-N-review-final.md` (Dex's review of Claude Code's review)
- Phase 5+: `phase-N-independent-review.md` (clearer naming)

---

### Step 7: GO/NO-GO Decision (Dex)

**Who:** Dex
**Input:** Independent review findings, test results, overall assessment
**Output:** GO decision (or list of blockers for Claude Code)

Dex reviews the independent review output, adds any observations of its own, and makes a call:

- **GO** — no 🔴 findings remain, 🟡 findings are acceptable or addressed, tests pass
- **NO-GO** — remaining 🔴 findings or critical 🟡 findings that must be resolved

The independent review and GO/NO-GO decision are committed and pushed to git.

**Typical commit:** `phase-N: independent code review — GO for Phase N+1`

---

### Step 8: Final Fix Pass (Claude Code)

**Who:** Claude Code
**Input:** Independent review findings from Dex
**Output:** Final fix commit(s)

Claude Code reviews the independent review, implements any required fixes, verifies all tests pass, and pushes. This is typically a small commit — the independent review usually finds comment-level issues and edge cases, not architectural problems (those were caught in Step 4).

**Typical commit:** `phase-N: address independent review findings (Y-NEW-1 through Y-NEW-4)`

---

### Step 9: Phase Complete

**Who:** Both agents
**Output:** Updated progress file, MEMORY.md, clean git history

At this point:
- All tasks in `phase-N-tasks.json` have `passes: true`
- All review findings are addressed or explicitly deferred with rationale
- All tests pass
- Progress file has a complete summary
- The phase plan's acceptance criteria are met

Dex updates MEMORY.md with key decisions, lessons learned, and deferred items. Then moves to Step 1 for Phase N+1.

---

## Artifacts Per Phase

Each completed phase produces these files in `plans/`:

| File | Created by | Purpose |
|---|---|---|
| `phase-N-<name>.md` | Dex | Implementation plan (spec for the phase) |
| `phase-N-tasks.json` | Dex | Structured task list with pass/fail tracking |
| `phase-N-progress.md` | Claude Code | Running log of what was built, decisions, notes |
| `phase-N-review.md` | Claude Code (sub-agent) | Internal code review |
| `phase-N-review-fix-verification.md` | Claude Code (sub-agent, optional) | Verification that fixes were applied correctly |
| `phase-N-independent-review.md` | Dex (sub-agent) | Independent review + GO/NO-GO + review quality grade |

---

## The Ralph Wiggum Loop

Named after the Anthropic pattern ("I'm in danger!"), `ralph.sh` is a bash script that drives Claude Code headlessly:

```bash
#!/bin/bash
# Usage:
#   ./ralph.sh           # Build mode, max 10 iterations
#   ./ralph.sh 20        # Build mode, max 20 iterations  
#   ./ralph.sh plan      # Plan mode, gap analysis only

# Each iteration:
# 1. Pipes PROMPT_build.md (or PROMPT_plan.md) into `claude -p`
# 2. Captures output, checks for TASK_COMPLETE / PHASE_COMPLETE
# 3. Pushes commits to git after each iteration
# 4. Loops until max iterations or PHASE_COMPLETE
```

**Two PROMPT files drive the loop:**
- `PROMPT_build.md` — Implementation mode. "Find the next failing task, implement it, test it, commit."
- `PROMPT_plan.md` — Planning mode. "Review current state, perform gap analysis, update progress. Do NOT write code."

**Why headless works:** Each iteration gets a fresh context, so there's no accumulated confusion. The task JSON provides state across iterations — the agent reads which tasks are done and picks up where the last iteration left off. The progress file provides breadcrumbs for context the JSON can't capture.

### PROMPT_build.md Template Requirements

Every `PROMPT_build.md` **must** include these sections. Missing any of these has caused real problems:

1. **Context** — What phases are complete, what exists, what this phase builds on.
2. **Task workflow** — Find first failing task → read PRD → implement → test → commit → update progress. One task per session.
3. **Rules reminder** — Key rules for this phase (not all 13, just the ones most likely to be violated).
4. **Phase-specific notes** — Gotchas, known issues, constructor patterns, etc.
5. **Completion signals:**
   - `TASK_COMPLETE` — after each task passes and is committed.
   - After all tasks pass: **trigger internal code review** (spawn sub-agent, write `phase-N-review.md`), then implement fixes, then output `PHASE_COMPLETE`.

**Critical: The review step must be in the PROMPT, not left to manual prompting.** Phase 6 missed this — the PROMPT said "if all tasks pass, output PHASE_COMPLETE" without requiring a review first. The review only happened because it was manually triggered. Future PROMPTs must include explicit instructions:

```
## COMPLETION

When your single task is done and committed, output: TASK_COMPLETE

When ALL tasks in the task JSON have "passes": true:
1. Do NOT output PHASE_COMPLETE yet.
2. Spawn a sub-agent code review (see CLAUDE.md "Phase Work Pattern" step 4).
3. Write the review to plans/phase-N-review.md
4. Address all 🔴 Must Fix findings. Re-run bun test after each fix.
5. Commit fixes: `phase-N: address code review findings`
6. Push all commits.
7. THEN output: PHASE_COMPLETE
```

---

## CLAUDE.md: The Living Rulebook

`CLAUDE.md` is the agent instruction file that both agents respect. It contains:

- **13 rules** — non-negotiable coding standards
- **Phase Work Pattern** — how phases are structured
- **Technical standards** — TypeScript conventions, Bun specifics, dependency policy
- **Lessons from Phase 1** — real bugs caught in review, with the rules they inspired

**Key: rules evolve based on real failures.** Rules 8–9 were added after Phase 1's review found PRD interface drift and untested branches. Rules 10–13 were added after Phase 1's final review found hardcoded config overrides, fire-and-forget Promises, lifecycle ordering bugs, and global-vs-per-instance confusion. Each rule exists because of a real bug.

---

## Lessons Learned (Phases 1–5)

### What works well

1. **One task per session** prevents context bleed. The agent stays focused and commits are atomic.
2. **Separate implementation and integration test tasks** (e.g., 2.1 and 2.1i) forces the agent to verify cross-module behaviour, not just unit correctness.
3. **Independent review consistently finds things internal review missed.** Phase 1: clock jump bug copied from PRD pseudocode. Phase 3: bun:sqlite supports BigInt natively (TEXT storage was unnecessary). Phase 5: incomplete fix pass (missed one file).
4. **Progress files bridge context windows.** When iteration 4 picks up from iteration 3, the progress file tells it what was built and what to watch out for.
5. **The 3-attempt failure rule** prevents infinite loops. If the agent can't fix a test in 3 tries, it stops and documents — humans can debug faster than an agent going in circles.
6. **Review quality grading** (A-/B+/etc.) creates accountability. The independent reviewer evaluates whether the internal review was thorough, not just whether the code is correct.

### What was improved after real failures

1. **Rules 10–13 added to CLAUDE.md** after Phase 1 review found 4 distinct categories of bugs that tests didn't catch. The rules now prevent these patterns.
2. **Mandatory sub-agent review** added to the Phase Work Pattern after Phase 1 proved that self-review doesn't work — the implementation agent has blind spots.
3. **Fix verification step** added after finding that review fixes were sometimes incomplete or introduced new issues.
4. **Independent review naming** changed from `phase-N-review-final.md` to `phase-N-independent-review.md` for clarity — the "final" was confusing because it suggested it was the last review, not that it was from an independent reviewer.
5. **Phase plan quality improved** over time — early plans were thinner, later plans (Phase 5, 6) include specific implementation notes, edge case guidance, and "what this does NOT do" sections.
6. **Internal review must be in the PROMPT** — Phase 6's PROMPT_build.md said "output PHASE_COMPLETE" without requiring a code review first. The review only happened because it was manually triggered. The PROMPT now explicitly includes the review-and-fix cycle before PHASE_COMPLETE.

### What to watch for

1. **Plugin constructor patterns vary.** Each plugin was implemented independently and may accept config differently. The plugin factory (Phase 6) must handle this — check each constructor before designing the factory.
2. **Deferred items accumulate.** Track them in MEMORY.md and progress files. As of Phase 5: S&F buffer → runtime integration, gather cancellation (AbortSignal), metric_buffer_limit enforcement, Sparkplug B payload decoding, StatsCollector wiring, 45 rework risks from PRD reviews.
3. **Soak tests dominate CI time.** Phase 5's 60-second tests take the suite from ~15s to ~154s. Be mindful of adding more long-running tests.

---

## Quick Reference: Starting a New Phase

For **Dex** (planning a new phase):
1. Pull latest from git
2. Run tests to confirm green baseline
3. Read PRD sections for the phase (§21 has the phase list)
4. Review previous phase's independent review for carried-forward items
5. Write `plans/phase-N-<name>.md`, `plans/phase-N-tasks.json`, `plans/phase-N-progress.md`
6. Update `PROMPT_build.md` for the new phase
7. Commit and push

For **Lee** (running the local agent):
1. Pull latest (picks up Dex's plan + PROMPT)
2. Run `./ralph.sh 10` (or interactive: `claude` then "Read PROMPT_build.md and follow its instructions")
3. Monitor progress: `git log --oneline` or check `plans/phase-N-progress.md`
4. When PHASE_COMPLETE: push to git, tell Dex to review

For **Dex** (reviewing a completed phase):
1. Pull latest
2. Run tests to confirm green
3. Spawn sub-agent for independent review
4. Review findings, add own observations
5. Make GO/NO-GO decision
6. Commit review + push
7. If fixes needed: tell Lee → Claude Code fixes → re-verify

---

## Stats (as of Phase 5 completion)

| Metric | Value |
|---|---|
| Phases complete | 5 (of 9 planned) |
| Total commits | 68 |
| Total tests | 445 pass, 0 fail |
| Total assertions | 4,237 |
| Test files | 41 |
| Source files | 22 |
| CLAUDE.md rules | 13 |
| Review artifacts | 15 files across 5 phases |
| Bugs caught by independent review | 6 red, ~50 yellow |
