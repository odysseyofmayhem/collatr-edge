# Phase 4: Processors & Aggregators — Implementation Plan

**Goal:** Build the P0 processor and aggregator plugins (rename, filter, basicstats). By the end of Phase 4, CollatrEdge can transform, filter, and aggregate metrics through the pipeline. This phase also implements the per-plugin metric filtering system (namepass/namedrop/tagpass/tagdrop/fieldpass/fielddrop).

**Estimated Duration:** 0.5–1 week
**PRD References:** §6 (Plugin System — Processor/Aggregator contracts), §7 (Configuration — filtering), §19 (MVP Plugin Inventory), Appendix A (Config Example), Appendix B (Interfaces)

---

## What Phase 4 Delivers

| Plugin | Type | Priority | Description |
|--------|------|----------|-------------|
| `rename` | Processor | P0 | Rename fields and tags. 1:1 passthrough with name changes. |
| `filter` | Processor | P0 | Drop/pass metrics by name, tag, and field criteria (namepass/namedrop/tagpass/tagdrop). |
| `basicstats` | Aggregator | P0 | Min/max/mean/count/sum over configurable time windows. |
| Metric filtering | Runtime | P0 | Per-plugin namepass/namedrop/fieldpass/fielddrop/tagpass/tagdrop — applies to any plugin. |

---

## Module Dependency Order

```
4.0  Metric filtering framework       ← runtime-level, applies to all plugin types
4.0i Integration: filtering in pipeline
4.1  Rename processor                  ← simplest processor, validates pattern
4.1i Integration: rename in pipeline
4.2  Filter processor                  ← uses filtering framework
4.2i Integration: filter in pipeline
4.3  Basicstats aggregator             ← first real aggregator
4.3i Integration: basicstats in pipeline (full E2E)
```

**Build order rationale:**
- Metric filtering framework first — filter processor and per-plugin filtering both need it
- Rename before filter — simpler processor, validates the explicit-emit contract
- Filter processor uses the filtering framework as its core logic
- Basicstats last — validates the aggregator contract (add/push/reset) with real math

---

## Module 4.0: Metric Filtering Framework

**PRD:** §7 (Configuration — Filtering)

### What to Build
- `src/core/metric-filter.ts`
- Reusable filtering logic that can be applied to any plugin's output
- Six filter types (all from Telegraf, per PRD §7):
  - `namepass` — only pass metrics whose name matches any glob pattern
  - `namedrop` — drop metrics whose name matches any glob pattern
  - `fieldpass` — only keep fields matching any glob pattern (others removed)
  - `fielddrop` — remove fields matching any glob pattern
  - `tagpass` — only pass metrics with tags matching `{ key: [values...] }`
  - `tagdrop` — drop metrics with tags matching `{ key: [values...] }`
- Glob matching: support `*` (any chars) and `?` (single char) — Telegraf-compatible
- Filter evaluation order: namepass → namedrop → tagpass → tagdrop → fieldpass → fielddrop
- A `MetricFilter` class that takes filter config and exposes `apply(metric): Metric | null`
  - Returns null if metric should be dropped entirely (name/tag filters)
  - Returns modified metric if fields were filtered (field filters)
  - Returns original metric if no filters match

### Config Schema (per-plugin, optional)
```typescript
const MetricFilterSchema = z.object({
  namepass: z.array(z.string()).optional(),
  namedrop: z.array(z.string()).optional(),
  fieldpass: z.array(z.string()).optional(),
  fielddrop: z.array(z.string()).optional(),
  tagpass: z.record(z.array(z.string())).optional(),
  tagdrop: z.record(z.array(z.string())).optional(),
}).optional();
```

### Key Constraints
- Filters are configured per-plugin instance, not globally
- All filter fields are optional — no filter = pass everything
- `namepass` and `namedrop` can coexist: namepass whitelist first, then namedrop removes from what passed
- `tagpass`/`tagdrop` check if the metric HAS a tag key and its value matches any in the list
- `fieldpass`/`fielddrop` modify the metric in-place (remove non-matching fields). If all fields removed, metric is dropped.
- Glob patterns are case-sensitive

