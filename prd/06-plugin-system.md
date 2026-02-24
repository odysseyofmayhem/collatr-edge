## 6. Plugin System

### Plugin Taxonomy

Four plugin types, each with a distinct role:

| Type | Interface | Role |
|------|-----------|------|
| **Input** | `gather(acc): Promise<void>` | Collects metrics on a timer (polling) or continuously (service/push) |
| **Processor** | `process(metric: Metric, acc: Accumulator): Promise<void>` | Transforms/filters/enriches metrics inline, 1:1 or 1:N |
| **Aggregator** | `add(metric: Metric): void` / `push(acc: Accumulator): void` / `reset(): void` | Accumulates metrics over a time window, emits summaries |
| **Output** | `connect(): Promise<void>` / `write(batch: Metric[]): Promise<void>` / `close(): Promise<void>` | Delivers metrics to external systems |

**Input variants:**
- **Polling input** — `gather(acc)` called on a configurable interval by the runtime's `Ticker`
- **Service input** — long-running; calls `start(acc)` to begin, pushes metrics whenever they arrive (e.g., MQTT subscriber, HTTP listener). Stopped via `stop()`.

### Accumulator Contract

The `Accumulator` is the interface through which plugins emit metrics into the pipeline. Its behaviour is context-dependent:

```typescript
interface Accumulator {
  /** Create a new metric from scratch. Timestamp assigned automatically if not provided. */
  addFields(measurement: string, fields: Record<string, FieldValue>, tags?: Record<string, string>, timestamp?: bigint): void;
  
  /** Forward an existing metric (pass-through, modified, or cloned). Used by processors. */
  addMetric(metric: Metric): void;
  
  /** Report a non-fatal error (logged + counted, doesn't stop the plugin). */
  addError(error: Error): void;
}
```

**Contract per plugin type:**

| Plugin Type | Accumulator Usage | What Happens to the Input Metric |
|-------------|-------------------|----------------------------------|
| **Input** | `acc.addFields()` creates new metrics. This is the only way metrics enter the pipeline. Timestamp is auto-assigned via `Bun.nanoseconds()` (monotonic-to-wall-clock converted) if not explicitly provided. Inputs can override the timestamp (e.g., OPC-UA provides source timestamps). | N/A — inputs create metrics, they don't receive them. |
| **Processor** | Receives one metric. Emits zero or more via `acc.addMetric()` or `acc.addFields()`. **No auto-forwarding.** If the processor emits nothing, the metric is dropped. To pass through unchanged: `acc.addMetric(metric)`. To transform: modify and emit. To split: emit multiple. To filter: emit conditionally. | **Explicitly controlled by the plugin.** No magic. The processor owns the decision of what goes downstream. |
| **Aggregator** | `add(metric)` is called by the **runtime** with a **copy** of each metric for accumulation. The runtime automatically forwards the original metric downstream — the aggregator never touches originals. When the time window fires, `push(acc)` emits additional summary metrics via `acc.addFields()`. | **Automatically forwarded by the runtime.** The aggregator only adds summaries. `drop_original = true` in config suppresses the automatic forwarding (handled by runtime, not the plugin). See **`drop_original` semantics** below. |

**Why no auto-forward for processors:** Simpler contract, no ambiguity. The processor author always knows exactly what they're responsible for. A rename processor: receive → modify → `acc.addMetric(modified)`. A filter: receive → check → `acc.addMetric(metric)` or nothing. A splitter: receive → `acc.addMetric(a)` + `acc.addMetric(b)`. No hidden behaviours.

**Why auto-forward for aggregators:** Aggregators are accumulation windows, not transforms. Their job is to add summaries alongside the raw data stream. Making every aggregator plugin duplicate the forwarding logic would be error-prone and pointless — the runtime handles it once, correctly.

#### `drop_original` semantics with multiple aggregators

`drop_original` is configured per-aggregator but evaluated globally by the runtime. **Originals are only suppressed when every aggregator has `drop_original = true`.** If any aggregator has `drop_original = false` (the default), originals flow through to all outputs.

This is a deliberate design decision driven by the pipeline topology: all aggregators share a single output broadcaster. The runtime cannot selectively forward originals to some outputs (for aggregators that want them) while suppressing them for others — that would require per-aggregator output routing with separate output channel sets, which is not part of the MVP architecture.

