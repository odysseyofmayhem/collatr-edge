## 10. Network Policy & Standalone Operation

### Design Philosophy

CollatrEdge works everywhere — even where nothing else can. Standalone operation is not a degraded state or a fallback mode. It is a deliberate, first-class operating posture. The factory floor is the centre of gravity, not the cloud. A product that respects that — that works brilliantly on the factory floor first and connects to the cloud as a value-add — is aligned with how manufacturing actually works.

Most UK SME manufacturers will deploy CollatrEdge on a plant-floor LAN with no internet connectivity. This is the **most common** real-world deployment — not connected, not fully air-gapped, but local-network-only. The network policy system is designed around this reality.

### Three Operating Modes

CollatrEdge defines three operating modes. Each mode is a **preset** that expands into concrete egress and ingress rules. The mode label is a convenience; the explicit rules are the truth.

| Mode | Description | Typical Customer |
|------|-------------|------------------|
| **`connected`** | Full internet and Hub connectivity. Data flows to cloud, remote management enabled. | Cloud-ready SME, system integrator deployment |
| **`local_network`** | LAN access only. No internet, no Hub. Can reach local historians, MQTT brokers, NAS, NTP, email servers on the plant network. | Most UK SME manufacturers. "We have a network but we don't trust the cloud." |
| **`standalone`** | No network at all. Air-gapped. All data stays on the device. Access via direct connection (laptop) or local Wi-Fi AP. | Defence supply chain, contractually air-gapped environments, initial evaluation, proof-of-concept |

### Network Policy Configuration

The network policy is a **first-class config object** — not a hidden flag, not inferred from what outputs are configured. It is visible in the UI, logged at startup, and enforced at the output plugin layer.

```toml
[network_policy]
mode = "local_network"    # "connected" | "local_network" | "standalone"

# Egress rules (outbound connections from Edge)
[network_policy.egress]
allow_dns = false                    # No DNS = no cloud hostname resolution
allow_mqtt_hub = false               # Explicitly no Hub connectivity
allowed_hosts = [                    # Explicit allowlist for local destinations
  "192.168.1.50:8086",              # Local InfluxDB
  "192.168.1.10:1883",              # Local EMQX broker
  "192.168.1.1:123",               # Local NTP server
]

# Ingress rules (inbound connections to Edge)
[network_policy.ingress]
allow_local_webui = true             # Almost always true
allow_local_api = true               # Diagnostic API (not queryable data API)
allowed_cidrs = ["192.168.1.0/24"]   # Which hosts can reach the Web UI
```

### Mode Presets

Each mode expands into default egress/ingress rules. Users can override individual rules to handle real-world exceptions ("we're air-gapped *except* for the local historian").

| Rule | `connected` | `local_network` | `standalone` |
|------|-------------|-----------------|--------------|
| `allow_dns` | `true` | `false` | `false` |
| `allow_mqtt_hub` | `true` | `false` | `false` |
| `allow_local_subnet` | `true` | `true` | `false` |
| `allowed_hosts` | `[]` (unrestricted) | `[]` (must be explicit) | `[]` (blocked) |
| `allow_local_webui` | `true` | `true` | `true` |
| `allow_local_api` | `true` | `true` | `true` |
| `allowed_cidrs` | `["0.0.0.0/0"]` | `["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]` | `["0.0.0.0/0"]` |

### Enforcement Architecture

Network policy is enforced at the **output plugin layer**, not deep inside MQTT or HTTP client code. This keeps enforcement visible, auditable, and testable.

```
Pipeline boot:
  1. Parse config
  2. Resolve network_policy mode → concrete egress/ingress rules
  3. Inject NetworkPolicy interface into output plugin constructors
  4. Each output plugin validates its target against the policy
  5. FAIL AT STARTUP if any output violates the policy
     (never silently drop data at runtime)
```

**Startup failure is non-negotiable.** If the config says to output to Hub but the network policy says no egress, the agent refuses to start with a clear, auditable error:

```
FATAL: Output "sparkplug_hub" blocked by network_policy: egress to
mqtt.collatr.cloud denied in "standalone" mode. Either change the
network_policy to "connected" or remove the Hub output.
```

In a defence supply chain audit, "the software silently didn't send data" is almost as bad as "the software sent data." The error must be explicit.

### DNS Blocking as a Security Guarantee

In `local_network` and `standalone` modes, `allow_dns = false` by default. This means the edge **literally cannot resolve** `mqtt.collatr.cloud` or any other cloud hostname. This is a stronger guarantee than simply not configuring a Hub output — it's the answer to "how do I *know* it can't phone home?"

