import { describe, it, expect } from "bun:test";
import {
  ModbusInput,
  ModbusConfigSchema,
  ModbusRegisterSchema,
  decodeMultiRegister,
  groupIntoBatches,
  type ModbusClient,
  type ModbusConfig,
} from "@plugins/inputs/modbus";
import type { Accumulator } from "@core/accumulator";
import type { FieldValue, Metric } from "@core/metric";
import { createMetric } from "@core/metric";

// ---------------------------------------------------------------------------
// Mock Modbus client
// ---------------------------------------------------------------------------

class MockModbusClient implements ModbusClient {
  currentSlaveId = 1;
  timeoutMs = 5000;
  private _isOpen = false;

  // Test data: slaveId → address → 16-bit register value
  holdingRegisters = new Map<number, Map<number, number>>();
  inputRegisters = new Map<number, Map<number, number>>();
  coils = new Map<number, Map<number, boolean>>();
  discreteInputs = new Map<number, Map<number, boolean>>();

  // Track calls for assertions
  readCalls: { method: string; slaveId: number; address: number; count: number }[] = [];
  connectCalls: { host: string; port: number }[] = [];

  // Simulate errors: "method:slaveId:address" → Error
  throwOnRead = new Map<string, Error>();
  // Simulate connection drop after N reads
  disconnectAfterReads = -1;
  private readCount = 0;
  // Simulate connection failure
  connectShouldFail = false;

  async connectTCP(host: string, options: { port: number }): Promise<void> {
    this.connectCalls.push({ host, port: options.port });
    if (this.connectShouldFail) throw new Error("connection refused");
    this._isOpen = true;
  }

  setID(id: number): void { this.currentSlaveId = id; }
  setTimeout(ms: number): void { this.timeoutMs = ms; }
  get isOpen(): boolean { return this._isOpen; }

  close(_cb?: () => void): void {
    this._isOpen = false;
  }

  // -- Helpers to set up test data --

  setHolding(slaveId: number, address: number, value: number): void {
    if (!this.holdingRegisters.has(slaveId)) this.holdingRegisters.set(slaveId, new Map());
    this.holdingRegisters.get(slaveId)!.set(address, value);
  }

  setInput(slaveId: number, address: number, value: number): void {
    if (!this.inputRegisters.has(slaveId)) this.inputRegisters.set(slaveId, new Map());
    this.inputRegisters.get(slaveId)!.set(address, value);
  }

  setCoil(slaveId: number, address: number, value: boolean): void {
    if (!this.coils.has(slaveId)) this.coils.set(slaveId, new Map());
    this.coils.get(slaveId)!.set(address, value);
  }

  setDiscrete(slaveId: number, address: number, value: boolean): void {
    if (!this.discreteInputs.has(slaveId)) this.discreteInputs.set(slaveId, new Map());
    this.discreteInputs.get(slaveId)!.set(address, value);
  }

  // -- Read methods --

  private checkConnectionAndErrors(method: string, address: number): void {
    this.readCount++;
    if (this.disconnectAfterReads > 0 && this.readCount > this.disconnectAfterReads) {
      this._isOpen = false;
      const err = new Error("Port Not Open") as Error & { errno: string };
      err.errno = "ECONNRESET";
      throw err;
    }
    const errorKey = `${method}:${this.currentSlaveId}:${address}`;
    const error = this.throwOnRead.get(errorKey);
    if (error) throw error;
  }

  async readHoldingRegisters(address: number, count: number): Promise<{ data: number[]; buffer: Buffer }> {
    this.readCalls.push({ method: "FC03", slaveId: this.currentSlaveId, address, count });
    this.checkConnectionAndErrors("FC03", address);

    const slaveRegs = this.holdingRegisters.get(this.currentSlaveId) ?? new Map();
    const data: number[] = [];
    const bytes: number[] = [];
    for (let i = 0; i < count; i++) {
      const val = slaveRegs.get(address + i) ?? 0;
      data.push(val);
      bytes.push((val >> 8) & 0xFF, val & 0xFF);
    }
    return { data, buffer: Buffer.from(bytes) };
  }