The `.every()` resolution is the safe default: when aggregators disagree, data is preserved. Dropping originals when one aggregator still expects them would cause silent data loss. Keeping originals when one aggregator doesn't need them is harmless — the aggregator's summaries are additive, not replacements.

```
# Example: two aggregators with conflicting drop_original
[[aggregators.basicstats]]
  period = "30s"
  drop_original = true          # wants summaries only
  namepass = ["motor_speed"]

[[aggregators.basicstats]]
  period = "60s"
  drop_original = false         # wants originals + summaries
  namepass = ["temperature"]

# Result: originals flow through (because not all aggregators agree to drop)
# Both aggregators still receive copies and produce summaries
```

If per-aggregator output routing is needed in the future (e.g., aggregator A feeds output X, aggregator B feeds output Y), the per-instance `drop_original` values are already wired through `PipelineOptions` and can be consumed by a routing layer without config changes.

### Plugin Definition

Plugins are defined using TC39 decorators via `@collatr/edge-sdk`. **JSON Schema is the canonical config schema format.** TypeScript plugin authors can use Zod for better DX — the SDK converts it to JSON Schema automatically.

**TypeScript plugin (using Zod convenience):**

```typescript
import { Plugin, Config, Input, Accumulator } from '@collatr/edge-sdk';
import { z } from 'zod';

// Zod schema — SDK converts to JSON Schema via zod-to-json-schema
// ──────────────────────────────────────────────────────────────────────
// SAFETY: CollatrEdge is READ-ONLY. Modbus write function codes
// (FC05, FC06, FC15, FC16) are not implemented and MUST NOT be added.
// Input plugins never modify PLC state. This is a deliberate, permanent
// design constraint — not a missing feature.
// ──────────────────────────────────────────────────────────────────────

// Register schema — shared between direct and gateway (multi-slave) configs
const ModbusRegisterSchema = z.object({
  address: z.number().int(),
  name: z.string(),
  type: z.enum(['holding', 'input', 'coil', 'discrete']).default('holding'),
  data_type: z.enum(['uint16', 'int16', 'uint32', 'int32', 'float32', 'bool']).default('uint16'),

  // Per-register byte order override (for mixed-vendor setups)
  byte_order: z.enum(['ABCD', 'CDAB', 'BADC', 'DCBA']).optional(),

  // Scaling: output = (raw_value * scale) + offset
  // e.g., raw 8550 with scale=0.01, offset=0 → 85.50°C
  scale: z.number().default(1.0),
  offset: z.number().default(0.0),

  // Bit extraction: extract a single bit from a 16-bit register as boolean.
  // e.g., bit=3 extracts bit 3 (0-indexed) from the register value.
  // When set, data_type is ignored and output is boolean.
  bit: z.number().int().min(0).max(15).optional(),
});

const ModbusConfigSchema = z.object({
  controller: z.string().describe('Modbus TCP address (e.g., tcp://192.168.1.100:502)'),

  // Connection mode:
  //   "dedicated" (default) — one TCP connection per plugin instance.
  //     Use for direct PLC connections (one slave_id per instance).
  //   "shared" — one TCP connection shared across multiple slave IDs.
  //     REQUIRED for Modbus TCP gateways (Moxa MGate, Anybus, etc.)
  //     that expose multiple RS-485 slaves on one TCP endpoint.
  //     Most gateways support only 4-8 concurrent TCP connections —
  //     without shared mode, each slave_id opens a separate connection,
  //     exhausting the gateway's connection pool.
  connection_mode: z.enum(['dedicated', 'shared']).default('dedicated'),

  // ── Direct mode (connection_mode = "dedicated") ─────────────────
  slave_id: z.number().int().min(1).max(247).default(1),
  registers: z.array(ModbusRegisterSchema).optional(),

  // ── Gateway mode (connection_mode = "shared") ───────────────────
  // Multiple slave IDs share one TCP connection. Each slave has its
  // own register list. Requests are serialised (one at a time) to
  // avoid interleaving responses.
  slaves: z.array(z.object({
    slave_id: z.number().int().min(1).max(247),
    registers: z.array(ModbusRegisterSchema),
  })).optional(),

  // Byte order for multi-register values (float32, uint32, int32).
  // Different PLC vendors use different orders:
  //   ABCD = big-endian (Schneider, GE — Modbus spec default)
  //   CDAB = big-endian word-swap (Siemens, older Allen-Bradley)
  //   BADC = little-endian word-swap (Eurotherm, some Yokogawa)
  //   DCBA = little-endian (rare, some embedded controllers)
  // Plugin-level default; can be overridden per-register.
  byte_order: z.enum(['ABCD', 'CDAB', 'BADC', 'DCBA']).default('ABCD'),

  // Batch reads: combine contiguous registers into a single Modbus
  // request instead of one request per register. Dramatically reduces
  // PLC scan cycle impact and network round-trips.
  optimization: z.enum(['none', 'batch']).default('batch'),
  max_batch_size: z.number().int().min(1).max(125).default(125)
    .describe('Max registers per batch read (Modbus spec limit: 125 for FC03)'),
  // Gap threshold: if gap between registers > max_gap, split into
  // separate batch requests. Prevents reading 100 unused registers
  // to get 2 values at addresses 100 and 200.
  max_gap: z.number().int().min(0).default(10),

  timeout: z.string().default('5s'),
});

// ── Modbus Exception Handling ─────────────────────────────────────────
// Modbus devices return exception codes instead of data when something
// is wrong. CollatrEdge handles each exception differently:
//
// | Exception Code | Name                  | Response                           |
// |----------------|-----------------------|------------------------------------|
// | 01             | Illegal Function      | Disable register, log ERROR (config error) |
// | 02             | Illegal Data Address  | Disable register, log ERROR (config error) |
// | 03             | Illegal Data Value    | Disable register, log ERROR (config error) |
// | 04             | Slave Device Failure  | Retry next interval, log WARN      |
// | 05             | Acknowledge           | Retry after device-specified delay  |
// | 06             | Slave Device Busy     | Retry with backoff, log WARN       |
// | 08             | Memory Parity Error   | Retry next interval, log WARN      |
// | 0A             | Gateway Path Unavail  | Retry with backoff, log WARN       |
// | 0B             | Gateway Target Failed | Retry with backoff, log WARN       |
// | (no response)  | Timeout               | Retry next interval, log WARN      |
//
// "Disable register" means stop polling that specific register but continue
// with all others. A single misconfigured register must not break the entire
// input. Disabled registers are reported in self-metrics and Web UI.
//
// Batch reads: if a batch read fails, fall back to individual register reads
// to isolate which specific register(s) caused the error.

@Plugin({
  name: 'modbus',
  type: 'input',
  description: 'Collect data from Modbus TCP/RTU devices',
  docs: 'https://docs.collatr.com/plugins/input/modbus',
})
@Config(ModbusConfigSchema)
export class ModbusInput implements Input {
  private config!: z.infer<typeof ModbusConfigSchema>;
  private client!: ModbusTcpClient;

  async init(): Promise<void> {
    this.client = new ModbusTcpClient(this.config.controller);
  }

  async gather(acc: Accumulator): Promise<void> {
    for (const reg of this.config.registers) {
      const value = await this.client.readRegister(reg.address, reg.type, reg.data_type);
      acc.addFields(reg.name, { value }, { slave_id: String(this.config.slave_id) });
    }
  }

  async close(): Promise<void> {
    await this.client.disconnect();
  }
}
```

