import { describe, it, expect } from "bun:test";
import { Channel } from "../../../src/core/channel.ts";

describe("Channel", () => {
  it("send N items, receive N items in correct order (FIFO)", async () => {
    const ch = new Channel<number>({ capacity: 10 });

    for (let i = 0; i < 5; i++) {
      await ch.send(i);
    }
    ch.close();

    const received: number[] = [];
    for await (const item of ch.receive()) {
      received.push(item);
    }

    expect(received).toEqual([0, 1, 2, 3, 4]);
  });

  it("send capacity+5 items, receive only last capacity items (oldest dropped)", async () => {
    const capacity = 10;
    const ch = new Channel<number>({ capacity });

    // Send 15 items into a capacity-10 channel
    for (let i = 0; i < capacity + 5; i++) {
      await ch.send(i);
    }
    ch.close();

    const received: number[] = [];
    for await (const item of ch.receive()) {
      received.push(item);
    }

    // Should have last 10 items: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    expect(received.length).toBe(capacity);
    expect(received).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("close() → send() returns false", async () => {
    const ch = new Channel<number>({ capacity: 10 });
    ch.close();

    const result = await ch.send(42);
    expect(result).toBe(false);
  });

  it("close() → receive() drains remaining items then completes (done=true)", async () => {
    const ch = new Channel<number>({ capacity: 10 });

    await ch.send(1);
    await ch.send(2);
    await ch.send(3);
    ch.close();

    const received: number[] = [];
    for await (const item of ch.receive()) {
      received.push(item);
    }

    expect(received).toEqual([1, 2, 3]);

    // Generator should be done — next() returns done: true
    const gen = ch.receive();
    const result = await gen.next();
    expect(result.done).toBe(true);
  });

  it("receive() on empty open channel blocks until item sent", async () => {
    const ch = new Channel<number>({ capacity: 10 });
    let received: number | undefined;

    // Start receiver — it will block waiting for data
    const receiverDone = (async () => {
      for await (const item of ch.receive()) {
        received = item;
        break; // take one item and stop
      }
    })();

    // At this point the receiver is blocked waiting
    // Yield to let receiver set up its waiter
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toBeUndefined();

    // Now send — this should unblock the receiver
    await ch.send(42);
    await receiverDone;

    expect(received).toBe(42);
  });

  it("length property tracks current item count", async () => {
    const ch = new Channel<number>({ capacity: 10 });

    expect(ch.length).toBe(0);

    await ch.send(1);
    expect(ch.length).toBe(1);

    await ch.send(2);
    await ch.send(3);
    expect(ch.length).toBe(3);

    // Consume one item
    const gen = ch.receive();
    await gen.next();
    expect(ch.length).toBe(2);
  });

  it("capacity property returns configured capacity", () => {
    const ch1 = new Channel<number>({ capacity: 50 });
    expect(ch1.capacity).toBe(50);

    const ch2 = new Channel<number>();
    expect(ch2.capacity).toBe(1000); // default
  });

  it("closed property is false initially, true after close()", () => {
    const ch = new Channel<number>({ capacity: 10 });

    expect(ch.closed).toBe(false);
    ch.close();
    expect(ch.closed).toBe(true);
  });

  it("concurrent producer/consumer: producer sends 1000, consumer receives 1000", async () => {
    const ch = new Channel<number>({ capacity: 1000 });
    const received: number[] = [];

    // Start consumer
    const consumerDone = (async () => {
      for await (const item of ch.receive()) {
        received.push(item);
      }
    })();

    // Producer sends 1000 items
    for (let i = 0; i < 1000; i++) {
      await ch.send(i);
    }
    ch.close();

    await consumerDone;

    expect(received.length).toBe(1000);
    expect(received[0]).toBe(0);
    expect(received[999]).toBe(999);
  });

  it("capacity=1: every send to full channel replaces the single item", async () => {
    const ch = new Channel<number>({ capacity: 1 });

    await ch.send(1);
    expect(ch.length).toBe(1);

    await ch.send(2); // drops 1
    expect(ch.length).toBe(1);

    await ch.send(3); // drops 2
    ch.close();

    const received: number[] = [];
    for await (const item of ch.receive()) {
      received.push(item);
    }

    expect(received).toEqual([3]);
  });

  it("send-after-close returns false and buffered items are still receivable", async () => {
    const ch = new Channel<number>({ capacity: 10 });

    await ch.send(1);
    await ch.send(2);
    await ch.send(3);

    ch.close();

    // Send after close should return false
    const result = await ch.send(4);
    expect(result).toBe(false);

    // But buffered items should still be receivable
    const received: number[] = [];
    for await (const item of ch.receive()) {
      received.push(item);
    }

    expect(received).toEqual([1, 2, 3]);
  });

  it("overflow: 'block' throws (not implemented)", () => {
    expect(() => new Channel<number>({ capacity: 10, overflow: "block" })).toThrow(
      /not implemented/i,
    );
  });

  it("overflow: 'drop-oldest' is accepted explicitly", async () => {
    const ch = new Channel<number>({ capacity: 3, overflow: "drop-oldest" });

    await ch.send(1);
    await ch.send(2);
    await ch.send(3);
    await ch.send(4); // drops 1
    ch.close();

    const received: number[] = [];
    for await (const item of ch.receive()) {
      received.push(item);
    }

    expect(received).toEqual([2, 3, 4]);
  });
});