### Tests
- No filters configured → metric passes through unchanged
- namepass: metric name matches glob → passes; doesn't match → dropped
- namedrop: metric name matches glob → dropped; doesn't match → passes
- namepass + namedrop together: namepass whitelist first, namedrop removes from result
- tagpass: metric with matching tag value → passes; non-matching → dropped
- tagpass: metric missing the tag key entirely → dropped
- tagdrop: metric with matching tag value → dropped
- fieldpass: only matching fields kept, others removed
- fielddrop: matching fields removed, others kept
- fieldpass removes all fields → metric dropped (no empty metrics)
- Glob wildcards: `temperature_*` matches `temperature_motor`, `temperature_oven`
- Glob `?`: `temp_?` matches `temp_1`, `temp_2` but not `temp_12`
- Multiple patterns: `["temp_*", "pressure_*"]` matches either
- Empty filter arrays → no filtering (pass everything)

---

## Module 4.1: Rename Processor

**PRD:** §6, §19, Appendix A

### What to Build
- `src/plugins/processors/rename.ts`
- Processor that renames fields and/or tags on metrics passing through
- Config: list of replacement rules `{ field?: string, tag?: string, dest: string }`
- For each metric: apply all rename rules, emit the modified metric via `acc.addMetric()`
- Supports per-plugin metric filtering (from 4.0)

### Config Schema
```typescript
const RenameConfigSchema = z.object({
  replace: z.array(z.object({
    field: z.string().optional(),
    tag: z.string().optional(),
    dest: z.string(),
  })).default([]),
  // Per-plugin filtering
  namepass: z.array(z.string()).optional(),
  namedrop: z.array(z.string()).optional(),
  // ... (all filter fields)
});
```

### Key Constraints
- Processor contract: explicit emit via `acc.addMetric()`. No auto-forward.
- If no rename rules match, metric is still forwarded (1:1 passthrough)
- Field rename: remove old field, add new field with same value
- Tag rename: remove old tag, add new tag with same value
- If source field/tag doesn't exist on a metric, rule is silently skipped
- Multiple rules can apply to the same metric (applied in order)
- Rename must update `hashId` if tags change (re-sort tags after rename)

### Tests
- Rename field: `temperature` → `motor_temp_c`
- Rename tag: `host` → `hostname`
- Field not present → rule skipped, metric still forwarded
- Multiple rename rules applied in order
- Rename doesn't affect other metrics in batch
- Metric forwarded via acc.addMetric() (explicit emit verified)
- Tag rename updates tag sort order (hashId changes)
- Config validation: dest is required

---

## Module 4.2: Filter Processor

**PRD:** §6, §7, §19

### What to Build
- `src/plugins/processors/filter.ts`
- Processor that conditionally passes or drops metrics
- Uses the MetricFilter framework from 4.0 as its core logic
- Additional filter: `condition` — expression-based filtering (post-MVP, stub only)
- Processor contract: emit matching metrics, drop non-matching

### Config Schema
```typescript
const FilterConfigSchema = z.object({
  // All standard filter fields from MetricFilterSchema
  namepass: z.array(z.string()).optional(),
  namedrop: z.array(z.string()).optional(),
  fieldpass: z.array(z.string()).optional(),
  fielddrop: z.array(z.string()).optional(),
  tagpass: z.record(z.array(z.string())).optional(),
  tagdrop: z.record(z.array(z.string())).optional(),
});
```

### Key Constraints
- This is the simplest processor — it's essentially a wrapper around MetricFilter
- Processor contract: emit via `acc.addMetric()` if passes, emit nothing if dropped
- Different from per-plugin filtering: the filter *processor* is an explicit pipeline stage that processes metrics between inputs and outputs

