# CollatrEdge — Product Requirements Document

> **Version:** 0.2 (MVP)
> **Created:** 2026-02-22
> **Updated:** 2026-02-22
> **Authors:** Lee (Doubly Good), Dex (AI)
> **Status:** Draft
> **Source:** `resources/telegraf-research.md`, `resources/collatr-edge-open-questions.md`, design decision sessions 2026-02-21/22, isolation mode multi-perspective review 2026-02-22

---

## Table of Contents

1. [Overview](./01-overview.md) — What CollatrEdge is, why it exists, and its design lineage
2. [Goals & Non-Goals](./02-goals-non-goals.md) — MVP scope boundaries
3. [Target User & Environment](./03-target-user-environment.md) — Primary users and deployment contexts
4. [Architecture Overview](./04-architecture-overview.md) — Pipeline model, channels, and concurrency
5. [Data Model](./05-data-model.md) — Metric structure and Sparkplug B mapping
6. [Plugin System](./06-plugin-system.md) — Plugin taxonomy, SDK, and lifecycle
7. [Configuration](./07-configuration.md) — TOML format, validation, and overrides
8. [Pipeline Lifecycle](./08-pipeline-lifecycle.md) — Startup, shutdown, hot-reload, and state persistence
9. [Hub Link & Control Plane](./09-hub-link-control-plane.md) — Sparkplug B connectivity and control operations
10. [Network Policy & Standalone Operation](./10-network-policy-standalone-operation.md) — Three operating modes and security guarantees
11. [Local Data Store](./11-local-data-store.md) — Persistent local storage with retention and export
12. [Buffers & Delivery Guarantees](./12-buffers-delivery-guarantees.md) — Store-and-forward architecture
13. [Scheduling](./13-scheduling.md) — Ticker, intervals, and timing
14. [Error Handling & Resilience](./14-error-handling-resilience.md) — Per-plugin isolation and recovery
15. [Observability](./15-observability.md) — Self-metrics, health endpoints, and logging
16. [Security](./16-security.md) — Secrets, TLS, authentication, and network posture
17. [Local Web UI](./17-local-web-ui.md) — Browser-based configuration and diagnostics
18. [Deployment & Distribution](./18-deployment-distribution.md) — Binary distribution and CLI
19. [MVP Plugin Inventory](./19-mvp-plugin-inventory.md) — Built-in plugins for inputs, processors, aggregators, and outputs
20. [Post-MVP Roadmap](./20-post-mvp-roadmap.md) — Deferred features with design hooks
21. [MVP Build Sequence](./21-mvp-build-sequence.md) — 8-10 week development timeline
22. [MVP Acceptance Criteria](./22-mvp-acceptance-criteria.md) — Five scenarios defining "done"

### Appendices

- [Appendix A: Full Config Example](./appendix-a-full-config-example.md) — Complete TOML configuration for a packaging production line
- [Appendix B: Metric Interface](./appendix-b-metric-interface.md) — TypeScript interfaces for Metric, Accumulator, Input, Output, etc.
- [Appendix C: Sparkplug B Topic Map](./appendix-c-sparkplug-b-topic-map.md) — NBIRTH/DBIRTH/DDATA/NCMD/NDEATH topic structure
- [Appendix D: OPC-UA Input Plugin Specification](./appendix-d-opc-ua-input-plugin-specification.md) — Complete OPC-UA spec: config, security, certificates, subscriptions, data types, browse

### Spike Results

- [Bun Runtime Validation](./spike-results-bun-runtime.md) — Go/no-go spike results: SQLite, single binary, node-opcua, ARM64 cross-compile, Modbus TCP

---

## Document Purpose

This PRD defines the complete specification for CollatrEdge, an IIoT data collection agent for manufacturing environments. It serves as the single source of truth for architecture decisions, implementation details, and acceptance criteria.

The document is organised into numbered sections covering the product from high-level goals through to detailed plugin specifications. Each section is self-contained and can be referenced independently.
