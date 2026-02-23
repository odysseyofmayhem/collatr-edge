import { describe, it, expect } from "bun:test";
import {
  Ticker,
  alignToInterval,
  detectClockJump,
} from "../../../src/core/ticker.ts";

describe("Ticker", () => {
  it("100ms ticker fires ~10 times in 1100ms (tolerance: 8-12 ticks)", async () => {
    const ticker = new Ticker();
    let count = 0;

    const timeout = setTimeout(() => {}, 1200);
    const start = Date.now();

    for await (const _seq of ticker.tick(100, { aligned: false })) {
      count++;
      if (Date.now() - start >= 1100) break;
    }

    clearTimeout(timeout);
    expect(count).toBeGreaterThanOrEqual(8);
    expect(count).toBeLessThanOrEqual(12);
  });

  it("sequence numbers increment from 0", async () => {
    const ticker = new Ticker();
    const seqs: number[] = [];

    for await (const seq of ticker.tick(50, { aligned: false })) {
      seqs.push(seq);
      if (seqs.length >= 5) break;
    }

    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  it("ticker can be cancelled via break in for-await-of", async () => {
    const ticker = new Ticker();
    let count = 0;

    for await (const _seq of ticker.tick(50, { aligned: false })) {
      count++;
      if (count >= 3) break;
    }

    expect(count).toBe(3);
  });

  it("jitter: with 50ms jitter on 200ms interval, ticks are within [200, 250] spacing", async () => {
    const ticker = new Ticker();
    const times: number[] = [];

    for await (const _seq of ticker.tick(200, {
      jitter: 50,
      aligned: false,
    })) {
      times.push(Date.now());
      if (times.length >= 6) break;
    }

    // With anchor-based jitter, spacing = interval + jitter_new - jitter_old
    // Theoretical range: [interval - jitter, interval + jitter] = [150, 250]
    // With timer resolution tolerance: [140, 270]
    const spacings: number[] = [];
    for (let i = 1; i < times.length; i++) {
      spacings.push(times[i]! - times[i - 1]!);
    }

    for (const spacing of spacings) {
      expect(spacing).toBeGreaterThanOrEqual(140);
      expect(spacing).toBeLessThanOrEqual(270);
    }

    const avg = spacings.reduce((a, b) => a + b, 0) / spacings.length;
    expect(avg).toBeGreaterThanOrEqual(180);
    expect(avg).toBeLessThanOrEqual(260);
  });

  it("50 ticks at 50ms interval: total elapsed is 2500ms ±500ms (no drift accumulation)", async () => {
    const ticker = new Ticker();
    let count = 0;
    const start = Date.now();

    for await (const _seq of ticker.tick(50, { aligned: false })) {
      count++;
      if (count >= 50) break;
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThanOrEqual(3000);
  });

  it("alignToInterval helper: 10000ms interval, returns next boundary from epoch", () => {
    expect(alignToInterval(1700000001234, 10000)).toBe(1700000010000);
    expect(alignToInterval(1700000010000, 10000)).toBe(1700000010000);
    expect(alignToInterval(1700000010001, 10000)).toBe(1700000020000);
    expect(alignToInterval(1700000000500, 1000)).toBe(1700000001000);
    expect(alignToInterval(1700000000001, 300000)).toBe(1700000100000);
  });

  describe("aligned mode", () => {
    it("aligned ticks fire at clock boundaries (default mode)", async () => {
      const ticker = new Ticker();
      const interval = 200;
      const times: number[] = [];

      for await (const _seq of ticker.tick(interval, { aligned: true })) {
        times.push(Date.now());
        if (times.length >= 4) break;
      }

      // Each tick should fire near a multiple of interval from epoch
      for (const t of times) {
        const remainder = t % interval;
        // Allow 30ms tolerance for timer resolution
        const nearBoundary = remainder < 30 || remainder > interval - 30;
        expect(nearBoundary).toBe(true);
      }
    });
  });

  describe("offset", () => {
    it("offset delays ticks by the specified amount", async () => {
      const ticker = new Ticker();
      const interval = 200;
      const offsetMs = 50;
      const times: number[] = [];
      const start = Date.now();

      for await (const _seq of ticker.tick(interval, {
        aligned: false,
        offset: offsetMs,
      })) {
        times.push(Date.now() - start);
        if (times.length >= 3) break;
      }

      // First tick should be delayed by offset (~50ms from start)
      expect(times[0]!).toBeGreaterThanOrEqual(40);
      expect(times[0]!).toBeLessThanOrEqual(100);

      // Spacing between ticks should still be approximately interval
      const spacing = times[1]! - times[0]!;
      expect(spacing).toBeGreaterThanOrEqual(170);
      expect(spacing).toBeLessThanOrEqual(240);
    });
  });

  describe("clock jump detection", () => {
    it("no jump when wall and monotonic agree", () => {
      // Both clocks say 1000ms elapsed, interval 100ms
      expect(detectClockJump(1000, 1000, 100)).toBe(false);
    });

    it("no jump within 2x interval tolerance", () => {
      // Wall says 1000ms, mono says 1150ms — difference 150ms < 2*100=200ms
      expect(detectClockJump(1000, 1150, 100)).toBe(false);
      expect(detectClockJump(1150, 1000, 100)).toBe(false);
    });

    it("jump detected when clocks disagree by >2x interval", () => {
      // Wall says 1000ms, mono says 1300ms — difference 300ms > 200ms
      expect(detectClockJump(1000, 1300, 100)).toBe(true);
      // NTP correction: wall jumped forward, mono didn't
      expect(detectClockJump(5000, 1000, 100)).toBe(true);
      // Wall jumped backward (rare but possible with manual change)
      expect(detectClockJump(500, 5000, 100)).toBe(true);
    });

    it("threshold scales with interval", () => {
      // 10s interval: 2x = 20s. 15s difference → no jump
      expect(detectClockJump(25000, 10000, 10000)).toBe(false);
      // 25s difference → jump
      expect(detectClockJump(35000, 10000, 10000)).toBe(true);
    });
  });
});
