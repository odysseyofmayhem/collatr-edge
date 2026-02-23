// CollatrEdge — Ticker with dual-clock design
// PRD ref: §13 Scheduling

export interface TickerOptions {
  /** Fire at clock-aligned boundaries (e.g., :00, :10, :20 for 10s interval) */
  aligned?: boolean;
  /** Max random delay in ms added per tick (prevents thundering herd) */
  jitter?: number;
  /** Fixed delay in ms from interval boundary */
  offset?: number;
}

/**
 * Returns the next clock-aligned boundary for the given interval.
 * e.g., alignToInterval(1700000001234, 10000) → 1700000010000
 */
export function alignToInterval(now: number, interval: number): number {
  return Math.ceil(now / interval) * interval;
}

export class Ticker {
  /**
   * Async generator that fires on a configurable interval.
   * Yields incrementing sequence numbers starting from 0.
   *
   * Uses dual-clock design:
   * - Bun.nanoseconds() (monotonic) for elapsed time tracking
   * - Date.now() (wall clock) for alignment and scheduling
   *
   * Anchor-based: each tick calculated from anchor, not previous tick.
   * Eliminates drift accumulation.
   */
  async *tick(
    interval: number,
    opts?: TickerOptions,
  ): AsyncGenerator<number, void, undefined> {
    const jitterMax = opts?.jitter ?? 0;
    const offset = opts?.offset ?? 0;
    const aligned = opts?.aligned ?? false;

    let anchor = aligned
      ? alignToInterval(Date.now(), interval)
      : Date.now();
    let monotonicAnchor = Bun.nanoseconds();
    let seq = 0;

    while (true) {
      const target =
        anchor + seq * interval + offset + randomJitter(jitterMax);
      const delay = target - Date.now();

      // Clock jump detection: monotonic vs wall clock disagree by >2x interval
      const monoElapsedMs =
        Number(Bun.nanoseconds() - monotonicAnchor) / 1_000_000;
      const expectedElapsedMs = seq * interval;
      if (
        seq > 0 &&
        Math.abs(monoElapsedMs - expectedElapsedMs) > interval * 2
      ) {
        anchor = aligned
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

function randomJitter(max: number): number {
  if (max <= 0) return 0;
  return Math.random() * max;
}
