## 13. Scheduling

### Ticker

Each polling input gets its own `Ticker` instance — an `AsyncGenerator` that fires on a configurable interval with drift correction:

```typescript
class Ticker {
  async *tick(interval: number, opts?: TickerOptions): AsyncGenerator<number> {
    let anchor = opts?.aligned
      ? alignToInterval(Date.now(), interval)
      : Date.now();
    let monotonicAnchor = Bun.nanoseconds();
    let seq = 0;

    while (true) {
      const elapsed = Number(Bun.nanoseconds() - monotonicAnchor) / 1_000_000;
      const target = anchor
        + (seq * interval)
        + (opts?.offset ?? 0)
        + randomJitter(opts?.jitter ?? 0);
      const delay = target - Date.now();

      // Clock change detection: if wall clock and monotonic clock disagree
      // by more than 2x the interval, the system clock has jumped.
      const expectedElapsed = seq * interval;
      if (Math.abs(elapsed - expectedElapsed) > interval * 2) {
        log.warn('System clock change detected, re-anchoring Ticker');
        anchor = opts?.aligned
          ? alignToInterval(Date.now(), interval)
          : Date.now();
        monotonicAnchor = Bun.nanoseconds();
        seq = 0;
        continue;
      }

      if (delay > 0) await Bun.sleep(delay);
      yield seq++;
    }
  }
}
```

- **Dual-clock design:** `Bun.nanoseconds()` (monotonic) tracks elapsed time; `Date.now()` (wall clock) handles alignment. If they diverge beyond 2× the interval, the clock has jumped and the ticker re-anchors.
- **Anchor-based:** Each tick is calculated from the anchor, not from the previous tick. Eliminates drift accumulation.
- **Clock jump handling:** NTP sync, manual time changes, and daylight saving transitions are detected and handled by re-anchoring. No missed ticks, no bunched ticks. A warning is logged for visibility.
- **Aligned mode (default):** Fires at clock-aligned boundaries (e.g., :00, :10, :20 for 10s interval). Important for correlating data across devices.
- **Unaligned mode:** Fires relative to process start time. Per-input override via `round_interval = false`.
- **Jitter:** Random delay added to each collection. Prevents thundering herd on shared buses (Modbus RS-485) and on the event loop.
- **Offset:** Fixed delay from interval boundary. Manual scheduling control.

### Gather Behaviour

- Each input runs its own `Ticker` + `gather()` loop
- If `gather()` takes longer than `timeout`, it is killed and a timeout error is logged
- If `gather()` takes longer than `interval`, the next scheduled collection is **skipped** (not queued) — prevents cascading delays
- Each `gather()` call is wrapped in try/catch — one plugin's error never crashes the agent

### Service Inputs

Push-based inputs (MQTT subscriber, HTTP listener) don't use tickers. They call `start(acc)` and push metrics whenever they arrive. Stopped via `stop()`.

### Post-MVP: Cron & Deadband

- **Cron-style scheduling:** `Ticker` interface is generic enough to accept a cron expression as an alternative to fixed intervals. Useful for "collect at shift change" scenarios.
- **Adaptive intervals / deadband:** `Ticker` accepts a `shouldSkip()` callback. If the last gathered values haven't changed, the next collection can be skipped or delayed. Reduces bus traffic on shared RS-485 networks.
