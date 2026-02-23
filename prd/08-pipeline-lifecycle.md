## 8. Pipeline Lifecycle

### Startup Sequence

Pipeline is built **backwards** (outputs → inputs), ensuring the pipeline is ready to receive data before any is generated:

```
1.  Parse and validate config (TOML → Zod validation)
2.  Validate plugin alias uniqueness (must be globally unique across all plugin types)
3.  Resolve network_policy mode → concrete egress/ingress rules
4.  Validate all outputs against network policy (FAIL if any output violates policy)
5.  Open SQLite databases (WAL mode) — main DB + today's data file
6.  SQLite recovery (see below)
7.  Load persisted state from SQLite
8.  Initialise local data store (if enabled / forced by standalone mode)
9.  Resolve secrets
10. Load and initialise plugins (lazy-load from registry)
11. Connect outputs (Output.connect()) — network policy injected into each
12. Build processor chain (reverse order, creating channels)
13. Start aggregators (create fork channels)
14. Start service inputs (ServiceInput.start())
15. Begin gather loops for polling inputs (Ticker)
16. Begin flush loops for outputs
17. Start Hub link if mode = connected (Sparkplug B NBIRTH + DBIRTH for all devices)
18. Start Web UI (HTTP server)
19. Check NTP reachability — warn if unreachable and mode != connected
20. Log "CollatrEdge started" + config summary + network policy mode
```

#### SQLite Recovery on Startup (Step 6)

After an unclean shutdown (SIGKILL, power loss), SQLite's WAL file may contain uncommitted data. The startup sequence handles this explicitly:

```typescript
// For each SQLite database (main DB + daily data files):
function recoverDatabase(dbPath: string): void {
  const db = new Database(dbPath);

  // 1. Ensure WAL mode (idempotent — no-op if already WAL)
  db.exec('PRAGMA journal_mode = WAL');

  // 2. Set synchronous mode from config
  db.exec(`PRAGMA synchronous = ${config.agent.synchronous ?? 'NORMAL'}`);

  // 3. Set busy timeout for concurrent access (Web UI reads)
  db.exec('PRAGMA busy_timeout = 5000');

  // 4. Checkpoint any uncommitted WAL data
  //    TRUNCATE mode: checkpoint + truncate WAL file to zero bytes
  //    This recovers any data written before the crash.
  const result = db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  // 5. Integrity check (optional, enabled via config)
  if (config.agent.integrity_check_on_startup) {
    const check = db.exec('PRAGMA integrity_check');
    if (check !== 'ok') {
      log.error(`Database corruption detected: ${dbPath}`, { result: check });
      // Move corrupt file aside, create fresh. Data in corrupt file
      // can be recovered manually later.
      fs.renameSync(dbPath, `${dbPath}.corrupt.${Date.now()}`);
      // Re-open creates a fresh database
    }
  }
}
```

**Key guarantees:**
- WAL checkpoint on startup recovers all committed transactions from before the crash
- `synchronous = NORMAL` means at most ~1 second of data loss (last batch not yet fsync'd)
- `synchronous = FULL` means zero data loss (every commit fsync'd, slower writes)
- Corrupt database files are moved aside, not deleted — manual recovery is possible

### Shutdown Sequence

Graceful shutdown on SIGINT/SIGTERM:

```
1.  Signal received → context cancelled
2.  Input gather loops stop (tickers cancelled)
3.  Service inputs stopped (stop())
4.  Input channels closed
5.  Processors drain remaining metrics, then stop
6.  Processor channels closed
7.  Aggregators push final aggregation, then stop
8.  Aggregator channels closed
9.  Outputs flush remaining buffers, then close
10. Local data store: final flush + checkpoint
11. Hub link publishes NDEATH (or broker publishes via Will Message)
    — If transitioning to standalone: publish "going standalone" NDATA first, then clean NDEATH
12. State persisted to SQLite
13. SQLite closed
14. Log "CollatrEdge stopped"
```

### Hot Reload

Four triggers, all feeding the same pipeline:

```
File watcher ──┐
HTTP API ──────┤──► Validate ──► Diff ──► Apply
Sparkplug NCMD ┤
SIGHUP ────────┘
```

**Validation:** New config is fully validated before any changes are applied. If invalid, the reload is rejected and the agent continues with the current config. A rejection event is logged and (if Hub-connected) reported via NDATA.

**Diff:** Old config vs new config is compared to identify:
- Plugins added (not in old config)
- Plugins removed (not in new config)
- Plugins changed (config differs)
- Plugins unchanged (skip)

**Apply (MVP):**

| Change | Plugin Type | Behaviour |
|--------|-------------|-----------|
| Add | Input | Create → connect → start gather → DBIRTH |
| Remove | Input | Stop gather → drain → disconnect → DDEATH |
| Reconfigure | Input | Stop → update config → restart. DBIRTH only if metric structure changed. |
| Add | Output | Create → connect → start flush |
| Remove | Output | Drain buffer → flush → disconnect |
| Reconfigure | Output | Pause → update → resume |
| Any | Processor | Fast restart: drain → persist state → rebuild chain → restart |
| Any | Aggregator | Fast restart: drain → push partial → persist → rebuild → restart |

**v1.1:** Full granular hot-reload for processors and aggregators (atomic chain swap).

### State Persistence

Plugins implementing `StatefulPlugin` can persist state across restarts:

```typescript
interface StatefulPlugin {
  getState(): unknown;
  setState(state: unknown): void;
}
```

State is serialised to SQLite on shutdown and hot-reload, restored on startup. Used for sequence numbers, cursor positions, aggregation windows, etc.
