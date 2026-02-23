# Phase 4 Review: Processors & Aggregators

**Reviewer:** Quality Engineer (fresh context, separate from authoring agent)
**Date:** 2026-02-23
**Phase:** 4 — Processors & Aggregators
**Test baseline:** 423 pass, 0 fail (verified before review)
**Commit under review:** HEAD on main

---

## Review Scope

**Source files reviewed:**
- `src/core/metric-filter.ts`
- `src/plugins/processors/rename.ts`
- `src/plugins/processors/filter.ts`
- `src/plugins/aggregators/basicstats.ts`

**Test files reviewed:**
- `test/unit/core/metric-filter.test.ts` (33 tests)
- `test/unit/plugins/processors/rename.test.ts` (15 tests)
- `test/unit/plugins/processors/filter.test.ts` (7 tests)
- `test/unit/plugins/aggregators/basicstats.test.ts` (17 tests)
- `test/integration/metric-filter-pipeline.test.ts` (3 tests)
- `test/integration/rename-pipeline.test.ts` (3 tests)
- `test/integration/filter-pipeline.test.ts` (3 tests)
- `test/integration/basicstats-pipeline.test.ts` (4 tests)

**PRD sections referenced:**
- §6 Plugin System (interfaces, accumulator contract, processor/aggregator semantics)
- §7 Configuration (filtering, per-plugin overrides, config structure)
- §8 Pipeline Lifecycle (startup/shutdown ordering)
- §19 MVP Plugin Inventory (rename, filter, basicstats specs)
- Appendix A Full Config Example
- Appendix B Metric Interface

---

## Findings

### 🔴 Must Fix

#### R1: MetricFilter mutates metric field Map during `keys()` iteration

**File:** `src/core/metric-filter.ts`, lines 162-179

**Issue:** Both `fieldpass` and `fielddrop` call `metric.removeField(fieldKey)` inside a `for (const fieldKey of metric.fields.keys())` loop. This deletes Map entries while iterating over the Map's key iterator.

**Risk assessment:** In the current V8/JavaScriptCore engines used by Bun, this happens to work correctly — the ECMAScript spec defines that Map iterators visit entries in insertion order, and entries deleted during iteration are still visited if they haven't been reached yet. However:

1. This relies on engine-specific behavior that could confuse future developers.
2. The behavior is non-obvious and fragile — adding any `metric.addField()` call inside the loop in the future would introduce unpredictable iteration order for the newly-added key.

**Fix:** Collect keys to remove into an array first, then remove them in a separate pass:

```typescript
// fieldpass — collect non-matching keys, then remove
if (this.fieldpassRe !== null) {
  const toRemove: string[] = [];
  for (const fieldKey of metric.fields.keys()) {
    if (!this.fieldpassRe.some((re) => re.test(fieldKey))) {
      toRemove.push(fieldKey);
    }
  }
  for (const key of toRemove) {
    metric.removeField(key);
  }
  if (metric.fields.size === 0) return null;
}
```

**Severity reasoning:** Upgraded to 🔴 because this is a correctness concern in a core framework class that every plugin uses. While the current behavior is technically correct per spec, the pattern is a known footgun and violates the project's defensive coding standards. The fix is trivial and zero-risk.

---

#### R2: Rename processor config missing validation for rules with neither `field` nor `tag`

**File:** `src/plugins/processors/rename.ts`, lines 16-20

**Issue:** The `RenameRuleSchema` allows a rule with `dest` but no `field` and no `tag`:

```typescript
const RenameRuleSchema = z.object({
  field: z.string().optional(),
  tag: z.string().optional(),
  dest: z.string(),
});
```

A config like `{ replace: [{ dest: "foo" }] }` would parse successfully but produce a no-op rule that silently does nothing. This violates the principle of failing fast on invalid config (PRD §7). The user probably made a typo.

**Fix:** Add a `.refine()` to require at least one of `field` or `tag`:

```typescript
const RenameRuleSchema = z.object({
  field: z.string().optional(),
  tag: z.string().optional(),
  dest: z.string(),
}).refine(
  (rule) => rule.field !== undefined || rule.tag !== undefined,
  { message: "Rename rule must specify either 'field' or 'tag' (or both)" },
);
```

**Severity reasoning:** A rule with neither `field` nor `tag` is always a config error. Silent no-ops hide misconfiguration from the user, which directly contradicts Rule 1 ("never dismiss a failure") and PRD §7 validation requirements ("fail fast").

---

### 🟡 Should Fix

