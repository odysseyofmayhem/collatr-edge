import { describe, it, expect } from "bun:test";
import { ChannelAccumulator } from "@core/accumulator";
import { Channel } from "@core/channel";
import type { Metric } from "@core/metric";

describe("Integration: Accumulator → Channel → consumer", () => {
  it("Accumulator addFields → Channel → consumer receives correct metric", async () => {
    const ch = new Channel<Metric>({ capacity: 100 });
    const acc = new ChannelAccumulator(ch);

    acc.addFields("temperature", { celsius: 23.5, humidity: 65 }, { sensor: "DHT22", zone: "A" });

    const receiver = ch.receive();
    const { value: metric } = await receiver.next();

    expect(metric).toBeDefined();
    expect(metric!.name).toBe("temperature");
    expect(metric!.getField("celsius")).toBe(23.5);
    expect(metric!.getField("humidity")).toBe(65);
    expect(metric!.getTag("sensor")).toBe("DHT22");
    expect(metric!.getTag("zone")).toBe("A");
    expect(metric!.fields.size).toBe(2);
    expect(metric!.tags.size).toBe(2);

    await receiver.return(undefined);
  });

  it("global tags present on received metric", async () => {
    const ch = new Channel<Metric>({ capacity: 100 });
    const globalTags = { host: "rpi-01", site: "factory-a", line: "3" };
    const acc = new ChannelAccumulator(ch, globalTags);

    acc.addFields("pressure", { psi: 14.7 }, { unit: "bar" });
    acc.addFields("vibration", { mm_s: 2.1 });

    const receiver = ch.receive();
    const { value: m1 } = await receiver.next();
    const { value: m2 } = await receiver.next();

    // First metric: global tags + local tag
    expect(m1!.getTag("host")).toBe("rpi-01");
    expect(m1!.getTag("site")).toBe("factory-a");
    expect(m1!.getTag("line")).toBe("3");
    expect(m1!.getTag("unit")).toBe("bar");
    expect(m1!.tags.size).toBe(4);

    // Second metric: global tags only (no local tags provided)
    expect(m2!.getTag("host")).toBe("rpi-01");
    expect(m2!.getTag("site")).toBe("factory-a");
    expect(m2!.getTag("line")).toBe("3");
    expect(m2!.tags.size).toBe(3);

    await receiver.return(undefined);
  });

  it("auto-timestamp is reasonable (within last few seconds)", async () => {
    const ch = new Channel<Metric>({ capacity: 100 });
    const acc = new ChannelAccumulator(ch);

    const beforeNs = BigInt(Date.now()) * 1_000_000n;
    acc.addFields("cpu", { usage_percent: 42 });
    const afterNs = BigInt(Date.now()) * 1_000_000n;

    const receiver = ch.receive();
    const { value: metric } = await receiver.next();

    // Timestamp should be nanoseconds within the before/after window
    expect(metric!.timestamp).toBeGreaterThanOrEqual(beforeNs);
    expect(metric!.timestamp).toBeLessThanOrEqual(afterNs);

    // Sanity: should be a reasonable epoch time (after 2024-01-01 in nanoseconds)
    const jan2024ns = BigInt(new Date("2024-01-01").getTime()) * 1_000_000n;
    expect(metric!.timestamp).toBeGreaterThan(jan2024ns);

    // Should be within 5 seconds of "now" (generous tolerance for CI)
    const fiveSecondsNs = 5_000_000_000n;
    expect(afterNs - metric!.timestamp).toBeLessThan(fiveSecondsNs);

    await receiver.return(undefined);
  });
});
