## 2. Goals & Non-Goals

### MVP Goals

1. **Reliable data collection** from industrial and commodity sources via a plugin pipeline
2. **Standalone-first operation** — full value with no network connectivity, with local data store and Web UI
3. **Three operating modes** — connected, local network, and standalone — as first-class, explicitly configured network policies
4. **Offline-resilient delivery** with store-and-forward buffering that survives power loss
5. **Sparkplug B native** Hub connectivity with automatic device discovery (when connected)
6. **Zero-disruption hot-reload** of input and output plugins
7. **Single compiled binary** that runs on arm64 and x64 Linux
8. **Local Web UI** for configuration, diagnostics, dashboards, and data export
9. **Plugin SDK** (`@collatr/edge-sdk`) enabling custom plugin development

### MVP Non-Goals

- **Not a SCADA system.** CollatrEdge collects and forwards data. It does not render HMI screens, execute control logic, or manage safety interlocks.
- **Not a MES.** Production scheduling, work orders, and quality management are Hub concerns.
- **Not an automation engine.** Local rules-based alerting is on the roadmap but not MVP. Node-RED style flow programming is out of scope.
- **Not a fleet manager.** Multi-device orchestration, cross-device correlation, and fleet-wide analytics are Hub concerns. A standalone Edge device may discover peers on the local network but does not manage them.
- **Not a local AI/ML platform (MVP).** Basic statistical alerting (thresholds, mean ± σ) is an Edge capability. Anomaly detection, predictive maintenance, and model training require fleet data and are Hub's domain in the standard product. However, on GPU-capable hardware (e.g., NVIDIA Jetson Orin), local inference is a legitimate post-MVP capability for the Edge Enterprise tier — real-time vision inspection, vibration anomaly scoring, and on-device model execution where latency or air-gap requirements preclude cloud inference. Hub remains the model training and fleet-wide analytics platform; Edge Enterprise runs inference at the edge. See §20.
- **Not a queryable data API.** The local data store supports data export (CSV/JSON/Parquet) and diagnostic views, not arbitrary SQL queries or a REST API for building custom dashboards. Hub provides the analytics API.
- **No proprietary hardware.** CollatrEdge runs on whatever Linux box the customer or integrator provides.
- **No Windows support in MVP.** Linux only (Debian/Ubuntu, Alpine, RHEL/Fedora). Windows is a future consideration.

### Licensing

| Component | Licence | Rationale |
|-----------|---------|-----------|
| **CollatrEdge** | **Apache 2.0** | Maximum adoption + patent protection. Industry standard for IIoT/CNCF ecosystem. Permissive: any manufacturer, integrator, or OEM can embed, modify, and redistribute. |
| **CollatrHub** | **BSL 1.1** (Business Source Licence) | Source available, self-hostable, prevents competing SaaS. Converts to Apache 2.0 after 4 years. |

**Dependency constraint:** No GPL-licensed dependencies in Edge. Apache 2.0 is compatible with MIT, BSD, and public domain — but NOT with GPL. All dependencies must be audited before first release.

**Known dependency licences:** node-opcua (MIT), msgpackr (MIT), Bun (MIT), SQLite (public domain), MQTT.js (MIT).