#### R3: Stale/misleading `drop_original` comment in runtime.ts

**File:** `src/pipeline/runtime.ts`, lines 149-155

**Issue:** The LIMITATION comment states: "If ANY aggregator has dropOriginal=true, ALL originals are suppressed." But the code now uses `.every()` (fixed in Phase 1 review), which only drops if ALL aggregators want to drop. The comment describes the old `.some()` behavior, not the current `.every()` behavior.

**Impact:** The misleading comment could cause a future developer to "fix" the code back to `.some()`, thinking the comment describes the intended behavior. This is exactly the kind of documentation drift that leads to regressions.

**Fix:** Update the comment to accurately describe the current behavior:

```typescript
// drop_original semantics: originals are suppressed only when EVERY aggregator
// has dropOriginal=true. If any aggregator wants originals, they flow.
// This is a global all-or-nothing decision rather than per-aggregator routing.
// Full per-aggregator routing (where each aggregator independently controls
// whether its downstream sees originals) is deferred to Phase 2.
```

---

#### R4: BasicstatsAggregator's `period` config stored as string but never parsed or validated

**File:** `src/plugins/aggregators/basicstats.ts`, line 23

**Issue:** `BasicstatsConfigSchema` defines `period: z.string().default("60s")` but the aggregator never parses this string into a millisecond value. The pipeline runtime receives the period as a separate numeric `period` parameter in `PipelineOptions.aggregators[].period`. This creates two concerns:

1. The aggregator's own `period` config is dead code — it's never read after construction.
2. No validation that the period string is a valid duration (e.g., `"invalid"` would pass schema validation).

