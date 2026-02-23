## 20. Post-MVP Roadmap

Features explicitly deferred from MVP, with design hooks in place:

| Feature | Hook | Rationale |
|---------|------|-----------|
| **Full granular hot-reload** (processors/aggregators) | `Channel<T>` architecture supports atomic chain swap | Implementation complexity; inputs/outputs cover 80% of operational changes |
| **Priority queues** in buffer | `priority` field on `Metric` from day one | Buffer dequeue logic deferred; interface ready |
| **Cron-style scheduling** | `Ticker` interface is generic | Standard intervals cover 95% of MVP use cases |
| **Adaptive intervals / deadband** | `Ticker` accepts `shouldSkip()` callback | Useful for RS-485; adds plugin contract complexity |
| **Exactly-once delivery** | Buffer transaction model supports dedup IDs | Requires downstream coordination; rarely needed for telemetry |
| **TPM/HSM secret storage** | Pluggable secret store interface | SQLite + AES-256 sufficient for MVP |
| **Richer execd protocol** | JSON-lines for full plugin type support | Telegraf-compatible covers inputs/outputs |
| **ControlPlugin interface** | Runtime exposes control plane hooks | Built-in Hub link sufficient for MVP |
| **Worker threads for CPU-heavy plugins** | `workerMode` flag in plugin interface | Single-threaded sufficient for target workloads |
| **Local rules-based alerting** | Pipeline + processor architecture supports it | Requires threshold config UI and notification system |
| **Hub-initiated selective backfill** | Local store tracks sync state per metric | v1 uses export-based backfill; automatic sync adds complexity around bandwidth, audit trails, and data relevance |
| **Hash chain tamper-evidence** | Append-only local store with batch checksums | Batch checksums in MVP; hash chain linking batches adds defence/pharma compliance value |
| **Signed export packages** | Export API + crypto infrastructure | Cryptographic proof that exported data matches originals; compliance requirement for some sectors |
| **GPS time sync (PPS)** | Monotonic internal timestamps + UTC offset recording | For truly air-gapped deployments with strict timing; MVP logs warnings on clock drift |
| **USB update packages** | Signed package verification infrastructure | For standalone mode software updates; MVP supports Web UI file upload |
| **LDAP/AD authentication** | Pluggable auth interface behind admin/viewer roles | MVP has basic username/password; enterprise needs directory integration |
| **Edge Enterprise tier** | Network policy + local store + auth infrastructure | Premium standalone features: encrypted storage (FIPS), local multi-device management, compliance-grade audit logging, LDAP/AD. £500-2k/device/year. V2/V3 play for defence/air-gap segment. |
| **Edge AI inference (Enterprise)** | Plugin SDK + worker thread infrastructure | Local model inference on GPU-capable hardware (NVIDIA Jetson Orin, etc.). Use cases: real-time vision inspection, vibration anomaly scoring, on-device classification. Hub trains and pushes models; Edge Enterprise runs inference. Not for Pi/gateway-class hardware — requires GPU with ≥8GB VRAM. Separate from Hub's fleet-wide AI/analytics which remain cloud-only. |
| **Local multi-device discovery** | mDNS/UPnP scanning in local_network mode | Discover peer Edge devices on LAN; show count in UI ("3 CollatrEdge devices found"). Fleet management remains Hub's domain. |
| **Disk health monitoring** | Self-metrics infrastructure | eMMC write cycle tracking, SMART data where available, storage wear indicators |
| **Windows support** | Bun compiles to Windows | Linux-only covers target market |
| **Modbus RTU** | Existing `modbus` plugin + serial transport | Design pre-resolved: serial config (baud/parity/data/stop bits, RS-485 direction), bus coordinator (async mutex per serial port), udev symlink docs. Same register model as TCP — byte order, scaling, bit extraction, batch reads all apply. See `resources/collatr-edge-open-questions.md` for full spec. Build when first customer has RS-485. |
| **Additional input plugins** | Plugin SDK + registry | EtherNet/IP, MTConnect, Profinet, S7, BACnet, Zigbee, BLE |
| **Additional output plugins** | Plugin SDK + registry | InfluxDB native, PostgreSQL, SQL Server, Kafka, Webhooks |