  async readInputRegisters(address: number, count: number): Promise<{ data: number[]; buffer: Buffer }> {
    this.readCalls.push({ method: "FC04", slaveId: this.currentSlaveId, address, count });
    this.checkConnectionAndErrors("FC04", address);

    const slaveRegs = this.inputRegisters.get(this.currentSlaveId) ?? new Map();
    const data: number[] = [];
    const bytes: number[] = [];
    for (let i = 0; i < count; i++) {
      const val = slaveRegs.get(address + i) ?? 0;
      data.push(val);
      bytes.push((val >> 8) & 0xFF, val & 0xFF);
    }
    return { data, buffer: Buffer.from(bytes) };
  }

  async readCoils(address: number, count: number): Promise<{ data: boolean[]; buffer: Buffer }> {
    this.readCalls.push({ method: "FC01", slaveId: this.currentSlaveId, address, count });
    this.checkConnectionAndErrors("FC01", address);

    const slaveCoils = this.coils.get(this.currentSlaveId) ?? new Map();
    const data: boolean[] = [];
    for (let i = 0; i < count; i++) {
      data.push(slaveCoils.get(address + i) ?? false);
    }
    // Build buffer for coils (packed bits)
    const byteCount = Math.ceil(count / 8);
    const buf = Buffer.alloc(byteCount);
    for (let i = 0; i < count; i++) {
      if (data[i]) buf[Math.floor(i / 8)] |= 1 << (i % 8);
    }
    return { data, buffer: buf };
  }

  async readDiscreteInputs(address: number, count: number): Promise<{ data: boolean[]; buffer: Buffer }> {
    this.readCalls.push({ method: "FC02", slaveId: this.currentSlaveId, address, count });
    this.checkConnectionAndErrors("FC02", address);

    const slaveDI = this.discreteInputs.get(this.currentSlaveId) ?? new Map();
    const data: boolean[] = [];
    for (let i = 0; i < count; i++) {
      data.push(slaveDI.get(address + i) ?? false);
    }
    const byteCount = Math.ceil(count / 8);
    const buf = Buffer.alloc(byteCount);
    for (let i = 0; i < count; i++) {
      if (data[i]) buf[Math.floor(i / 8)] |= 1 << (i % 8);
    }
    return { data, buffer: buf };
  }
}

// ---------------------------------------------------------------------------
// Collecting accumulator (captures emitted metrics)
// ---------------------------------------------------------------------------

class CollectingAcc implements Accumulator {
  metrics: { name: string; fields: Record<string, FieldValue>; tags: Record<string, string> }[] = [];
  errors: Error[] = [];

  addFields(measurement: string, fields: Record<string, FieldValue>, tags?: Record<string, string>): void {
    this.metrics.push({ name: measurement, fields: { ...fields }, tags: { ...(tags ?? {}) } });
  }
  addMetric(_metric: Metric): void { /* not used by inputs */ }
  addError(error: Error): void { this.errors.push(error); }
}

// ---------------------------------------------------------------------------
// Helper to create a ModbusInput with mock client
// ---------------------------------------------------------------------------

function createTestInput(
  configOverrides: Partial<ModbusConfig> = {},
  client?: MockModbusClient,
): { input: ModbusInput; client: MockModbusClient; acc: CollectingAcc } {
  const mockClient = client ?? new MockModbusClient();
  const config: ModbusConfig = {
    controller: "tcp://192.168.1.100:502",
    connection_mode: "dedicated",
    slave_id: 1,
    byte_order: "ABCD",
    optimization: "batch",
    max_batch_size: 125,
    max_gap: 10,
    timeout: "5s",
    ...configOverrides,
  };
  const input = new ModbusInput(config, mockClient);
  return { input, client: mockClient, acc: new CollectingAcc() };
}

// ---------------------------------------------------------------------------
// Float32 test values
// ---------------------------------------------------------------------------

