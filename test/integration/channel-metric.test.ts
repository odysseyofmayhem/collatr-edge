import { describe, it, expect } from "bun:test";
import { Channel, Broadcaster } from "../../src/core/channel.ts";
import { createMetric, type Metric } from "../../src/core/metric.ts";

describe("Channel<Metric> + Broadcaster<Metric> integration", () => {
  it("100 metrics through Channel<Metric> — all fields/tags/timestamps preserved", async () => {
    const ch = new Channel<Metric>({ capacity: 200 });

    // Send 100 metrics with varied data
    for (let i = 0; i < 100; i++) {
      const m = createMetric({
        name: `sensor_${i % 5}`,
        fields: {
          temperature: 20 + i * 0.1,
          count: BigInt(i),
          status: i % 2 === 0 ? "ok" : "warn",
          active: i % 3 !== 0,
        },
        tags: {
          device: `dev-${i % 10}`,
          line: `line-${i % 3}`,
        },
        timestamp: BigInt(1700000000000 + i) * 1_000_000n,
      });
      await ch.send(m);
    }
    ch.close();

    const received: Metric[] = [];
    for await (const m of ch.receive()) {
      received.push(m);
    }

    expect(received.length).toBe(100);

    // Verify a sample metric's full data integrity
    const m42 = received[42]!;
    expect(m42.name).toBe("sensor_2"); // 42 % 5 = 2
    expect(m42.getField("temperature")).toBe(20 + 42 * 0.1);
    expect(m42.getField("count")).toBe(42n);
    expect(m42.getField("status")).toBe("ok"); // 42 % 2 = 0
    expect(m42.getField("active")).toBe(false); // 42 % 3 = 0 → i % 3 !== 0 → false
    expect(m42.getTag("device")).toBe("dev-2"); // 42 % 10 = 2
    expect(m42.getTag("line")).toBe("line-0"); // 42 % 3 = 0
    expect(m42.timestamp).toBe(BigInt(1700000000000 + 42) * 1_000_000n);
  });

  it("Broadcaster copies to 2 consumers — mutating one consumer's metric doesn't affect the other's", async () => {
    const broadcaster = new Broadcaster<Metric>();
    const ch1 = new Channel<Metric>({ capacity: 10 });
    const ch2 = new Channel<Metric>({ capacity: 10 });

    broadcaster.addConsumer(ch1);
    broadcaster.addConsumer(ch2);

    const original = createMetric({
      name: "motor_speed",
      fields: { rpm: 1500, voltage: 230.5 },
      tags: { motor: "M1", area: "press" },
      timestamp: 1700000000000000000n,
    });

    await broadcaster.broadcast(original, (m) => m.copy());
    broadcaster.closeAll();

    // Drain both channels
    const gen1 = ch1.receive();
    const gen2 = ch2.receive();
    const item1 = (await gen1.next()).value!;
    const item2 = (await gen2.next()).value!;

    // Both have correct data
    expect(item1.name).toBe("motor_speed");
    expect(item2.name).toBe("motor_speed");
    expect(item1.getField("rpm")).toBe(1500);
    expect(item2.getField("rpm")).toBe(1500);

    // Mutate consumer 1's copy
    item1.addField("rpm", 9999);
    item1.addTag("motor", "CHANGED");

    // Consumer 2's copy is unaffected
    expect(item2.getField("rpm")).toBe(1500);
    expect(item2.getTag("motor")).toBe("M1");

    // Original is also unaffected
    expect(original.getField("rpm")).toBe(1500);
    expect(original.getTag("motor")).toBe("M1");
  });

  it("hashId() is identical before send and after receive", async () => {
    const ch = new Channel<Metric>({ capacity: 10 });

    const m = createMetric({
      name: "vibration",
      fields: { x: 0.5, y: 1.2, z: -0.3 },
      tags: { sensor: "vib-01", location: "bearing-A" },
    });

    const hashBefore = m.hashId();
    await ch.send(m);
    ch.close();

    const gen = ch.receive();
    const received = (await gen.next()).value!;
    const hashAfter = received.hashId();

    expect(hashAfter).toBe(hashBefore);
  });
});