**Execd plugin (Python, Go, etc.) — provides JSON Schema directly:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "controller": { "type": "string", "description": "Modbus TCP address" },
    "slave_id": { "type": "integer", "minimum": 1, "maximum": 247, "default": 1 }
  },
  "required": ["controller"]
}
```

### Decorator Metadata

The `@Plugin()` decorator is the single source of truth for:

- **Plugin registry** — name, type, class reference
- **Web UI** — available plugins list, descriptions, documentation links
- **Config forms** — JSON Schema (from `@Config()` decorator, via Zod or direct) renders config forms
- **API** — `/plugins` endpoint serves metadata for all registered plugins

### Plugin Registration & Loading

**Built-in plugins** are bundled in the compiled binary but **lazy-loaded** — only parsed and allocated when enabled in config:

```typescript
const BUILTIN_PLUGINS = {
  'input/modbus':     () => import('./plugins/inputs/modbus'),
  'input/opcua':      () => import('./plugins/inputs/opcua'),
  'input/mqtt':       () => import('./plugins/inputs/mqtt'),
  'output/mqtt':      () => import('./plugins/outputs/mqtt'),
  'output/http':      () => import('./plugins/outputs/http'),
  'processor/rename': () => import('./plugins/processors/rename'),
  // ...
} as const;
```

Binary size grows with bundled plugins. Runtime memory only reflects what's active.

### Plugin Discovery (Available Plugins)

Lazy loading creates a problem: the Web UI and `/plugins` API need to list all available plugins with their metadata (names, descriptions, config schemas, docs links) *without* importing every module into memory.

**Solution: build-time metadata extraction.**

During the build step (before `bun compile`), a script imports every plugin module, reads decorator metadata and JSON Schema, and generates a static `plugin-manifest.json` that is bundled into the binary:

```typescript
// scripts/generate-plugin-manifest.ts (runs at build time)
const manifest: Record<string, PluginManifestEntry> = {};
for (const [key, loader] of Object.entries(BUILTIN_PLUGINS)) {
  const mod = await loader();
  const meta = getPluginMetadata(mod.default);  // reads @Plugin() decorator
  const schema = getConfigSchema(mod.default);   // reads @Config() JSON Schema
  manifest[key] = { ...meta, configSchema: schema };
}
await Bun.write('src/generated/plugin-manifest.json', JSON.stringify(manifest));
```

At runtime, the manifest is loaded as static JSON (trivially cheap) and used for all discovery:

```typescript
import manifest from './generated/plugin-manifest.json';

