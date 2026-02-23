import { describe, it, expect } from "bun:test";
import { Channel, Broadcaster } from "../../../src/core/channel.ts";

describe("Broadcaster", () => {
  it("3 consumers each receive all broadcast items", async () => {
    const b = new Broadcaster<number>();
    const ch1 = new Channel<number>({ capacity: 10 });
    const ch2 = new Channel<number>({ capacity: 10 });
    const ch3 = new Channel<number>({ capacity: 10 });

    b.addConsumer(ch1);
    b.addConsumer(ch2);
    b.addConsumer(ch3);

    for (let i = 0; i < 5; i++) {
      await b.broadcast(i, (v) => v);
    }
    b.closeAll();

    const drain = async (ch: Channel<number>): Promise<number[]> => {
      const items: number[] = [];
      for await (const item of ch.receive()) {
        items.push(item);
      }
      return items;
    };

    const [r1, r2, r3] = await Promise.all([drain(ch1), drain(ch2), drain(ch3)]);

    expect(r1).toEqual([0, 1, 2, 3, 4]);
    expect(r2).toEqual([0, 1, 2, 3, 4]);
    expect(r3).toEqual([0, 1, 2, 3, 4]);
  });

  it("broadcast uses copy function (consumers get independent copies, not references)", async () => {
    const b = new Broadcaster<{ value: number }>();
    const ch1 = new Channel<{ value: number }>({ capacity: 10 });
    const ch2 = new Channel<{ value: number }>({ capacity: 10 });

    b.addConsumer(ch1);
    b.addConsumer(ch2);

    const original = { value: 42 };
    await b.broadcast(original, (v) => ({ ...v }));
    b.closeAll();

    const gen1 = ch1.receive();
    const gen2 = ch2.receive();

    const item1 = (await gen1.next()).value!;
    const item2 = (await gen2.next()).value!;

    // Both have the correct value
    expect(item1.value).toBe(42);
    expect(item2.value).toBe(42);

    // But they are independent objects
    item1.value = 999;
    expect(item2.value).toBe(42);
    expect(original.value).toBe(42);
  });

  it("consumer A's channel full and dropping → consumer B and C unaffected", async () => {
    const b = new Broadcaster<number>();
    const chSmall = new Channel<number>({ capacity: 3 }); // will overflow
    const chLarge1 = new Channel<number>({ capacity: 100 });
    const chLarge2 = new Channel<number>({ capacity: 100 });

    b.addConsumer(chSmall);
    b.addConsumer(chLarge1);
    b.addConsumer(chLarge2);

    // Send 10 items — chSmall can only hold 3
    for (let i = 0; i < 10; i++) {
      await b.broadcast(i, (v) => v);
    }
    b.closeAll();

    const drain = async (ch: Channel<number>): Promise<number[]> => {
      const items: number[] = [];
      for await (const item of ch.receive()) {
        items.push(item);
      }
      return items;
    };

    const [small, large1, large2] = await Promise.all([
      drain(chSmall),
      drain(chLarge1),
      drain(chLarge2),
    ]);

    // Small channel only has last 3 (drop-oldest)
    expect(small).toEqual([7, 8, 9]);

    // Large channels have all 10
    expect(large1).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(large2).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("removeConsumer() stops delivery to that consumer", async () => {
    const b = new Broadcaster<number>();
    const ch1 = new Channel<number>({ capacity: 10 });
    const ch2 = new Channel<number>({ capacity: 10 });

    b.addConsumer(ch1);
    b.addConsumer(ch2);

    await b.broadcast(1, (v) => v);
    await b.broadcast(2, (v) => v);

    // Remove ch1 — it should stop receiving
    b.removeConsumer(ch1);

    await b.broadcast(3, (v) => v);
    await b.broadcast(4, (v) => v);

    ch1.close();
    ch2.close();

    const drain = async (ch: Channel<number>): Promise<number[]> => {
      const items: number[] = [];
      for await (const item of ch.receive()) {
        items.push(item);
      }
      return items;
    };

    const [r1, r2] = await Promise.all([drain(ch1), drain(ch2)]);

    expect(r1).toEqual([1, 2]); // only items before removal
    expect(r2).toEqual([1, 2, 3, 4]); // all items
  });

  it("closeAll() closes all consumer channels", async () => {
    const b = new Broadcaster<number>();
    const ch1 = new Channel<number>({ capacity: 10 });
    const ch2 = new Channel<number>({ capacity: 10 });
    const ch3 = new Channel<number>({ capacity: 10 });

    b.addConsumer(ch1);
    b.addConsumer(ch2);
    b.addConsumer(ch3);

    expect(ch1.closed).toBe(false);
    expect(ch2.closed).toBe(false);
    expect(ch3.closed).toBe(false);

    b.closeAll();

    expect(ch1.closed).toBe(true);
    expect(ch2.closed).toBe(true);
    expect(ch3.closed).toBe(true);
  });

  it("broadcast to zero consumers is a no-op (no error)", async () => {
    const b = new Broadcaster<number>();

    // Should not throw
    await b.broadcast(42, (v) => v);
  });
});