Defence and security-conscious customers will ask this question. DNS blocking + explicit egress allowlist is the answer.

### Mode Transition

#### Connected → Standalone

When switching from connected to standalone mode:

1. Edge sends a final **"going standalone" Sparkplug B NDATA message** to Hub containing:
   - Intent: `Node Control/Network Policy = "standalone"`
   - Timestamp of the transition
   - Current data range in local store
2. Edge publishes NDEATH (clean disconnect, not a crash)
3. Hub records the intentional disconnect — distinguishing "deliberately standalone" from "unreachable/crashed"
4. Network policy takes effect, all remote outputs are blocked
5. Local store becomes the primary (and only) output

This distinction matters: if an edge was previously connected and suddenly stops reporting, Hub should alert differently than if the edge announced it was going standalone.

#### Standalone → Connected

When switching from standalone to connected:

1. Edge validates new config (Hub output must be configured + valid credentials)
2. Edge connects to Hub broker, publishes NBIRTH + all DBIRTHs
3. Edge advertises data availability: "I have local data from [date] to [date]"
4. **Edge does NOT automatically backfill.** Historical data transfer is a deliberate, controlled operation (see §11).
5. New data flows to Hub in real-time from this point forward
6. The transition is logged with timestamp and visible in the Web UI

**Why no automatic backfill:** In practice, the transition from standalone to connected is a change management event — it involves IT/OT meetings, security reviews, and network provisioning. The data collected during isolation may be weeks old. Automatic backfill would saturate newly-provisioned network links, break audit models in regulated environments, and dump data that may no longer be contextually relevant. Controlled export is the right v1 approach.

### Accidental Isolation Prevention

A misconfigured `mode = "standalone"` deployed to 50 edges would make them all appear "offline" to Hub with no way to distinguish intent from failure. Mitigations:

- **"Going standalone" message:** The Sparkplug NDATA message (above) gives Hub explicit notice
- **Startup banner:** The local Web UI displays the network policy **prominently** on every page — not buried in settings:
  ```
  🔒 STANDALONE MODE — No external data transmission
  ```
  or:
  ```
  🏠 LOCAL NETWORK — Data stays on-premises (192.168.1.0/24)
  ```
  or:
  ```
  🌐 CONNECTED — Sending data to hub.collatr.com
  ```
- **Config validation warning:** If Hub credentials are present but `mode != "connected"`, log a warning at startup: "Hub credentials configured but network policy prevents Hub connectivity"
- **Mode change confirmation:** The Web UI requires explicit confirmation to change network policy: "You are about to enable external data transmission. Are you sure?"

### Data Flow by Mode

```
CONNECTED:
  Input → Processor → Aggregator → [S&F Buffer] → Hub (Sparkplug B)
                                  → [S&F Buffer] → Other remote outputs
                                  → [Local Store]  (optional, if configured)

LOCAL NETWORK:
  Input → Processor → Aggregator → [S&F Buffer] → Local InfluxDB / EMQX / etc.
                                  → [Local Store]  (always on, primary record)

STANDALONE:
  Input → Processor → Aggregator → [Local Store]  (the ONLY output)
```

In connected mode, the local store is an optional backup. In local network mode, it's always-on as belt-and-suspenders alongside local outputs. In standalone mode, it IS the product.

### Time Synchronisation

In standalone and local_network modes, NTP may be unreachable. Edge devices will drift — 30+ seconds over a month is common on commodity hardware.

| Mode | Time Source |
|------|-------------|
| `connected` | NTP via internet (standard) |
| `local_network` | Local NTP server (add to `allowed_hosts`). Falls back to system clock. |
| `standalone` | System clock only. No external sync available. |

**MVP mitigations:**
- Log a warning at startup if NTP is unreachable and `mode != "connected"`
- Display the time source and last-sync status in the Web UI status page
- Use monotonic timestamps internally for interval calculations (not wall clock)
- Record the UTC offset at startup for post-hoc correction if needed

**Post-MVP:** GPS time (PPS) support for truly air-gapped deployments with strict timing requirements. Manual time-set via Web UI.

### Software Updates in Standalone Mode

How do you update CollatrEdge when it can't reach the internet?

- **Local file upload:** Upload a signed update package via the Web UI
- **USB update:** Place a signed update file on a USB drive, Edge detects and applies it
- **Signed packages:** All update packages are cryptographically signed. Defence customers will require this.
- **Rollback safety:** The current version continues running if the update fails. No bricking.
- **Data preservation:** Updates never touch the local data store or configuration
