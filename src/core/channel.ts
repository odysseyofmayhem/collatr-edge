// CollatrEdge — Channel<T> async primitive
// PRD ref: §4 Architecture Overview

export interface ChannelOptions {
  capacity: number;
}

export class Channel<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private count = 0;
  private _capacity: number;
  private _closed = false;
  private waiters: Array<() => void> = [];

  constructor(options?: Partial<ChannelOptions>) {
    this._capacity = options?.capacity ?? 1000;
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