**Impact:** Low for Phase 4 (the config layer doesn't exist yet), but when the config parser is built, it needs to know that the plugin's `period` field is the source of truth and must be parsed to milliseconds before being passed to PipelineOptions. If the config parser reads `period` from the aggregator config and parses it, this is fine. But the current state means there's no validation at the plugin level.

**Recommendation:** Either (a) add a `parseDuration()` call in the constructor that validates the period string and stores the millisecond value, or (b) add a comment documenting that the config layer is responsible for parsing `period` strings before passing numeric values to PipelineOptions. Option (b) is simpler and appropriate for the current phase.

---

#### R5: Per-plugin filtering not available on rename/filter processors via their config schemas

**File:** `src/plugins/processors/rename.ts`, `src/plugins/processors/filter.ts`

**Issue:** PRD §7 states: "Filtering (on every plugin) — tag and field filtering on any plugin." The rename processor's `RenameConfigSchema` does not include namepass/namedrop/tagpass/tagdrop/fieldpass/fielddrop fields. The filter processor reuses `MetricFilterSchema` as its config (which has these fields), but only for its own filtering purpose, not as "per-plugin" filtering on the processor itself.

The PRD shows these fields on `[[inputs.modbus]]`, suggesting every plugin instance should support them. The basicstats aggregator correctly includes namepass/namedrop/tagpass/tagdrop.

**Impact:** When the config layer integrates per-plugin filtering, it will likely apply filters at the runtime level (wrapping the plugin) rather than inside each plugin's schema. This is an architectural decision — if filtering is handled at the runtime layer, plugins don't need these fields. But if filtering is expected in plugin configs, the rename processor schema is incomplete.

**Recommendation:** Add a comment in both processor files indicating that per-plugin filtering will be handled at the runtime config layer (not embedded in individual plugin schemas), OR extend the schemas to include `MetricFilterSchema` fields for consistency. The former approach is architecturally cleaner.

---

#### R6: Rename processor does not validate `field` + `tag` on same rule (both-set behavior)

**File:** `src/plugins/processors/rename.ts`, lines 40-56

**Issue:** A rename rule can have both `field` and `tag` set (e.g., `{ field: "temperature", tag: "host", dest: "renamed" }`). The code applies both renames using the same `dest` name, which would rename the field to `renamed` AND the tag to `renamed`. While this works, it's almost certainly not what the user intended (field and tag namespaces are separate, so both being named `renamed` is confusing but technically valid).

The PRD config example (Appendix A) shows rules with either `field` OR `tag`, never both. The Telegraf rename processor similarly treats these as separate operations.

**Recommendation:** Either (a) reject rules with both `field` and `tag` via `.refine()`, or (b) document that both can be set to rename a field and tag simultaneously using the same dest name. Option (a) prevents likely config errors.

---

#### R7: No test for `fieldpass` + `fielddrop` combined on same metric

**File:** `test/unit/core/metric-filter.test.ts`

**Issue:** The tests cover `fieldpass` and `fielddrop` independently, but no test exercises both applied to the same metric. The evaluation order test (line 392) includes `fieldpass` but not `fielddrop`. If a metric matches both `fieldpass` and `fielddrop`, the behavior should be: fieldpass keeps matching fields, then fielddrop removes matching fields from the surviving set. This interaction is untested.

**Recommendation:** Add a test:
```typescript
it("fieldpass + fielddrop: fieldpass keeps, then fielddrop removes from survivors", () => {
  const filter = makeFilter({
    fieldpass: ["temp_*", "quality"],
    fielddrop: ["temp_debug"],
  });
  const metric = makeMetric({
    fields: { temp_motor: 23.5, temp_debug: 0, quality: 1, count: 42 },
  });
  const result = filter.apply(metric);
  expect(result).not.toBeNull();
  expect(result!.fields.size).toBe(2); // temp_motor + quality
  expect(result!.hasField("temp_motor")).toBe(true);
  expect(result!.hasField("quality")).toBe(true);
  expect(result!.hasField("temp_debug")).toBe(false); // removed by fielddrop
  expect(result!.hasField("count")).toBe(false);       // removed by fieldpass
});
```

---

#### R8: BasicstatsAggregator filter applies `apply()` to metrics passed by runtime copy, potentially mutating fields

**File:** `src/plugins/aggregators/basicstats.ts`, lines 121-126

**Issue:** When per-plugin filtering is configured (namepass/namedrop/tagpass/tagdrop), the aggregator calls `this.filter.apply(metric)`. The `MetricFilter.apply()` method can mutate the metric's fields Map (via fieldpass/fielddrop). However, the `BasicstatsConfigSchema` only includes namepass/namedrop/tagpass/tagdrop — not fieldpass/fielddrop — so field mutation cannot actually occur through the aggregator's own filter.

But there's a subtle issue: the runtime calls `plugin.add(processed.copy())` (line 175 of runtime.ts), passing a COPY of the metric. So even if field mutation happened, it wouldn't affect downstream processing. The current code is safe.

However, if someone adds `fieldpass`/`fielddrop` to the aggregator schema in the future, the `apply()` call would mutate the copy's fields before aggregation. Since the aggregator iterates all fields for accumulation, field filtering before accumulation would silently change which fields get aggregated — which could be intentional or a bug depending on context.

**Recommendation:** Add a comment documenting that the filter is intentionally limited to name/tag filters (not field filters) for aggregators, and why.

---

### 🟢 Nice to Have

#### R9: Processor `order` field not present in config schemas

**Files:** `src/plugins/processors/rename.ts`, `src/plugins/processors/filter.ts`

**Observation:** PRD §7 and Appendix A show `order = 1` on `[[processors.rename]]`. Neither processor schema includes an `order` field. This is likely handled at the runtime/config layer (the processor chain ordering is determined by config parsing, not by individual plugins), which is the correct approach. However, the schemas don't reject unknown fields, so when TOML config with `order` is parsed and passed to the schema, the `order` field would be silently stripped by Zod parsing.

**Recommendation:** No action needed now. When the config layer is built, ensure `order` is extracted before the remaining config is passed to the plugin schema. Optionally, use `.passthrough()` or `.strict()` on the schemas to control unknown field handling.

---

#### R10: Test helper `TestAccumulator` is duplicated across 4 test files

**Files:** `test/unit/plugins/processors/rename.test.ts`, `test/unit/plugins/processors/filter.test.ts`, `test/unit/plugins/aggregators/basicstats.test.ts`, `test/integration/metric-filter-pipeline.test.ts`

**Observation:** Each test file defines its own `TestAccumulator` class with slightly different field shapes. A shared test utility would reduce duplication and ensure consistent test infrastructure.

**Recommendation:** Extract a shared `TestAccumulator` into `test/helpers/test-accumulator.ts` when convenient. Low priority — the current duplication is harmless and each variant is tailored to its test needs.

---

#### R11: Integration test `metric-filter-pipeline.test.ts` defines a `FilterProcessor` that shadows the real one

**File:** `test/integration/metric-filter-pipeline.test.ts`, lines 83-99

**Observation:** The integration test defines its own `FilterProcessor` class that is functionally identical to `src/plugins/processors/filter.ts`. It could import and use the real `FilterProcessor` instead, which would make the integration test validate the actual production code rather than a test double.

**Recommendation:** Replace the local `FilterProcessor` with an import from `@plugins/processors/filter`. This strengthens the integration test without changing behavior.

---

#### R12: `globToRegex` does not handle empty string pattern

**File:** `src/core/metric-filter.ts`, `globToRegex()` function

**Observation:** `globToRegex("")` produces `/^$/` which matches only the empty string. An empty metric name is invalid in practice, so this would never match anything. This is technically correct but could be confusing if a user accidentally provides an empty pattern in their config. No Zod validation prevents `namepass: [""]`.

**Recommendation:** Consider adding `z.string().min(1)` to the namepass/namedrop/fieldpass/fielddrop array element schemas in `MetricFilterSchema` to reject empty patterns at config validation time. Very low priority.

---

#### R13: `BasicstatsAggregator.add()` has an unnecessary `isNoop` optimization check

**File:** `src/plugins/aggregators/basicstats.ts`, lines 122-126

**Observation:** The code checks `if (!this.filter.isNoop)` before calling `this.filter.apply(metric)`. However, `apply()` already returns immediately when `isNoop` is true (line 121 of metric-filter.ts). The extra `isNoop` check is a micro-optimization that avoids the function call overhead, which is negligible. It adds a code path that is slightly harder to reason about.

**Recommendation:** Purely stylistic. The explicit check is fine and documents intent clearly.

---

## PRD Compliance Tables

### metric-filter.ts (MetricFilter framework)

| PRD Requirement | Status | Notes |
|----------------|--------|-------|
| namepass glob filtering | ✅ Pass | Correct implementation with pre-compiled regex |
| namedrop glob filtering | ✅ Pass | |
| tagpass key+value matching | ✅ Pass | All keys must match (AND semantics) |
| tagdrop key+value matching | ✅ Pass | Any matching key+value drops metric (OR semantics per key) |
| fieldpass field whitelist | ✅ Pass | Mutates fields in-place (see R1 for iteration concern) |
| fielddrop field blacklist | ✅ Pass | Mutates fields in-place (see R1) |
| Evaluation order: namepass→namedrop→tagpass→tagdrop→fieldpass→fielddrop | ✅ Pass | Matches PRD §7 Telegraf semantics |
| Case-sensitive matching | ✅ Pass | Tested explicitly |
| Glob: * and ? wildcards | ✅ Pass | |
| Empty fields → drop metric | ✅ Pass | Both fieldpass and fielddrop check `fields.size === 0` |

### rename.ts (Rename Processor)

| PRD Requirement | Status | Notes |
|----------------|--------|-------|
| Processor interface compliance | ✅ Pass | `process(metric, acc)` with explicit emit |
| Field rename | ✅ Pass | removeField + addField |
| Tag rename | ✅ Pass | removeTag + addTag (re-sorts, updates hashId) |
| Missing source → skip | ✅ Pass | Rule silently skipped |
| Multiple rules → sequential | ✅ Pass | Applied in order |
| Explicit emit (no auto-forward) | ✅ Pass | Always calls `acc.addMetric(metric)` |
| Config: `replace` array with `field`/`tag`/`dest` | ✅ Pass | Matches Appendix A format |
| Config: `order` field | ⚠️ Deferred | Not in plugin schema; handled at runtime config layer |
| Per-plugin filtering (namepass etc.) | ⚠️ Deferred | Not in plugin schema; see R5 |
| Rule validation (at least one of field/tag) | ❌ Missing | See R2 |

### filter.ts (Filter Processor)

| PRD Requirement | Status | Notes |
|----------------|--------|-------|
| Processor interface compliance | ✅ Pass | `process(metric, acc)` with conditional emit |
| Wraps MetricFilter | ✅ Pass | Thin delegation |
| Drop behavior (emit nothing) | ✅ Pass | PRD §6: no auto-forward |
| Config: namepass/namedrop/tagpass/tagdrop/fieldpass/fielddrop | ✅ Pass | Reuses MetricFilterSchema |
| Per-plugin filtering | N/A | This IS the filter — per-plugin filtering is its purpose |

### basicstats.ts (Basicstats Aggregator)

| PRD Requirement | Status | Notes |
|----------------|--------|-------|
| Aggregator interface compliance | ✅ Pass | `add()`, `push()`, `reset()` match Appendix B |
| Min/max/mean/count/sum | ✅ Pass | All computed correctly |
| Variance/stdev | ✅ Pass | Welford's online algorithm, population variance |
| Configurable time windows (period) | ✅ Pass | String stored in config; numeric period passed at runtime |
| drop_original config | ✅ Pass | Boolean in config; used by runtime, not aggregator |
| Per-metric-name stats grouping | ✅ Pass | Groups by `hashId()` (name + sorted tags) |
| Per-field stats | ✅ Pass | Each numeric field tracked independently |
| Summary metric naming: `{field}_{stat}` | ✅ Pass | e.g., `value_count`, `temperature_mean` |
| Tags preserved on summaries | ✅ Pass | Captured at first `add()` |
| Configurable stats selection | ✅ Pass | Subset of 7 available stats |
| Per-plugin namepass/namedrop/tagpass/tagdrop | ✅ Pass | Wired via MetricFilter |
| Non-numeric fields silently skipped | ✅ Pass | String/boolean ignored |
| BigInt fields converted to Number | ✅ Pass | With console.warn for precision loss |
| Empty window → no emission | ✅ Pass | |
| Reset clears all state | ✅ Pass | `this.series.clear()` |

---

## Test Coverage Assessment

### Hard Path Coverage

| Hard Path | Tested? | Notes |
|-----------|---------|-------|
| fieldpass + fielddrop combined | ❌ No | See R7 |
| Metric with ALL fields removed by fielddrop | ✅ Yes | Returns null |
| Metric with ALL fields removed by fieldpass | ✅ Yes | Returns null |
| namepass + namedrop combined | ✅ Yes | Whitelist then blacklist |
| tagpass with multiple keys (AND semantics) | ✅ Yes | Both must match |
| tagdrop with missing tag key | ✅ Yes | Passes through |
| Rename chained A→B→C | ✅ Yes | Sequential rule application |
| Rename with missing source | ✅ Yes | Rule skipped |
| BigInt field > MAX_SAFE_INTEGER | ✅ Yes | Warning emitted |
| Empty aggregation window | ✅ Yes | push() emits nothing |
| Reset between windows | ✅ Yes | Stats reflect only new data |
| Multiple series (different hashId) | ✅ Yes | Separate stats per series |
| Welford's algorithm numerical stability | ✅ Yes | Known values verified |
| drop_original=true in pipeline | ✅ Yes | Integration test confirms no originals |
| Multiple aggregation windows | ✅ Yes | Min increases between windows |

### Missing Test Scenarios

1. **fieldpass + fielddrop combined** — not tested (R7)
2. **Rename rule with both `field` and `tag` set** — not tested (ambiguous config, see R6)
3. **Very large number of series in basicstats** — no stress test for memory/performance
4. **Aggregator with namepass rejecting ALL metrics** — push() with empty series after filtering (similar to empty window but via filter)
5. **Filter processor with all 6 filter types configured simultaneously** — only unit test covers this via MetricFilter; no integration test

---

## Phase 5 Readiness Assessment

### Blockers (Must Fix before Phase 5)

| Finding | Risk if Unfixed | Estimated Effort |
|---------|-----------------|------------------|
| R1: Map mutation during iteration | Correctness risk in MetricFilter (core framework) | 5 minutes |
| R2: Missing validation for empty rename rules | Silent config errors in production | 5 minutes |

### Should Fix Before Building on These Modules

| Finding | Risk if Deferred | Estimated Effort |
|---------|------------------|------------------|
| R3: Stale drop_original comment | Regression risk from misleading documentation | 2 minutes |
| R7: Missing fieldpass + fielddrop combined test | Untested interaction path | 5 minutes |

### Overall Assessment

**Phase 4 quality: Good.** The implementations are clean, well-documented, and correctly follow the PRD's plugin interfaces and accumulator contracts. Welford's algorithm is correctly implemented. The processor contract (explicit emit, no auto-forward) is respected throughout. The aggregator correctly delegates drop_original and auto-forwarding to the runtime. Test coverage is solid at 85 tests across 8 files, with strong coverage of the core algorithms and edge cases.

**Two 🔴 findings must be fixed.** Both are trivial (under 10 minutes combined). R1 is a defensive coding fix in the core filtering framework. R2 prevents silent config errors.

**Phase 5 can begin once R1 and R2 are addressed.** The remaining 🟡 findings are low-risk improvements that can be addressed opportunistically. The codebase is architecturally sound and the plugin implementations are ready to serve as building blocks for future phases.

---

## Summary

| Category | Count |
|----------|-------|
| 🔴 Must Fix | 2 |
| 🟡 Should Fix | 6 |
| 🟢 Nice to Have | 5 |
| **Total findings** | **13** |
