Read CLAUDE.md for project rules and conventions.
Read prd/README.md for the PRD table of contents.

You are in PLANNING mode. Do NOT write implementation code. Do NOT make commits.

## TASK

Review the current state of the project:
1. Read plans/phase-1-tasks.json — check which tasks have passes: true
2. Read plans/phase-1-progress.md — check for blockers or notes
3. Run `bun test` if tests exist — check current test status
4. Review git log for recent work

Then perform a gap analysis:
- Compare what's been built (code + tests) against plans/phase-1-core.md
- Identify any gaps, risks, or issues
- Check if the task ordering still makes sense given what's been learned

Output an updated assessment to plans/phase-1-progress.md:
- Current status of each module
- Any blockers or risks discovered
- Recommended next actions
- Any suggested changes to task ordering or scope

Do NOT implement code. Do NOT modify source files. Only update plans/.

When done, output: PLAN_COMPLETE
