## 4. Architecture Overview

### Pipeline Model

CollatrEdge implements a four-stage data pipeline, adopted from Telegraf's proven taxonomy:

```
┌──────────┐     ┌────────────┐     ┌─────────────┐     ┌──────────┐
│  Inputs  │────►│ Processors │────►│ Aggregators  │────►│ Outputs  │
│ (collect)│     │ (transform)│     │ (summarise)  │     │ (deliver)│
└──────────┘     └────────────┘     └──────────────┘     └──────────┘
      │                │                    │                   │
      ▼                ▼                    ▼                   ▼
  Channel<T>       Channel<T>          Channel<T>          Buffer → SQLite
  (fan-in)         (chained)           (fork)              (per-output)
```

| Stage | Role | Cardinality |
|-------|------|-------------|
| **Input** | Collects metrics from external sources (polling or push) | Many → one channel (fan-in) |
| **Processor** | Transforms, filters, enriches metrics inline | Chained in sequence |
| **Aggregator** | Accumulates metrics over time windows, emits summaries | Forks stream: originals pass through, copies aggregate |
| **Output** | Writes metrics to external destinations | One channel → many outputs (fan-out via Broadcaster) |

### Inter-Stage Data Flow

Stages are connected by `Channel<T>` — a custom async primitive that is the direct Bun/TypeScript analogue of Go channels. The single-threaded event loop means no mutexes are needed on channel internals — cooperative interleaving makes buffer manipulation atomically safe from JS's perspective.

```typescript
interface Channel<T> {
  /** Send a value. Returns false if channel is closed. Behaviour when full depends on overflow policy. */
  send(value: T): Promise<boolean>;
  
  /** Receive values as an async generator. Completes when channel is closed and drained. */
  receive(): AsyncGenerator<T, void, undefined>;
  
  /** Close the channel. No more sends accepted. Existing values can still be received. */
  close(): void;
  
  /** Current number of items in the channel. */
  readonly length: number;
  
  /** Channel capacity. */
  readonly capacity: number;
  
  /** Whether the channel is closed. */
  readonly closed: boolean;
}

interface ChannelOptions {
  /** Maximum items the channel can buffer. */
  capacity: number;           // default: 1000
  /** Behaviour when channel is full. MVP: drop-oldest only. Post-MVP: configurable per-channel. */
  overflow: 'drop-oldest' | 'block';  // default: 'drop-oldest'
}
```

**Core behaviours:**

- **Backpressure:** When the channel is full, the overflow policy determines behaviour. MVP default is `drop-oldest` — the oldest metric in the channel is evicted to make room. Inputs never block. In IIoT, recent data is more valuable than old data; collection must never stall due to downstream backpressure.
- **Composability:** `receive()` yields an `AsyncGenerator` for clean `for await...of` pipelines. Each stage's processing loop is a simple `for await (const metric of channel.receive()) { ... }`.
- **Fan-in:** Multiple inputs write to a single channel concurrently. No coordination needed — event loop interleaving handles safety.
- **Fan-out:** A `Broadcaster` deep-copies metrics to all output channels (see below).
- **Shutdown:** `close()` signals graceful termination. `send()` on a closed channel returns `false` (does not throw). `receive()` on a closed channel completes the AsyncGenerator naturally (`{ done: true }`). Close cascades through the pipeline: input channel closes → processors drain and close their channels → aggregators drain and close → output channels drain and close. Each stage processes remaining items before closing its downstream channel.

**Channel capacity defaults:**

| Stage | Default Capacity | Rationale |
|-------|-----------------|-----------|
| Input fan-in channel | 10,000 | Buffers bursts from all inputs. Large enough that inputs don't block under normal conditions. |
| Processor chain channels | 1,000 | Between each processor. Processors should be fast — small buffer catches micro-bursts. |
| Aggregator fork channel | 1,000 | Copy channel to aggregator's internal accumulator. |
| Per-output channel | 10,000 | Before the output's buffer/write call. Aligns with `metric_buffer_limit` default. |

All capacity defaults are configurable via `[agent.channels]` in config. Tuning guidance will be provided in the deployment documentation based on profiling during development.

**Broadcaster — independent per-consumer:**

```typescript
interface Broadcaster<T> {
  /** Register an output channel. */
  addConsumer(channel: Channel<T>): void;
  
  /** Remove an output channel. */
  removeConsumer(channel: Channel<T>): void;
  
  /** Send value to all consumers independently. Each consumer's channel handles overflow per its own policy. */
  broadcast(value: T, copy: (v: T) => T): Promise<void>;
  
  /** Close all consumer channels. */
  closeAll(): void;
}
```

Each output gets its own `Channel<Metric>` with its own capacity and overflow policy. The Broadcaster sends to each consumer independently — if Output A's channel is full and drops oldest, Output B is completely unaffected. One slow or down output never impacts other outputs or the upstream pipeline. This is the critical design guarantee for operational reliability.

**Go channel pattern adaptation notes:**

The Go channel pattern translates to TypeScript/JS with high fidelity. Two notable differences:
- **No `select` statement.** Go's `select { case <-ch1: ... case <-ch2: ... }` has no JS native equivalent. `Promise.race()` across receiver Promises provides the same capability where needed (primarily shutdown signalling, handled via `AbortSignal`).
- **No true concurrent senders.** Go goroutines are preemptively scheduled; JS async functions interleave cooperatively. This is a *benefit* — no mutexes needed on channel internals, no data races possible. The ring buffer implementation is simpler and provably correct.

**Post-MVP:** Configurable per-channel overflow policy (`drop-oldest`, `block`). The `block` policy would be useful for processors that must not lose data (e.g., a compliance-critical enrichment step).

### Concurrency Model

Single-threaded async event loop (Bun's JavaScriptCore runtime). This handles 95%+ of target deployments — our SME customers are not running 10,000 sensors on one edge box.

**Tier 1 mitigations (built into MVP):**
- Auto-jitter on collection intervals to prevent thundering herd on the event loop
- Periodic yielding (`await Bun.sleep(0)`) in batch operations to prevent event loop starvation
- Event loop lag monitoring exposed as an agent self-metric
- Hand-rolled `copy()` for metric fan-out (not `structuredClone()`)

**Tier 2 mitigations (post-MVP, when profiling demands it):**
- Per-plugin `workerMode` flag to offload CPU-heavy plugins to Worker threads
- `SharedArrayBuffer` ring buffers for high-throughput paths (>50k metrics/sec)
- Object pooling to reduce GC pressure

### Runtime Components

```
┌──────────────────────────────────────────────────────────────┐
│  CollatrEdge Process                                          │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ Pipeline │  │ Hub Link │  │ Web UI   │  │ Config       │ │
│  │ Runtime  │  │ (SpB)    │  │ (HTTP)   │  │ Manager      │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘ │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ Plugin   │  │ Secret   │  │ State    │  │ Buffer       │ │
│  │ Registry │  │ Store    │  │ Persister│  │ Manager      │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘ │
│  ┌──────────┐  ┌──────────────────────────────────────────┐  │
│  │ Network  │  │ Local Data Store (built-in output)       │  │
│  │ Policy   │  │ [retention] [downsampling] [export]      │  │
│  └──────────┘  └──────────────────────────────────────────┘  │
│                                                               │
│  ┌───────────────────────────────────────────────────────┐   │
│  │                    SQLite (WAL mode)                    │   │
│  │  [buffers] [local_store] [secrets] [state] [config]   │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```
