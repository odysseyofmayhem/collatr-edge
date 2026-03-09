# Phase 12 Progress — WebUI Redesign

## Status: IN PROGRESS

## Overview
Replace hardcoded 4-signal dashboard with config-driven live overview and hybrid trends page.

## Tasks
- [x] 12.0 — Signal descriptor system
- [ ] 12.1 — Dashboard page rewrite — equipment cards
- [ ] 12.2 — SSE stream update — dynamic signal names
- [ ] 12.3 — Trends page — hybrid curated + metric picker
- [ ] 12.4 — Staleness detection and visual indicators
- [ ] 12.5 — CSS refinements and responsive layout
- [ ] 12.6 — Integration tests with factory simulator data

## Log

### Task 12.0 — Signal descriptor system (complete)
- Created `src/web/signal-descriptors.ts` with `SignalDescriptor`, `EquipmentGroup` types
- Static lookup table covering all 47 signals across 7 equipment groups (press, laminator, slitter, coder, energy, env, vibration)
- `buildSignalDescriptors()` groups metrics by dotted prefix, assigns metadata from lookup, handles unknown signals with sensible defaults
- Curated `defaultTrendSignals` per equipment group for the trends page
- Machine state enum labels exported for press (6 states) and coder (5 states)
- Unknown equipment groups: capitalised prefix as display name, order=100 (after known), all numeric signals as trend defaults
- 22 unit tests, all passing
