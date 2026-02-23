## 17. Local Web UI

### Purpose

Browser-based interface served by CollatrEdge on a local HTTP port. For configuration, diagnostics, and monitoring without needing Hub connectivity or CLI access.

### MVP Features

**Core (all modes):**

- **Network Policy Banner:** Persistent, prominent indicator on every page showing current mode (🔒 STANDALONE / 🏠 LOCAL NETWORK / 🌐 CONNECTED) with target details
- **Dashboard:** Pipeline status, plugin health, buffer levels, event loop lag, storage usage
- **Configuration:** View current config. Add/remove/reconfigure plugins via forms (generated from JSON Schema). Apply changes (triggers hot-reload). Network policy changes require explicit confirmation.
- **Plugins:** List available plugins (built-in + external). View metadata, descriptions, config schemas.
- **Logs:** Live log viewer with per-plugin filtering
- **Secrets:** Manage secret store entries (set, delete — values never displayed)
- **Metrics:** Recent metric samples per input (for debugging — "is this input collecting what I expect?")
- **Authentication:** Admin/Viewer roles (see §16)

**Standalone & Local Network features:**

- **Live Values:** Current readings from all connected inputs. Simple gauges, traffic-light indicators (green/amber/red based on configurable thresholds). This is the "mini-SCADA" view — glanceable operational status.
- **Trend Charts:** Historical data from the local store. Last shift, last 24 hours, last week. "Every Tuesday at 2pm the chiller struggles" — this is the killer feature for justifying the project.
- **Storage Indicator:** "Local Storage: 67% used — ~43 days remaining at current rate." Warning at 80%, critical at 95%.
- **Data Export:** Select time range, metrics, and format (CSV/JSON/Parquet). Download directly or export to USB path. Production managers live in Excel — CSV export must be obvious and one-click.
- **Basic Reporting:** Daily min/max/average per metric. Exportable as CSV or printable summary. Something an auditor or BRC assessor can review.
- **Health Monitoring:** Clear red/green status for each input (is it collecting?), each output (is it delivering?), disk space, clock sync status. The junior IT person checking once a day needs to see green = good, red = bad — no log interpretation required.
- **Audit Trail:** Searchable log of configuration changes, mode transitions, exports, and retention events with timestamps.

**Ghost Features (standalone/local_network only):**

Subtle UI elements that demonstrate what Hub would provide, without being obnoxious or salesy:

- A "Fleet Overview" tab showing only the current device with a "1 of 1 devices" indicator
- An "AI Insights" section: "Anomaly detection available with Hub connection, or locally with Edge Enterprise on supported hardware" (shown only after 14+ days of data exist — honest, not premature)
- Trend charts that naturally end where local storage ends, with a note about retention limits
- These features are informational. They do not nag, pop up, or block any functionality.

### Technology

Lightweight — served by the same Bun process. Static HTML/JS/CSS bundled in the binary. No framework dependency. API endpoints (`/api/config`, `/api/plugins`, `/api/metrics`, `/api/export`, `/health`) serve JSON.

**Design principle:** The Web UI must be legible to non-technical people. A production manager, a maintenance engineer, or a BRC auditor should be able to read it. No jargon-heavy dashboards. Clear labels. Traffic-light status indicators.
