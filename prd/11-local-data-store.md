## 11. Local Data Store

### Purpose

The local data store is a **built-in output plugin** that persists processed metrics locally in SQLite. It is architecturally distinct from the store-and-forward buffer — different purpose, different retention, different lifecycle.

| Role | Purpose | Retention | Behaviour |
|------|---------|-----------|-----------|
| **S&F Buffer** (§12) | Temporary holding for metrics destined for remote outputs | Short (hours/days), drains when remote output is reachable | Part of the delivery mechanism. Data is removed after successful delivery. |
| **Local Data Store** (this section) | Persistent local record of processed data | Configurable (weeks/months, bounded by disk) | A destination in its own right. Data is retained according to retention policy regardless of whether it's been sent elsewhere. |

In connected mode, the S&F buffer handles network resilience. The local store (if enabled) exists because the customer *wants* a local copy. In standalone mode, the S&F buffer is irrelevant (there's nowhere to drain to) and the local store is the **primary output**.

### Configuration

```toml
[outputs.local_store]
enabled = true                       # Always true in standalone mode
path = "/var/collatr/data"           # Data directory
retention_days = 90                  # Delete data older than N days
retention_max_gb = 10                # Don't exceed N GB, evict oldest first
rotation = "daily"                   # Partition by day for manageable queries
downsample_after_days = 7            # Full-resolution for 7 days, then downsampled
downsample_interval = "1m"           # Downsample to 1-minute averages after threshold
backup_smb_path = ""                 # Optional: nightly backup to SMB/CIFS share
backup_schedule = "02:00"            # When to run backup (local time)
```

### Always-On in Standalone Mode

When `network_policy.mode = "standalone"`, the local store is **implicitly enabled and cannot be disabled.** If the config doesn't include `[outputs.local_store]`, it is created with sensible defaults. If `enabled = false` is set in standalone mode, the agent logs a warning and enables it anyway.

In `local_network` mode, the local store defaults to enabled as belt-and-suspenders alongside network outputs. If the local InfluxDB goes down, the edge still has data.

In `connected` mode, the local store is optional — disabled by default, available if the customer wants a local backup.

### Retention Policies

Edge devices have finite storage. Retention policies are **critical safety features**, not nice-to-haves. A Pi with 100ms polling on 500 tags and no retention limit will fill its disk in 48 hours, lock up, and stop the local HMI from responding.

**Three retention mechanisms (all active simultaneously, whichever triggers first):**

| Mechanism | Config | Behaviour |
|-----------|--------|-----------|
| **Time-based** | `retention_days = 90` | Delete data older than N days |
| **Size-based** | `retention_max_gb = 10` | Evict oldest data when storage exceeds N GB |
| **Downsampling** | `downsample_after_days = 7` | Keep full-resolution data for N days, then downsample to configurable interval (default 1m averages) |

**Fail-safe defaults:** If no retention is configured, the defaults apply (90 days, 10GB, downsample after 7 days). The agent will **never** fill the disk and crash silently.

**Storage monitoring:** The agent exposes storage metrics as self-metrics (see §15):

| Metric | Description |
|--------|-------------|
| `agent.local_store.used_bytes` | Current storage used |
| `agent.local_store.available_bytes` | Remaining storage |
| `agent.local_store.days_remaining` | Estimated days until retention limit at current ingest rate |
| `agent.local_store.retention_evictions` | Count of metrics evicted by retention policy |

The Web UI displays a clear storage indicator: "Local Storage: 67% used — ~43 days remaining at current rate." Warning at 80%, critical at 95%.

### Downsampling

Downsampling preserves trends while dramatically reducing storage. After `downsample_after_days`, full-resolution data points are aggregated into summary rows:

- **Fields:** min, max, mean, count for each numeric field
- **Tags:** preserved (grouping key)
- **Timestamp:** aligned to `downsample_interval` boundary
- **Original data:** deleted after downsampling

Example: 1-second data for 7 days → 604,800 rows. After downsampling to 1-minute: 10,080 rows. **60x storage reduction** with min/max/mean preserved for trend analysis.

### Disk I/O Considerations

CollatrEdge targets commodity hardware, including eMMC-based industrial PCs and Raspberry Pi class devices with limited write endurance.

**MVP mitigations:**

- **Batch writes:** Metrics are buffered in memory and written in 1-second (or configurable) batches, not individual INSERTs. At 1000 points/second, this is 1 write transaction per second, not 1000.
- **WAL mode:** SQLite WAL (Write-Ahead Logging) minimises write amplification and allows concurrent reads during writes.
- **Daily rotation:** Data is partitioned by day (`rotation = "daily"`), allowing efficient bulk deletion of old data without VACUUM.
- **Filesystem guidance:** ext4 with `noatime` is recommended. The agent detects and warns if running on FAT32 or other unsuitable filesystems.

**Post-MVP:**
- Expose disk write metrics for monitoring eMMC/SD card wear
- Configurable write batch interval (trade latency for write reduction)

### Network Backup (SMB/CIFS)

For `local_network` mode, the local store supports automated backup to a network share. Most UK SME factories already have a NAS for general file backup.

```toml
[outputs.local_store]
backup_smb_path = "//fileserver/backups/collatredge/"
backup_schedule = "02:00"            # Daily at 2am
backup_credentials = "@{secrets:smb_credentials}"
```

- Nightly incremental backup of the local store to the SMB share
- This is still "local network only" — no cloud involved — but the data isn't solely on one SD card
- Backup success/failure is reported as an agent self-metric and visible in the Web UI
- Missing or unreachable SMB share logs a warning but does not affect data collection

### Data Export

The local store supports manual data export for offline analysis and auditing:

| Format | Use Case |
|--------|----------|
| **CSV** | Universal. Production managers live in Excel. Import into any tool. |
| **JSON** | Structured data for developers and integrators. |
| **Parquet** | Columnar format for large datasets. Efficient for analytics tools. |

Export is available via:
- **Web UI:** Select time range, metrics, and format. Download directly.
- **CLI:** `collatr-edge export --from 2026-02-01 --to 2026-02-22 --format csv --output /mnt/usb/data.csv`
- **REST API:** `GET /api/export?from=...&to=...&format=csv` (diagnostic API, not a queryable data platform)

For air-gapped deployments, USB export is the primary method for getting data off the device.

### Data Integrity & Compliance

For food manufacturing (BRC), pharmaceutical, and defence supply chain customers, data integrity is not optional.

**MVP features:**

- **Append-only storage:** The local store is append-only during normal operation. Metrics cannot be edited or deleted through the API or Web UI — only retention policies remove data.
- **Write checksums:** Each batch write includes a SHA-256 checksum. Corruption is detectable.
- **Audit log:** All configuration changes, mode transitions, exports, and retention evictions are logged with timestamps in a separate audit table.
- **Retention compliance:** Configurable retention periods map to regulatory requirements (e.g., BRC: shelf life + 1 year for food CCPs).

**Post-MVP:**
- Hash chain for tamper-evidence (each batch references the previous batch's hash)
- Signed export packages (cryptographic proof that exported data matches the original)
- Compliance report generation (PDF summary for auditors)

### Backfill (Post-MVP)

When transitioning from standalone/local_network to connected, historical data transfer to Hub is a controlled, deliberate operation — not automatic.

**v1 (MVP): Export-based backfill**
- Use the data export feature (above) to extract data as Parquet/CSV
- Upload to Hub via Hub's import API, or transfer via USB to a connected machine
- Auditable, explicit, no "did it sync everything?" anxiety
- This is what defence and pharma customers actually want

**v2 (Post-MVP): Hub-initiated selective sync**
1. Edge advertises data availability to Hub: "I have data from [date] to [date]"
2. Hub **requests** specific time ranges (not Edge pushing)
3. Backfill runs as a low-priority background job, rate-limited
4. Progress visible in local Web UI and Hub dashboard
5. Idempotent: network interruptions during backfill are handled via batch IDs and dedup

### SQLite Schema

CollatrEdge uses SQLite (WAL mode) for all persistent storage. The database is split across multiple files for operational reasons:

| Database File | Contents | Lifecycle |
|---------------|----------|-----------|
| `collatr-edge.db` | Buffers, plugin state, config cache, secrets, audit log, schema version | Long-lived, single file |
| `data/data_YYYY_MM_DD.db` | Metrics for one day (local data store) | One file per day. Retention = delete old files. No VACUUM needed. |

**Daily file rotation** is the TTL mechanism for metrics. Deleting `data_2026_01_15.db` is the most efficient eviction possible — no VACUUM, no fragmentation, no index rebuilding. For size-based eviction (`retention_max_gb`), the oldest daily file is deleted first. This approach is critical for SD card / eMMC longevity: no large DELETE + VACUUM operations that cause write amplification.

#### Local Data Store Schema (per-day file)

```sql
-- data/data_YYYY_MM_DD.db

CREATE TABLE metrics (
  id          INTEGER PRIMARY KEY,
  timestamp   INTEGER NOT NULL,    -- nanosecond Unix UTC
  name        TEXT NOT NULL,       -- measurement name
  tags_hash   INTEGER NOT NULL,    -- FNV-64a of sorted tags (grouping key)
  tags        TEXT NOT NULL,       -- JSON-encoded sorted tags
  fields      BLOB NOT NULL,       -- encoding TBD: see field encoding research
  quality     INTEGER DEFAULT 0    -- 0 = good, 1 = uncertain, 2 = bad
);

CREATE INDEX idx_metrics_time ON metrics (timestamp);
CREATE INDEX idx_metrics_name_time ON metrics (name, timestamp);

-- Tag catalogue: which name+tag combinations exist in this day file
CREATE TABLE tag_index (
  name        TEXT NOT NULL,
  tags_hash   INTEGER NOT NULL,
  tags        TEXT NOT NULL,       -- JSON
  first_seen  INTEGER NOT NULL,    -- nanosecond timestamp
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (name, tags_hash)
);
```

**Field encoding: MessagePack via `msgpackr`.**

Research compared JSON, MessagePack (@msgpack/msgpack and msgpackr), CBOR, per-row zstd compression, and column-oriented (EAV) table designs. Key findings:

| Encoding | Size (3 fields) | Size (7 fields) | Encode speed | Type fidelity |
|----------|-----------------|-----------------|--------------|---------------|
| JSON | 48 B | 113 B | 2.8M ops/sec | ❌ No int/float distinction |
| **msgpackr** | **51 B** | **102 B** | **3.3M ops/sec** | **✅ Full type preservation** |
| Per-row zstd | ~55-60 B | ~85-95 B | ~200-300K ops/sec | Depends on inner format |

`msgpackr` (kriszyp) is the MVP choice because:
- **Faster than native JSON.stringify** (3.3M vs 2.8M encode, 4.4M vs 2.6M decode)
- **Type fidelity** — distinguishes int vs float at the wire level. `42` (counter) vs `42.0` (measurement) have different IIoT semantics. BigInt (int64) precision preserved.
- **12-15% smaller** for larger MQTT payloads (5+ fields). Near-identical for small payloads.
- **Handles nested/unstructured data** from arbitrary MQTT JSON payloads without schema.
- **Pure JS, zero native deps** — works in Bun, bundles cleanly, no `bun compile` risk.
- **Battle-tested** — same engine used by `lmdb-js`.

Per-row zstd compression is **counterproductive** for typical metric payloads: the frame header (11-18 bytes) makes sub-128-byte payloads *larger* after compression.

**Post-MVP compression strategy:** `sqlite-zstd` row-level dictionary compression. Trains dictionaries on repeated field key patterns (80%+ size reduction in benchmarks). Requires Rust cross-compilation for ARM — deferred to post-MVP.

Full research: `resources/field-encoding-research.md`.

**Write pattern:** Metrics are batched in memory (1-second default, configurable) and written in a single transaction. At 1000 metrics/sec this is 1 transaction per second, not 1000 individual INSERTs. This is critical for flash storage longevity.

**Transaction model for local store writes:**

```typescript
// Local store write — called once per batch interval (default 1s)
function writeBatch(metrics: Metric[]): void {
  const db = getDailyDatabase();
  const insert = db.prepare(
    'INSERT INTO metrics (timestamp, name, tags_hash, tags, fields, quality) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const updateIndex = db.prepare(
    'INSERT INTO tag_index (name, tags_hash, tags, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(name, tags_hash) DO UPDATE SET last_seen = excluded.last_seen'
  );

  // BEGIN IMMEDIATE — fail fast if another writer holds lock
  // (shouldn't happen in single-threaded model, but Web UI export
  //  runs concurrent reads that could promote to writes via temp tables)
  const tx = db.transaction(() => {
    for (const m of metrics) {
      insert.run(m.timestamp, m.name, m.tagsHash, m.tagsJson, m.fieldsEncoded, m.quality);
      updateIndex.run(m.name, m.tagsHash, m.tagsJson, m.timestamp, m.timestamp);
    }
  });

  try {
    tx(); // Bun SQLite transactions use BEGIN IMMEDIATE by default
  } catch (e) {
    if (e.message.includes('SQLITE_BUSY')) {
      log.warn('Local store write blocked by concurrent reader, retrying', { batchSize: metrics.length });
      // Retry once after busy_timeout (5000ms from PRAGMA)
      tx();
    } else {
      throw e; // Unexpected error — propagate
    }
  }
}
```

**Atomicity:** The entire batch succeeds or fails as one transaction. No partial writes. If the process crashes mid-transaction, SQLite rolls back the incomplete transaction on recovery — no corrupt or partial data.

#### Main Database Schema

```sql
-- collatr-edge.db

-- Schema versioning for forward-only migrations
CREATE TABLE schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  description TEXT
);

-- Per-output store-and-forward buffer (simple append-only queue)
-- One table per configured output, e.g., buffer_mqtt_hub, buffer_http_influx
-- Table name: buffer_{output_alias_sanitised}
CREATE TABLE buffer_TEMPLATE (
  id          INTEGER PRIMARY KEY,   -- auto-increment, used for ordering
  timestamp   INTEGER NOT NULL,      -- metric timestamp (for ordering)
  payload     BLOB NOT NULL,         -- encoded Metric (same encoding as local store fields)
  created_at  INTEGER NOT NULL       -- when buffered (for age-based eviction)
);

CREATE INDEX idx_buffer_TEMPLATE_created ON buffer_TEMPLATE (created_at);

-- Plugin state persistence (survives restarts and hot-reload)
CREATE TABLE plugin_state (
  plugin_key  TEXT PRIMARY KEY,      -- e.g., "inputs.modbus.plc_01"
  state       TEXT NOT NULL,         -- JSON-serialized (must be JSON-serializable, max 1MB)
  updated_at  INTEGER NOT NULL
);

-- Secret store (encrypted at rest)
CREATE TABLE secrets (
  key         TEXT PRIMARY KEY,
  value       BLOB NOT NULL,         -- AES-256-GCM encrypted
  iv          BLOB NOT NULL,         -- 12-byte initialisation vector
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Config cache (for diffing on reload)
CREATE TABLE config_cache (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  config_hash TEXT NOT NULL,         -- SHA-256 of current config TOML
  config_toml TEXT NOT NULL,         -- raw TOML text
  applied_at  INTEGER NOT NULL
);

-- Audit log (config changes, mode transitions, exports, retention events)
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  timestamp   INTEGER NOT NULL,      -- nanosecond Unix UTC
  event_type  TEXT NOT NULL,         -- 'config_change', 'mode_transition', 'export',
                                     --  'retention_eviction', 'secret_change', 'startup', 'shutdown'
  details     TEXT NOT NULL,         -- JSON-encoded event details
  actor       TEXT DEFAULT 'system'  -- 'system', 'webui:admin', 'webui:viewer', 'hub', 'cli'
);

CREATE INDEX idx_audit_time ON audit_log (timestamp);
CREATE INDEX idx_audit_type ON audit_log (event_type);
```

**Audit log retention:** Configurable via `[agent] audit_retention_days = 365` (default: 1 year). Rows older than the threshold are deleted on the daily maintenance pass. Low-volume (events, not metrics) so no rotation needed — simple DELETE by timestamp.

**Buffer table per output:** Tables are created/dropped dynamically as outputs are added/removed from config. Table name is derived from the output alias (sanitised to valid SQL identifier).

**Plugin state contract:** State values must be JSON-serializable (plain objects, arrays, primitives). Maximum 1MB per plugin instance. `JSON.stringify()` / `JSON.parse()` for serialisation. Plugins needing Map/Set/BigInt must handle their own conversion to/from plain objects.

**State persistence error handling:**

```typescript
function savePluginState(pluginKey: string, state: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch (e) {
    // Circular references, BigInt without toJSON, etc.
    log.error(`Failed to serialize state for ${pluginKey}: ${e.message}. State not persisted.`);
    return; // Continue without saving — plugin will restart with no state
  }

  if (serialized.length > 1_000_000) {
    log.error(`Plugin state for ${pluginKey} exceeds 1MB limit (${serialized.length} bytes). State not persisted.`);
    return;
  }

  db.prepare('INSERT OR REPLACE INTO plugin_state (plugin_key, state, updated_at) VALUES (?, ?, ?)')
    .run(pluginKey, serialized, Date.now());
}
```

**Failure mode:** State persistence errors are logged but never crash the agent. The plugin continues running; it will simply restart with no saved state if the agent restarts. This is acceptable because state is a performance optimisation (resuming sequence numbers, aggregation windows), not a correctness requirement.

#### Migration Strategy

- **Forward-only migrations:** Numbered scripts (001_initial.sql, 002_add_quality.sql, etc.) applied sequentially on startup.
- **Version check:** On startup, read `schema_version`, run any migrations with version > current, update `schema_version`.
- **Breaking changes:** For major schema changes, create new tables and migrate data. Expected to be rare — schema should stabilise early.
- **Daily data files:** Each new daily file is created with the current schema version. Old files with older schemas are read with backwards-compatible queries (column defaults handle missing columns).
