## 21. MVP Build Sequence

The full MVP scope is accepted — no features cut. Timeline: ~8-10 weeks. Build order reflects dependencies and risk:

| Phase | Subsystem | Estimated Duration | Notes |
|-------|-----------|-------------------|-------|
| **0** | **Bun spike** | 2-3 days | Validate `bun compile` with SQLite WAL + arm64 + node-opcua. **Go/no-go gate** — see criteria below. Must complete before any other work. See also Appendix D §D.8. |
| **1** | **Core pipeline** | 1-1.5 weeks | `Channel<T>`, `Broadcaster`, `Ticker`, `Metric` model, plugin lifecycle (init/start/gather/stop/close), config parser (TOML + env vars + Zod validation). The spine of the system. |
| **2** | **Inputs** | 2-2.5 weeks | OPC-UA (ServiceInput, subscriptions, certificate workflow — largest single piece), Modbus TCP (polling, byte order, scaling, batch reads), MQTT consumer (subscribe, JSON parsing), internal metrics. |
| **3** | **Outputs** | 1-1.5 weeks | Local data store (SQLite, daily rotation, retention, CSV export), file output, stdout output, store-and-forward buffer (SQLite WAL, at-least-once delivery). |
| **4** | **Processors & Aggregators** | 0.5-1 week | Rename processor, filter processor, basicstats aggregator. Lightweight — the hard work is in the pipeline contract (already resolved). |
| **5** | **Essential tests** | 0.5-1 week | Prove the architecture: end-to-end pipeline, power loss recovery (SIGKILL), 24-hour stability, buffer overflow handling. Not exhaustive test suites — targeted confidence tests. |
| **6** | **CLI** | 2-3 days | `run`, `config init`, `config validate`, `version`. Four commands. Systemd unit file. |
| **7** | **Sparkplug B Hub link** | 1-1.5 weeks | MQTT connection, NBIRTH/DBIRTH/DDATA/NDEATH lifecycle, metric alias mapping, NCMD handling (rebirth, config push). |
| **8** | **Network policy** | 2-3 days | Config object, output plugin enforcement, fail-fast startup validation, DNS blocking for standalone guarantee. |
| **9** | **Web UI** | 1-1.5 weeks | Status page, live values, trend chart (last 24h), CSV export button, certificate helper (§D.4), network policy banner. Minimal — no config editing, no auth. Last priority. |

**Total: ~8-10 weeks** (single developer + AI assistance, no interruptions).

**Critical path:** Phase 0 (Bun spike) → Phase 1 (core) → Phase 2 (inputs, especially OPC-UA) → Phase 3 (outputs). Everything else can be parallelised or reordered without architectural risk.

### Phase 0 Go/No-Go Criteria

The Bun spike is a **project-risk gate**. By end of Day 2-3, the following must all pass:

| Test | Pass Criteria | Fail = |
|------|--------------|--------|
| `bun compile` x64 | Single binary runs, SQLite WAL works, basic I/O works | Pivot to Node.js |
| `bun compile` arm64 | Cross-compiled binary runs on Raspberry Pi 4 | Pivot to Node.js |
| SQLite WAL under SIGKILL | Kill -9 during writes → restart → ≤1s data loss, zero corruption | Investigate, may need sync config |
| node-opcua import | `bun compile` bundles node-opcua, client connects to test server | See fallback below |
| node-opcua subscribe | 100-node subscription, 5 min run, stable memory, <100ms notification latency | See fallback below |

**If Bun spike passes:** Proceed with Phase 1. Timeline: 8-10 weeks.

**If node-opcua fails but core Bun works:** Evaluate pure-JS mode (no native addons) for 1 day. If performance is acceptable (<500ms latency for 100 nodes), proceed with pure-JS. If not, pivot entire runtime to Node.js.

**If core Bun compile fails:** Pivot entire runtime to Node.js (`pkg` or `nexe` for single binary). Do not attempt hybrid Bun/Node approaches — the complexity is a trap. Timeline impact: +1 week for runtime switch, then resume Phase 1.

**Decision authority:** Lee makes the go/no-go call based on spike results.
