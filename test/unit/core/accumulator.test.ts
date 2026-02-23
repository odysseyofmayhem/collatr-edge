import { describe, it, expect } from "bun:test";
import { ChannelAccumulator } from "@core/accumulator";
import { Channel } from "@core/channel";
import { createMetric, type Metric } from "@core/metric";

describe("ChannelAccumulator", () => {
  it("addFields() creates metric with correct name, fields, tags in channel", async () => {
    const ch = new Channel<Metric>({ capacity: 10 });
    const acc = new ChannelAccumulator(ch);

    acc.addFields("temperature", { value: 25.5 }, { sensor: "A1" });

    // Drain one item from channel
    const receiver = ch.receive();
    const { value: metric } = await receiver.next();
    expect(metric).toBeDefined();
    expect(metric!.name).toBe("temperature");
    expect(metric!.getField("value")).toBe(25.5);
    expect(metric!.getTag("sensor")).toBe("A1");
    await receiver.return(undefined);
  });

  it("addFields() auto-assigns nanosecond timestamp when not provided", async () => {
    const ch = new Channel<Metric>({ capacity: 10 });
    const acc = new ChannelAccumulator(ch);

    const before = BigInt(Date.now()) * 1_000_000n;
    acc.addFields("cpu", { usage: 42 });
    const after = BigInt(Date.now()) * 1_000_000n;

    const receiver = ch.receive();
    const { value: metric } = await receiver.next();
    expect(metric!.timestamp).toBeGreaterThanOrEqual(before);
    expect(metric!.timestamp).toBeLessThanOrEqual(after);
    await receiver.return(undefined);
  });

  it("addFields() uses explicit timestamp when provided (does not overwrite)", async () => {
    const ch = new Channel<Metric>({ capacity: 10 });
    const acc = new ChannelAccumulator(ch);

    const explicitTs = 1234567890_000_000_000n;
    acc.addFields("cpu", { usage: 42 }, undefined, explicitTs);

    const receiver = ch.receive();
    const { value: metric } = await receiver.next();
    expect(metric!.timestamp).toBe(explicitTs);
    await receiver.return(undefined);
  });

  it("addFields() merges global tags with local tags", async () => {
    const ch = new Channel<Metric>({ capacity: 10 });
    const acc = new ChannelAccumulator(ch, { host: "rpi-01", site: "factory-a" });

    acc.addFields("temperature", { value: 22 }, { zone: "north" });

    const receiver = ch.receive();
    const { value: metric } = await receiver.next();
    expect(metric!.getTag("host")).toBe("rpi-01");
    expect(metric!.getTag("site")).toBe("factory-a");
    expect(metric!.getTag("zone")).toBe("north");
    await receiver.return(undefined);
  });

  it("addFields() local tag wins on conflict with global tag", async () => {
    const ch = new Channel<Metric>({ capacity: 10 });
    const acc = new ChannelAccumulator(ch, { host: "rpi-01", env: "production" });

    acc.addFields("temperature", { value: 22 }, { env: "staging" });

    const receiver = ch.receive();
    const { value: metric } = await receiver.next();
    // Per-metric tag should override global tag
    expect(metric!.getTag("env")).toBe("staging");
    // Non-conflicting global tag still present
    expect(metric!.getTag("host")).toBe("rpi-01");
    await receiver.return(undefined);
  });

  it("addMetric() sends metric to channel unmodified", async () => {
    const ch = new Channel<Metric>({ capacity: 10 });
    const acc = new ChannelAccumulator(ch);

    const original = createMetric({
      name: "pressure",
      fields: { psi: 14.7 },
      tags: { unit: "bar" },
      timestamp: 9999n,
      type: "gauge",
      priority: "high",
    });

    acc.addMetric(original);

    const receiver = ch.receive();
    const { value: received } = await receiver.next();
    // Should be the exact same object reference (unmodified, not copied)
    expect(received).toBe(original);
    expect(received!.name).toBe("pressure");
    expect(received!.getField("psi")).toBe(14.7);
    expect(received!.getTag("unit")).toBe("bar");
    expect(received!.timestamp).toBe(9999n);
    expect(received!.type).toBe("gauge");
    expect(received!.priority).toBe("high");
    await receiver.return(undefined);
  });

  it("addError() increments error count", () => {
    const ch = new Channel<Metric>({ capacity: 10 });
    const acc = new ChannelAccumulator(ch);

    expect(acc.errorCount).toBe(0);
    acc.addError(new Error("connection timeout"));
    expect(acc.errorCount).toBe(1);
    acc.addError(new Error("parse failure"));
    expect(acc.errorCount).toBe(2);
    acc.addError(new Error("another error"));
    expect(acc.errorCount).toBe(3);
  });

  it("addError() does not throw", () => {
    const ch = new Channel<Metric>({ capacity: 10 });
    const acc = new ChannelAccumulator(ch);

    // Suppress logger output during this test
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    expect(() => acc.addError(new Error("should not throw"))).not.toThrow();
    expect(() => acc.addError(new Error("even with weird chars: \0\n\t"))).not.toThrow();
    expect(() => acc.addError(new Error(""))).not.toThrow();

    process.stderr.write = originalWrite;
  });

  it("multiple addFields() calls produce multiple metrics in channel", async () => {
    const ch = new Channel<Metric>({ capacity: 100 });
    const acc = new ChannelAccumulator(ch);

    acc.addFields("temp", { value: 20 });
    acc.addFields("temp", { value: 21 });
    acc.addFields("pressure", { value: 1013 });
    acc.addFields("humidity", { value: 65 });

    expect(ch.length).toBe(4);

    const receiver = ch.receive();
    const { value: m1 } = await receiver.next();
    const { value: m2 } = await receiver.next();
    const { value: m3 } = await receiver.next();
    const { value: m4 } = await receiver.next();

    expect(m1!.name).toBe("temp");
    expect(m1!.getField("value")).toBe(20);
    expect(m2!.name).toBe("temp");
    expect(m2!.getField("value")).toBe(21);
    expect(m3!.name).toBe("pressure");
    expect(m3!.getField("value")).toBe(1013);
    expect(m4!.name).toBe("humidity");
    expect(m4!.getField("value")).toBe(65);

    await receiver.return(undefined);
  });
});
