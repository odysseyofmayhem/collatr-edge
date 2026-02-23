// CollatrEdge — Channel<T> async primitive
// PRD ref: §4 Architecture Overview

export type OverflowPolicy = "drop-oldest" | "block";

export interface ChannelOptions {
  /** Maximum items the channel can buffer. Default: 1000 */
  capacity: number;
  /** Behaviour when channel is full. MVP: drop-oldest only. Default: 'drop-oldest' */
  overflow: OverflowPolicy;
}

export class Channel<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private count = 0;
  private _capacity: number;
  private _overflow: OverflowPolicy;
  private _closed = false;
  private waiters: Array<() => void> = [];

  constructor(options?: Partial<ChannelOptions>) {
    this._capacity = options?.capacity ?? 1000;
    this._overflow = options?.overflow ?? "drop-oldest";
    if (this._overflow === "block") {
      throw new Error(
        'Channel overflow policy "block" is not implemented (post-MVP). Use "drop-oldest".',
      );
    }
    this.buffer = new Array(this._capacity);
  }

  async send(value: T): Promise<boolean> {
    if (this._closed) return false;

    if (this.count === this._capacity) {
      // Drop oldest: advance head, discard oldest item
      this.buffer[this.head] = undefined;
      this.head = (this.head + 1) % this._capacity;
      this.count--;
    }

    this.buffer[this.tail] = value;
    this.tail = (this.tail + 1) % this._capacity;
    this.count++;

    // Wake one waiting receiver
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter();
    }

    return true;
  }

  async *receive(): AsyncGenerator<T, void, undefined> {
    while (true) {
      while (this.count === 0) {
        if (this._closed) return;
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
      }

      const value = this.buffer[this.head]!;
      this.buffer[this.head] = undefined; // allow GC
      this.head = (this.head + 1) % this._capacity;
      this.count--;

      yield value;
    }
  }

  close(): void {
    this._closed = true;
    // Wake all waiting receivers so they can see closed state and complete
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters = [];
  }

  get length(): number {
    return this.count;
  }

  get capacity(): number {
    return this._capacity;
  }

  get closed(): boolean {
    return this._closed;
  }
}

export class Broadcaster<T> {
  private consumers: Set<Channel<T>> = new Set();

  addConsumer(channel: Channel<T>): void {
    this.consumers.add(channel);
  }

  removeConsumer(channel: Channel<T>): void {
    this.consumers.delete(channel);
  }

  async broadcast(value: T, copy: (v: T) => T): Promise<void> {
    for (const channel of this.consumers) {
      await channel.send(copy(value));
    }
  }

  closeAll(): void {
    for (const channel of this.consumers) {
      channel.close();
    }
  }
}