// Compute the exact IEEE 754 representation of 100.5
const FLOAT_TEST_VALUE = 100.5;
const FLOAT_BUF = new ArrayBuffer(4);
const FLOAT_VIEW = new DataView(FLOAT_BUF);
FLOAT_VIEW.setFloat32(0, FLOAT_TEST_VALUE, false); // big-endian
const FLOAT_BYTES = new Uint8Array(FLOAT_BUF);
// Registers for each byte order
const FLOAT_REG0_ABCD = (FLOAT_BYTES[0]! << 8) | FLOAT_BYTES[1]!;
const FLOAT_REG1_ABCD = (FLOAT_BYTES[2]! << 8) | FLOAT_BYTES[3]!;
const FLOAT_REG0_CDAB = FLOAT_REG1_ABCD;
const FLOAT_REG1_CDAB = FLOAT_REG0_ABCD;
const FLOAT_REG0_BADC = (FLOAT_BYTES[1]! << 8) | FLOAT_BYTES[0]!;
const FLOAT_REG1_BADC = (FLOAT_BYTES[3]! << 8) | FLOAT_BYTES[2]!;
const FLOAT_REG0_DCBA = FLOAT_REG1_BADC;
const FLOAT_REG1_DCBA = FLOAT_REG0_BADC;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModbusInput", () => {
  // ── FC03: Read holding register ────────────────────────────────────────

  it("read single holding register (FC03) → correct numeric value", async () => {
    const { input, client, acc } = createTestInput({
      registers: [{ address: 100, name: "temperature", type: "holding", data_type: "uint16", scale: 0.1, offset: 0 }],
    });
    client.setHolding(1, 100, 255); // raw 255 * 0.1 = 25.5
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.name).toBe("temperature");
    expect(acc.metrics[0]!.fields.value).toBeCloseTo(25.5);
    expect(acc.metrics[0]!.tags.slave_id).toBe("1");
  });

  // ── FC01: Read coil ────────────────────────────────────────────────────

  it("read coil (FC01) → boolean value", async () => {
    const { input, client, acc } = createTestInput({
      registers: [
        { address: 0, name: "motor_on", type: "coil", data_type: "bool", scale: 1, offset: 0 },
        { address: 1, name: "alarm", type: "coil", data_type: "bool", scale: 1, offset: 0 },
      ],
    });
    client.setCoil(1, 0, true);
    client.setCoil(1, 1, false);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(2);
    expect(acc.metrics[0]!.name).toBe("motor_on");
    expect(acc.metrics[0]!.fields.value).toBe(true);
    expect(acc.metrics[1]!.name).toBe("alarm");
    expect(acc.metrics[1]!.fields.value).toBe(false);
  });

  // ── FC04: Read input register ──────────────────────────────────────────

  it("read input register (FC04) → correct value", async () => {
    const { input, client, acc } = createTestInput({
      registers: [{ address: 30001, name: "pressure", type: "input", data_type: "uint16", scale: 1, offset: 0 }],
    });
    client.setInput(1, 30001, 1024);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.name).toBe("pressure");
    expect(acc.metrics[0]!.fields.value).toBe(1024);
  });

  // ── Float32 byte orders ────────────────────────────────────────────────

  it("float32 with ABCD byte order → correct float value", async () => {
    const { input, client, acc } = createTestInput({
      byte_order: "ABCD",
      registers: [{ address: 100, name: "flow", type: "holding", data_type: "float32", scale: 1, offset: 0 }],
    });
    client.setHolding(1, 100, FLOAT_REG0_ABCD);
    client.setHolding(1, 101, FLOAT_REG1_ABCD);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.fields.value).toBeCloseTo(FLOAT_TEST_VALUE, 2);
  });

  it("float32 with CDAB byte order → correct float value (word-swapped)", async () => {
    const { input, client, acc } = createTestInput({
      byte_order: "CDAB",
      registers: [{ address: 100, name: "flow", type: "holding", data_type: "float32", scale: 1, offset: 0 }],
    });
    client.setHolding(1, 100, FLOAT_REG0_CDAB);
    client.setHolding(1, 101, FLOAT_REG1_CDAB);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.fields.value).toBeCloseTo(FLOAT_TEST_VALUE, 2);
  });

  it("float32 with BADC byte order → correct float value", async () => {
    const { input, client, acc } = createTestInput({
      byte_order: "BADC",
      registers: [{ address: 100, name: "flow", type: "holding", data_type: "float32", scale: 1, offset: 0 }],
    });
    client.setHolding(1, 100, FLOAT_REG0_BADC);
    client.setHolding(1, 101, FLOAT_REG1_BADC);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.fields.value).toBeCloseTo(FLOAT_TEST_VALUE, 2);
  });

  it("float32 with DCBA byte order → correct float value", async () => {
    const { input, client, acc } = createTestInput({
      byte_order: "DCBA",
      registers: [{ address: 100, name: "flow", type: "holding", data_type: "float32", scale: 1, offset: 0 }],
    });
    client.setHolding(1, 100, FLOAT_REG0_DCBA);
    client.setHolding(1, 101, FLOAT_REG1_DCBA);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.fields.value).toBeCloseTo(FLOAT_TEST_VALUE, 2);
  });

  // ── Uint32 multi-register ──────────────────────────────────────────────

  it("uint32 multi-register → correct value", async () => {
    // Value: 70000 = 0x00011170
    // ABCD: reg0 = 0x0001 = 1, reg1 = 0x1170 = 4464
    const { input, client, acc } = createTestInput({
      byte_order: "ABCD",
      registers: [{ address: 100, name: "counter", type: "holding", data_type: "uint32", scale: 1, offset: 0 }],
    });
    client.setHolding(1, 100, 0x0001);
    client.setHolding(1, 101, 0x1170);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.fields.value).toBe(70000);
  });

  // ── Scaling ────────────────────────────────────────────────────────────

  it("scaling: raw * scale + offset produces correct output", async () => {
    const { input, client, acc } = createTestInput({
      registers: [
        { address: 100, name: "temp_celsius", type: "holding", data_type: "uint16", scale: 0.01, offset: 0 },
        { address: 101, name: "temp_adjusted", type: "holding", data_type: "int16", scale: 0.1, offset: -40 },
      ],
    });
    // raw 8550 * 0.01 = 85.50
    client.setHolding(1, 100, 8550);
    // raw 650 * 0.1 + (-40) = 65 - 40 = 25
    client.setHolding(1, 101, 650);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(2);
    expect(acc.metrics[0]!.fields.value).toBeCloseTo(85.50, 2);
    expect(acc.metrics[1]!.fields.value).toBeCloseTo(25.0, 2);
  });

  // ── Bit extraction ─────────────────────────────────────────────────────

  it("bit extraction: correct bit extracted as boolean", async () => {
    const { input, client, acc } = createTestInput({
      registers: [
        { address: 100, name: "bit_8_on", type: "holding", data_type: "uint16", scale: 1, offset: 0, bit: 8 },
        { address: 101, name: "bit_0_off", type: "holding", data_type: "uint16", scale: 1, offset: 0, bit: 0 },
      ],
    });
    // 0xFF00 = 1111111100000000 → bit 8 = 1, bit 0 = 0
    client.setHolding(1, 100, 0xFF00);
    client.setHolding(1, 101, 0xFF00);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(2);
    expect(acc.metrics[0]!.fields.value).toBe(true);  // bit 8 is set
    expect(acc.metrics[1]!.fields.value).toBe(false); // bit 0 is not set
  });

  // ── Batch reads ────────────────────────────────────────────────────────

  it("batch read: contiguous registers read in single request", async () => {
    const { input, client, acc } = createTestInput({
      optimization: "batch",
      registers: [
        { address: 100, name: "reg_a", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
        { address: 101, name: "reg_b", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
        { address: 102, name: "reg_c", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
      ],
    });
    client.setHolding(1, 100, 10);
    client.setHolding(1, 101, 20);
    client.setHolding(1, 102, 30);
    await input.init();
    await input.gather(acc);

    // Should have been read in a single FC03 call
    const fc03Calls = client.readCalls.filter((c) => c.method === "FC03");
    expect(fc03Calls.length).toBe(1);
    expect(fc03Calls[0]!.address).toBe(100);
    expect(fc03Calls[0]!.count).toBe(3);

    // All values correct
    expect(acc.metrics.length).toBe(3);
    expect(acc.metrics[0]!.fields.value).toBe(10);
    expect(acc.metrics[1]!.fields.value).toBe(20);
    expect(acc.metrics[2]!.fields.value).toBe(30);
  });

  // ── Gap split ──────────────────────────────────────────────────────────

  it("gap split: non-contiguous registers split into separate requests", async () => {
    const { input, client, acc } = createTestInput({
      optimization: "batch",
      max_gap: 5,
      registers: [
        { address: 100, name: "reg_a", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
        { address: 200, name: "reg_b", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
      ],
    });
    client.setHolding(1, 100, 11);
    client.setHolding(1, 200, 22);
    await input.init();
    await input.gather(acc);

    // Should have been 2 separate FC03 calls (gap = 99 > max_gap = 5)
    const fc03Calls = client.readCalls.filter((c) => c.method === "FC03");
    expect(fc03Calls.length).toBe(2);
    expect(fc03Calls[0]!.address).toBe(100);
    expect(fc03Calls[0]!.count).toBe(1);
    expect(fc03Calls[1]!.address).toBe(200);
    expect(fc03Calls[1]!.count).toBe(1);

    expect(acc.metrics.length).toBe(2);
    expect(acc.metrics[0]!.fields.value).toBe(11);
    expect(acc.metrics[1]!.fields.value).toBe(22);
  });

  // ── Shared mode ────────────────────────────────────────────────────────

  it("shared mode: 2 slave IDs on same connection both return correct data", async () => {
    const mockClient = new MockModbusClient();
    const { input, acc } = createTestInput({
      connection_mode: "shared",
      slaves: [
        { slave_id: 1, registers: [{ address: 100, name: "slave1_temp", type: "holding", data_type: "uint16", scale: 1, offset: 0 }] },
        { slave_id: 2, registers: [{ address: 100, name: "slave2_temp", type: "holding", data_type: "uint16", scale: 1, offset: 0 }] },
      ],
    }, mockClient);

    mockClient.setHolding(1, 100, 111);
    mockClient.setHolding(2, 100, 222);
    await input.init();
    await input.gather(acc);

    expect(acc.metrics.length).toBe(2);
    expect(acc.metrics[0]!.name).toBe("slave1_temp");
    expect(acc.metrics[0]!.fields.value).toBe(111);
    expect(acc.metrics[0]!.tags.slave_id).toBe("1");
    expect(acc.metrics[1]!.name).toBe("slave2_temp");
    expect(acc.metrics[1]!.fields.value).toBe(222);
    expect(acc.metrics[1]!.tags.slave_id).toBe("2");
  });

  // ── Modbus exceptions ──────────────────────────────────────────────────

  it("Modbus exception 02 (Illegal Address) → register disabled, others continue", async () => {
    const { input, client, acc } = createTestInput({
      optimization: "none", // Individual reads so we can target one register
      registers: [
        { address: 100, name: "good_reg", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
        { address: 200, name: "bad_reg", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
      ],
    });
    client.setHolding(1, 100, 42);

    // Simulate Modbus exception 02 on address 200
    const modbusErr = Object.assign(new Error("Illegal Data Address"), { modbusCode: 0x02 });
    client.throwOnRead.set("FC03:1:200", modbusErr);

    // Suppress logger output for cleaner test output
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    await input.init();
    await input.gather(acc);

    // Good register was read, bad register was disabled
    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.name).toBe("good_reg");
    expect(acc.metrics[0]!.fields.value).toBe(42);
    expect(input.disabledRegisters.has("1:200:holding")).toBe(true);

    // Second gather: disabled register is skipped
    acc.metrics = [];
    acc.errors = [];
    client.readCalls = [];
    await input.gather(acc);

    expect(acc.metrics.length).toBe(1);
    // Only one FC03 call (bad register was skipped)
    const fc03Calls = client.readCalls.filter((c) => c.method === "FC03");
    expect(fc03Calls.length).toBe(1);
    expect(fc03Calls[0]!.address).toBe(100);

    process.stderr.write = origWrite;
  });

  it("Modbus exception 04 (Slave Failure) → retry next interval, others continue", async () => {
    const { input, client, acc } = createTestInput({
      optimization: "none",
      registers: [
        { address: 100, name: "good_reg", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
        { address: 200, name: "flaky_reg", type: "holding", data_type: "uint16", scale: 1, offset: 0 },
      ],
    });
    client.setHolding(1, 100, 42);
    client.setHolding(1, 200, 99);

    // First gather: exception 04 on address 200
    const modbusErr = Object.assign(new Error("Slave Device Failure"), { modbusCode: 0x04 });
    client.throwOnRead.set("FC03:1:200", modbusErr);

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    await input.init();
    await input.gather(acc);

    // Good register was read, flaky register failed but is NOT disabled
    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.name).toBe("good_reg");
    expect(input.disabledRegisters.has("1:200:holding")).toBe(false);

    // Second gather: remove the error, register should be retried
    client.throwOnRead.delete("FC03:1:200");
    acc.metrics = [];
    await input.gather(acc);

    expect(acc.metrics.length).toBe(2);
    const flaky = acc.metrics.find((m) => m.name === "flaky_reg");
    expect(flaky).toBeDefined();
    expect(flaky!.fields.value).toBe(99);

    process.stderr.write = origWrite;
  });

  // ── Connection timeout ─────────────────────────────────────────────────

  it("connection timeout → error logged, gather completes without crash", async () => {
    const mockClient = new MockModbusClient();
    mockClient.connectShouldFail = true;

    const { input, acc } = createTestInput({
      registers: [{ address: 100, name: "reg", type: "holding", data_type: "uint16", scale: 1, offset: 0 }],
    }, mockClient);

    // init() should throw on connect failure
    let initError: Error | null = null;
    try {
      await input.init();
    } catch (err) {
      initError = err as Error;
    }
    expect(initError).not.toBeNull();
    expect(initError!.message).toContain("connection refused");

    // After failed init, gather should try to reconnect and fail gracefully
    mockClient.connectShouldFail = true;
    await input.gather(acc);

    expect(acc.errors.length).toBeGreaterThanOrEqual(1);
    expect(acc.errors[0]!.message).toContain("reconnect failed");
    expect(acc.metrics.length).toBe(0);
  });

  // ── Reconnection ───────────────────────────────────────────────────────

  it("reconnection after connection drop", async () => {
    const { input, client, acc } = createTestInput({
      registers: [{ address: 100, name: "reg", type: "holding", data_type: "uint16", scale: 1, offset: 0 }],
    });
    client.setHolding(1, 100, 42);
    await input.init();

    // First gather succeeds
    await input.gather(acc);
    expect(acc.metrics.length).toBe(1);

    // Simulate connection drop
    client.close();
    acc.metrics = [];
    acc.errors = [];

    // Next gather should reconnect and succeed
    await input.gather(acc);

    // Should have reconnected (new connectTCP call)
    expect(client.connectCalls.length).toBe(2); // initial + reconnect
    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.fields.value).toBe(42);
  });

  // ── Config validation ──────────────────────────────────────────────────

  it("config validation: missing controller → error", () => {
    expect(() => {
      ModbusConfigSchema.parse({});
    }).toThrow();
  });

  it("config validation: slave_id out of range → error", () => {
    expect(() => {
      ModbusConfigSchema.parse({ controller: "tcp://1.2.3.4:502", slave_id: 300 });
    }).toThrow();

    expect(() => {
      ModbusConfigSchema.parse({ controller: "tcp://1.2.3.4:502", slave_id: 0 });
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Batch grouping unit tests
// ---------------------------------------------------------------------------

describe("groupIntoBatches", () => {
  const mkReg = (address: number, type: RegisterType = "holding", dataType: string = "uint16"): any => ({
    config: { address, type, data_type: dataType, name: `r${address}`, scale: 1, offset: 0 },
    disabled: false,
    registerCount: (dataType === "uint32" || dataType === "int32" || dataType === "float32") ? 2 : 1,
  });

  type RegisterType = "holding" | "input" | "coil" | "discrete";

  it("optimization=none produces one group per register", () => {
    const regs = [mkReg(100), mkReg(101), mkReg(102)];
    const batches = groupIntoBatches(regs, "none", 125, 10);
    expect(batches.length).toBe(3);
  });

  it("contiguous holding registers grouped into one batch", () => {
    const regs = [mkReg(100), mkReg(101), mkReg(102)];
    const batches = groupIntoBatches(regs, "batch", 125, 10);
    expect(batches.length).toBe(1);
    expect(batches[0]!.startAddress).toBe(100);
    expect(batches[0]!.totalCount).toBe(3);
  });

  it("large gap splits into separate batches", () => {
    const regs = [mkReg(100), mkReg(200)];
    const batches = groupIntoBatches(regs, "batch", 125, 5);
    expect(batches.length).toBe(2);
  });

  it("disabled registers excluded from batches", () => {
    const regs = [mkReg(100), { ...mkReg(101), disabled: true }, mkReg(102)];
    const batches = groupIntoBatches(regs, "batch", 125, 10);
    expect(batches.length).toBe(1);
    expect(batches[0]!.members.length).toBe(2); // 100 and 102
  });

  it("different register types produce separate batches", () => {
    const regs = [mkReg(100, "holding"), mkReg(100, "input")];
    const batches = groupIntoBatches(regs, "batch", 125, 10);
    expect(batches.length).toBe(2);
  });

  it("float32 occupies 2 register addresses", () => {
    const regs = [mkReg(100, "holding", "float32"), mkReg(102, "holding", "uint16")];
    const batches = groupIntoBatches(regs, "batch", 125, 10);
    expect(batches.length).toBe(1);
    expect(batches[0]!.totalCount).toBe(3); // 100-101 (float) + 102 (uint16)
  });
});

// ---------------------------------------------------------------------------
// Byte order decoding unit tests
// ---------------------------------------------------------------------------

describe("decodeMultiRegister", () => {
  // Helper: create buffer from register values (big-endian per Modbus spec)
  function bufFromRegs(...regs: number[]): Buffer {
    const bytes: number[] = [];
    for (const r of regs) {
      bytes.push((r >> 8) & 0xFF, r & 0xFF);
    }
    return Buffer.from(bytes);
  }

  it("float32 ABCD decodes correctly", () => {
    const buf = bufFromRegs(FLOAT_REG0_ABCD, FLOAT_REG1_ABCD);
    expect(decodeMultiRegister(buf, 0, "float32", "ABCD")).toBeCloseTo(FLOAT_TEST_VALUE, 2);
  });

  it("float32 CDAB decodes correctly", () => {
    const buf = bufFromRegs(FLOAT_REG0_CDAB, FLOAT_REG1_CDAB);
    expect(decodeMultiRegister(buf, 0, "float32", "CDAB")).toBeCloseTo(FLOAT_TEST_VALUE, 2);
  });

  it("float32 BADC decodes correctly", () => {
    const buf = bufFromRegs(FLOAT_REG0_BADC, FLOAT_REG1_BADC);
    expect(decodeMultiRegister(buf, 0, "float32", "BADC")).toBeCloseTo(FLOAT_TEST_VALUE, 2);
  });

  it("float32 DCBA decodes correctly", () => {
    const buf = bufFromRegs(FLOAT_REG0_DCBA, FLOAT_REG1_DCBA);
    expect(decodeMultiRegister(buf, 0, "float32", "DCBA")).toBeCloseTo(FLOAT_TEST_VALUE, 2);
  });

  it("uint32 ABCD decodes correctly", () => {
    // 70000 = 0x00011170 → reg0=0x0001, reg1=0x1170
    const buf = bufFromRegs(0x0001, 0x1170);
    expect(decodeMultiRegister(buf, 0, "uint32", "ABCD")).toBe(70000);
  });

  it("int32 ABCD decodes negative correctly", () => {
    // -1 = 0xFFFFFFFF → reg0=0xFFFF, reg1=0xFFFF
    const buf = bufFromRegs(0xFFFF, 0xFFFF);
    expect(decodeMultiRegister(buf, 0, "int32", "ABCD")).toBe(-1);
  });
});