### Tests
- namepass filter: matching metrics pass, non-matching dropped
- namedrop filter: matching metrics dropped
- tagpass filter: metrics with matching tags pass
- Combined: namepass + tagdrop → both applied
- No matching filters configured → all metrics pass (no-op processor)
- Field filtering: fieldpass keeps only specified fields
- Metric with all fields filtered out → dropped entirely

---

## Module 4.3: Basicstats Aggregator

**PRD:** §6, §19, Appendix A

### What to Build
- `src/plugins/aggregators/basicstats.ts`
- Aggregator that computes min, max, mean, count, sum over configurable time windows
- `add(metric)` — accumulate numeric field values (called by runtime with metric copies)
- `push(acc)` — emit summary metrics via `acc.addFields()` with computed statistics
- `reset()` — clear accumulated state for next window
- Per-metric-series tracking: group by name + tags (using hashId)
- Only numeric fields (number, bigint) aggregated; string/boolean fields ignored
- Summary metric naming: `{original_name}_basicstats` or configurable suffix

### Config Schema (from PRD Appendix A)
```typescript
const BasicstatsConfigSchema = z.object({
  period: z.string().default('60s'),  // Aggregation window
  drop_original: z.boolean().default(false),
  stats: z.array(z.enum(['count', 'min', 'max', 'sum', 'mean', 'variance', 'stdev']))
    .default(['count', 'min', 'max', 'sum', 'mean']),
  // Per-plugin filtering
  namepass: z.array(z.string()).optional(),
  namedrop: z.array(z.string()).optional(),
  // ... (all filter fields)
});
```

### Key Constraints
- Aggregator contract: `add()` accumulates, `push()` emits summaries, `reset()` clears state
- Runtime handles: copying metrics to aggregator, auto-forwarding originals, calling push() on period timer, calling reset() after push()
- Group by hashId (name + sorted tags) — each series gets its own statistics
- Numeric fields only: skip string and boolean fields during aggregation
- BigInt fields: convert to Number for aggregation (with precision warning if > MAX_SAFE_INTEGER)
- Empty window (no metrics received): push() emits nothing (don't emit zero-count summaries)
- Summary field names: `{field}_min`, `{field}_max`, `{field}_mean`, `{field}_count`, `{field}_sum`
- Tags from the original series preserved on summary metrics

### Tests
- Single series, 10 numeric values → correct min, max, mean, count, sum
- Multiple series (different tags) → separate stats per series
- Mixed field types: numeric aggregated, string/boolean ignored
- BigInt fields aggregated (converted to Number)
- Empty window → push() emits nothing
- reset() clears state — next window starts fresh
- stats config: only requested stats emitted (e.g., `stats = ["count", "mean"]`)
- Summary metric has original tags preserved
- Summary metric name includes suffix
- drop_original: verified at runtime level (not aggregator's responsibility)
- namepass on aggregator: only matching metrics aggregated
- Variance and stdev calculations correct
- Single value in window: min = max = mean = value, count = 1, variance = 0

---

## Phase 4 Acceptance Criteria

Phase 4 is complete when:

1. ✅ Metric filtering framework works with all 6 filter types + globs
2. ✅ Rename processor renames fields and tags correctly
3. ✅ Filter processor drops/passes metrics based on criteria
4. ✅ Basicstats aggregator computes correct statistics over time windows
5. ✅ Per-plugin filtering works on any plugin type
6. ✅ All tests pass: `bun test`
7. ✅ Sub-agent code review completed and findings addressed

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Glob matching performance with many patterns | Pre-compile patterns to regex on init, not per-metric |
| Aggregator memory with many series | Each series holds only running stats (6 numbers), not full history. 10,000 series ≈ 480KB. |
| Floating point precision in mean/variance | Use Welford's online algorithm for numerically stable variance |
| Aggregator + pipeline timing | Aggregator push is called by runtime timer, not by the aggregator itself. Test with real Ticker. |
