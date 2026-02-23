## 1. Overview

### What CollatrEdge Is

CollatrEdge is an IIoT data collection agent for manufacturing environments. It runs on-site, connects to machines and sensors via industrial and commodity protocols, and forwards contextualised telemetry to Collatr Hub or other destinations. It is the eyes and ears on the shop floor.

### Why It Exists

73% of UK manufacturers cite legacy technology as a major productivity blocker. 35% of processes still run on paper. The tools that exist to collect manufacturing data are too expensive, too complex, or require replacing equipment SMEs can't afford to replace.

CollatrEdge is software-only. It runs on commodity hardware (Raspberry Pi, industrial gateways, any Linux box). It connects to existing equipment via standard protocols. It works offline — not as a fallback, but as a first-class operating mode. Standalone operation is a design philosophy, not a limitation. It costs nothing to start using. It is the entry point to the Collatr ecosystem.

### Design Lineage

CollatrEdge is architecturally inspired by [Telegraf](https://github.com/influxdata/telegraf) (InfluxData), the most widely deployed open-source metric collection agent. We adopt Telegraf's proven patterns (4-type plugin taxonomy, per-plugin configuration, pipeline model) while improving on its limitations (no hot-reload, no backpressure, no offline persistence, Go-only plugins, full restart on config change).

The runtime is built with [Bun](https://bun.sh/) (TypeScript/JavaScript), chosen for its excellent async I/O performance, built-in SQLite, native TypeScript support, and ability to compile to a single standalone binary.
