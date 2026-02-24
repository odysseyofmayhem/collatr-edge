// CollatrEdge — Ticker with dual-clock design
// PRD ref: §13 Scheduling

import { getLogger } from "./logger";

export interface TickerOptions {
  /** Fire at clock-aligned boundaries (e.g., :00, :10, :20 for 10s interval). Default: true per PRD §13 */
  aligned?: boolean;
  /** Max random delay in ms added per tick (prevents thundering herd) */
  jitter?: number;
  /** Fixed delay in ms from interval boundary */
  offset?: number;
}

/**
 * Returns the next clock-aligned boundary for the given interval.
 * e.g., alignToInterval(1700000001234, 10000) → 1700000010000
 *
 * When `now` is exactly on a boundary, returns that boundary (fire immediately).
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
   * - Bun.nanoseconds() (monotonic) for clock jump detection
   * - Date.now() (wall clock) for alignment and scheduling
   *
   * Clock jump detection (PRD §13): if wall clock and monotonic clock
   * disagree by more than 2x the interval, the system clock has jumped
   * (NTP correction, manual change, DST). The ticker re-anchors.
   *
   * NOTE: PRD §13 pseudocode compares monotonic vs expected elapsed time,
   * but the prose says "wall clock and monotonic clock disagree". The prose
   * is authoritative (CLAUDE.md Rule 5). This implementation follows the prose.
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
    const aligned = opts?.aligned ?? true; // PRD §13: "Aligned mode (default)"

    let anchor = aligned
      ? alignToInterval(Date.now(), interval)
      : Date.now();
    let monotonicAnchor = Bun.nanoseconds();
    let seq = 0;

    while (true) {
      const target =
        anchor + seq * interval + offset + randomJitter(jitterMax);
      const delay = target - Date.now();

      // Clock jump detection: compare wall-clock elapsed vs monotonic elapsed.
      // If they disagree by >2x interval, the system clock has jumped.
      const wallElapsedMs = Date.now() - anchor;
      const monoElapsedMs =
        Number(Bun.nanoseconds() - monotonicAnchor) / 1_000_000;
      if (seq > 0 && detectClockJump(wallElapsedMs, monoElapsedMs, interval)) {
        getLogger().warn("system clock change detected, re-anchoring ticker", {
          component: "ticker",
          wall_elapsed_ms: Math.round(wallElapsedMs),
          mono_elapsed_ms: Math.round(monoElapsedMs),
          interval_ms: interval,
        });
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

/**
 * Detect a system clock jump by comparing wall-clock elapsed time
 * against monotonic elapsed time. If they disagree by more than
 * 2x the interval, the system clock has jumped.
 *
 * Exported for testability (PRD §13, Rule 9).
 */
export function detectClockJump(
  wallElapsedMs: number,
  monoElapsedMs: number,
  interval: number,
): boolean {
  return Math.abs(wallElapsedMs - monoElapsedMs) > interval * 2;
}