// /plugins API — serves manifest directly, zero plugin module loading
app.get('/plugins', () => Response.json(manifest));

// Web UI config forms — rendered from manifest's JSON Schema, no plugin import needed

// Only when config enables a plugin does the actual module load
if (config.inputs.modbus) {
  const mod = await BUILTIN_PLUGINS['input/modbus']();
  // now the Modbus plugin code + dependencies are in memory
}
```

**Key properties:**
- **Single source of truth.** Decorators define everything. The manifest is auto-generated from them — no hand-maintained metadata that can drift from code.
- **Zero runtime cost.** Reading bundled JSON is trivial. No plugin modules are imported for discovery.
- **No module structure constraints.** Plugins can freely use top-level imports for heavy dependencies (OPC-UA client, Modbus library) without impacting discovery performance.
- **Works for external plugins too.** In-process external plugins have metadata extracted on install. Execd plugins provide a JSON manifest file alongside their binary (or support a `--metadata` CLI flag as a convention).

**External plugins** — two loading mechanisms for different trust levels:

| Mechanism | Trust Level | How It Works |
|-----------|-------------|--------------|
| **In-process** | Trusted (own code, customer TS) | `import('/opt/collatr-edge/plugins/custom.ts')` — Bun imports TS directly, full SDK access, same process |
| **Execd** | Untrusted (vendor, Python, Go) | Child process, stdin/stdout protocol. Full isolation — crash/leak in plugin doesn't affect agent |

**Execd protocol:** Telegraf-compatible line protocol over stdin/stdout for MVP (maximum ecosystem compatibility — existing Telegraf execd plugins work out of the box). Richer JSON-lines protocol planned post-MVP for full plugin type support.

### Multiple Instances

The registry stores plugin **classes**, not instances. Each config block creates a new instance via factory:

```toml
[[inputs.modbus]]
  alias = "plc_line_1"
  controller = "tcp://192.168.1.100:502"
  # ...

[[inputs.modbus]]
  alias = "plc_line_2"
  controller = "tcp://192.168.1.101:502"
  # ...
```

### Plugin SDK — `@collatr/edge-sdk`

A lightweight npm package for plugin authors containing:

- Base interfaces (`Input`, `ServiceInput`, `Processor`, `Aggregator`, `Output`)
- Decorators (`@Plugin`, `@Config`)
- `Accumulator` type for adding metrics
- `Metric` type and utilities
- Zod-to-JSON-Schema helper (optional — TS plugin authors use Zod for DX, SDK converts to JSON Schema)
- JSON Schema validation utilities
- Execd protocol handler (for out-of-process plugins)
