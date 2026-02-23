// CollatrEdge — Modbus TCP input plugin
// PRD refs: §6 Plugin System (Modbus config schema + exception handling)
// ──────────────────────────────────────────────────────────────────────
// SAFETY: CollatrEdge is READ-ONLY. Modbus write function codes
// (FC05, FC06, FC15, FC16) are not implemented and MUST NOT be added.
// Input plugins never modify PLC state. This is a deliberate, permanent
// design constraint — not a missing feature.
// ──────────────────────────────────────────────────────────────────────

import { z } from "zod/v4";
import { getLogger } from "../../core/logger";
import type { Input } from "../../core/plugin-types";
import type { Accumulator } from "../../core/accumulator";
import { parseDuration } from "../../core/config";

// ---------------------------------------------------------------------------
// Zod config schema — matches PRD §6 ModbusConfigSchema exactly
// ---------------------------------------------------------------------------

export const ModbusRegisterSchema = z.object({
  address: z.number().int(),
  name: z.string(),
  type: z.enum(["holding", "input", "coil", "discrete"]).default("holding"),
  data_type: z.enum(["uint16", "int16", "uint32", "int32", "float32", "bool"]).default("uint16"),
  byte_order: z.enum(["ABCD", "CDAB", "BADC", "DCBA"]).optional(),
  scale: z.number().default(1.0),
  offset: z.number().default(0.0),
  bit: z.number().int().min(0).max(15).optional(),
});

export const ModbusConfigSchema = z.object({
  controller: z.string().describe("Modbus TCP address (e.g., tcp://192.168.1.100:502)"),
  connection_mode: z.enum(["dedicated", "shared"]).default("dedicated"),
  slave_id: z.number().int().min(1).max(247).default(1),
  registers: z.array(ModbusRegisterSchema).optional(),
  slaves: z.array(z.object({
    slave_id: z.number().int().min(1).max(247),
    registers: z.array(ModbusRegisterSchema),
  })).optional(),
  byte_order: z.enum(["ABCD", "CDAB", "BADC", "DCBA"]).default("ABCD"),
  optimization: z.enum(["none", "batch"]).default("batch"),
  max_batch_size: z.number().int().min(1).max(125).default(125),
  max_gap: z.number().int().min(0).default(10),
  timeout: z.string().default("5s"),
});

export type ModbusConfig = z.infer<typeof ModbusConfigSchema>;
export type ModbusRegisterConfig = z.infer<typeof ModbusRegisterSchema>;
type ByteOrder = "ABCD" | "CDAB" | "BADC" | "DCBA";
type RegisterType = "holding" | "input" | "coil" | "discrete";

// ---------------------------------------------------------------------------
// Modbus client interface (for dependency injection / testing)
// ---------------------------------------------------------------------------

export interface ModbusClient {
  connectTCP(host: string, options: { port: number }): Promise<void>;
  setID(id: number): void;
  setTimeout(ms: number): void;
  readCoils(addr: number, count: number): Promise<{ data: boolean[]; buffer: Buffer }>;
  readDiscreteInputs(addr: number, count: number): Promise<{ data: boolean[]; buffer: Buffer }>;
  readHoldingRegisters(addr: number, count: number): Promise<{ data: number[]; buffer: Buffer }>;
  readInputRegisters(addr: number, count: number): Promise<{ data: number[]; buffer: Buffer }>;
  close(cb?: () => void): void;
  isOpen: boolean;
}

// ---------------------------------------------------------------------------
// Internal register state
// ---------------------------------------------------------------------------

interface RegisterState {
  config: ModbusRegisterConfig;
  disabled: boolean;
  /** Number of Modbus register addresses this occupies (1 or 2). */
  registerCount: number;
}

// ---------------------------------------------------------------------------
// Batch group for optimized reads
// ---------------------------------------------------------------------------

interface BatchGroup {
  registerType: RegisterType;
  startAddress: number;
  /** Total number of register addresses to read in one request. */
  totalCount: number;
  members: RegisterState[];
}

// ---------------------------------------------------------------------------
// Byte order decoding
// ---------------------------------------------------------------------------

/**
 * Rearrange 4 bytes from wire order to big-endian based on the byte order setting.
 * Returns a new Buffer suitable for DataView.getFloat32/getUint32/getInt32 in big-endian mode.
 */
function reorderBytes(buf: Buffer, offset: number, byteOrder: ByteOrder): Buffer {
  const b0 = buf[offset]!;
  const b1 = buf[offset + 1]!;
  const b2 = buf[offset + 2]!;
  const b3 = buf[offset + 3]!;

  switch (byteOrder) {
    case "ABCD": return Buffer.from([b0, b1, b2, b3]);
    case "CDAB": return Buffer.from([b2, b3, b0, b1]);
    case "BADC": return Buffer.from([b1, b0, b3, b2]);
    case "DCBA": return Buffer.from([b3, b2, b1, b0]);
  }
}

/**
 * Decode a multi-register (32-bit) value from a Modbus response buffer.
 */
export function decodeMultiRegister(
  buffer: Buffer,
  offset: number,
  dataType: "uint32" | "int32" | "float32",
  byteOrder: ByteOrder,
): number {
  const ordered = reorderBytes(buffer, offset, byteOrder);
  const view = new DataView(ordered.buffer, ordered.byteOffset, ordered.byteLength);
  switch (dataType) {
    case "uint32":  return view.getUint32(0, false);
    case "int32":   return view.getInt32(0, false);
    case "float32": return view.getFloat32(0, false);
  }
}

// ---------------------------------------------------------------------------
// Batch grouping
// ---------------------------------------------------------------------------

function getRegisterCount(reg: ModbusRegisterConfig): number {
  if (reg.type === "coil" || reg.type === "discrete") return 1;
  if (reg.bit !== undefined) return 1;
  switch (reg.data_type) {
    case "uint32": case "int32": case "float32": return 2;
    default: return 1;
  }
}

export function groupIntoBatches(
  registers: RegisterState[],
  optimization: "none" | "batch",
  maxBatchSize: number,
  maxGap: number,
): BatchGroup[] {
  const active = registers.filter((r) => !r.disabled);
  if (active.length === 0) return [];

  if (optimization === "none") {
    return active.map((r) => ({
      registerType: r.config.type,
      startAddress: r.config.address,
      totalCount: r.registerCount,
      members: [r],
    }));
  }

  // Group by register type then sort by address
  const byType = new Map<RegisterType, RegisterState[]>();
  for (const reg of active) {
    const list = byType.get(reg.config.type);
    if (list) list.push(reg);
    else byType.set(reg.config.type, [reg]);
  }

  const groups: BatchGroup[] = [];
  for (const [type, regs] of byType) {
    regs.sort((a, b) => a.config.address - b.config.address);

    let current: BatchGroup | null = null;
    for (const reg of regs) {
      if (!current) {
        current = {
          registerType: type,
          startAddress: reg.config.address,
          totalCount: reg.registerCount,
          members: [reg],
        };
        continue;
      }

      const lastMember = current.members[current.members.length - 1]!;
      const lastEnd = lastMember.config.address + lastMember.registerCount;
      const gap = reg.config.address - lastEnd;
      const newTotal = (reg.config.address + reg.registerCount) - current.startAddress;

      if (gap <= maxGap && newTotal <= maxBatchSize) {
        current.totalCount = newTotal;
        current.members.push(reg);
      } else {
        groups.push(current);
        current = {
          registerType: type,
          startAddress: reg.config.address,
          totalCount: reg.registerCount,
          members: [reg],
        };
      }
    }
    if (current) groups.push(current);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Modbus exception handling (PRD §6 table)
// ---------------------------------------------------------------------------

/** Exception codes that disable the register (config errors). */
const DISABLE_EXCEPTIONS = new Set([0x01, 0x02, 0x03]);

/** Exception codes that should retry next interval. */
const RETRY_EXCEPTIONS = new Set([0x04, 0x05, 0x06, 0x08, 0x0A, 0x0B]);

interface ModbusError extends Error {
  modbusCode?: number;
  errno?: string;
}

function isModbusException(err: unknown): err is ModbusError {
  return err instanceof Error && typeof (err as ModbusError).modbusCode === "number";
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as ModbusError;
  return (
    e.errno === "ECONNRESET" ||
    e.errno === "ECONNREFUSED" ||
    e.errno === "ETIMEDOUT" ||
    e.message.includes("Port Not Open") ||
    e.message.includes("Timed out")
  );
}

// ---------------------------------------------------------------------------
// ModbusInput — polling Input implementation
// ---------------------------------------------------------------------------

export class ModbusInput implements Input {
  private config: ModbusConfig;
  private client: ModbusClient;
  private connected = false;
  private timeoutMs: number;
  private host: string;
  private port: number;

  /** Per-slave register states. Key: slaveId. */
  private slaveRegisters = new Map<number, RegisterState[]>();

  /** Registers disabled due to permanent Modbus exceptions. */
  readonly disabledRegisters: Set<string> = new Set(); // "slaveId:address:type"

  constructor(config: ModbusConfig, client?: ModbusClient) {
    this.config = config;
    this.timeoutMs = parseDuration(config.timeout);

    // Parse controller URL: tcp://host:port
    const url = config.controller.replace(/^tcp:\/\//, "");
    const parts = url.split(":");
    this.host = parts[0] ?? "127.0.0.1";
    this.port = parts[1] ? parseInt(parts[1], 10) : 502;

    // Use injected client or create real one lazily in init()
    if (client) {
      this.client = client;
    } else {
      // Lazy import to avoid loading modbus-serial if not needed
      this.client = null as unknown as ModbusClient;
    }

    // Initialize register states
    this.initRegisterStates();
  }

  private initRegisterStates(): void {
    if (this.config.connection_mode === "shared" && this.config.slaves) {
      for (const slave of this.config.slaves) {
        this.slaveRegisters.set(
          slave.slave_id,
          slave.registers.map((r) => ({
            config: r,
            disabled: false,
            registerCount: getRegisterCount(r),
          })),
        );
      }
    } else if (this.config.registers) {
      this.slaveRegisters.set(
        this.config.slave_id,
        this.config.registers.map((r) => ({
          config: r,
          disabled: false,
          registerCount: getRegisterCount(r),
        })),
      );
    }
  }

  async init(): Promise<void> {
    if (!this.client) {
      const ModbusRTU = (await import("modbus-serial")).default;
      this.client = new ModbusRTU() as unknown as ModbusClient;
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    try {
      await this.client.connectTCP(this.host, { port: this.port });
      this.client.setTimeout(this.timeoutMs);
      this.connected = true;
    } catch (err) {
      this.connected = false;
      throw err;
    }
  }

  private async reconnect(): Promise<void> {
    try {
      this.client.close();
    } catch {
      // ignore close errors during reconnect
    }
    await this.connect();
  }

  async gather(acc: Accumulator): Promise<void> {
    // Reconnect if not connected
    if (!this.connected || !this.client.isOpen) {
      try {
        await this.reconnect();
      } catch (err) {
        acc.addError(new Error(`Modbus reconnect failed: ${(err as Error).message}`));
        return;
      }
    }

    // Read registers for each slave
    for (const [slaveId, registers] of this.slaveRegisters) {
      this.client.setID(slaveId);
      try {
        await this.readRegistersForSlave(slaveId, registers, acc);
      } catch (err) {
        if (isConnectionError(err)) {
          this.connected = false;
          acc.addError(new Error(`Modbus connection lost for slave ${slaveId}: ${(err as Error).message}`));
          return; // Don't try other slaves on connection loss
        }
        acc.addError(err as Error);
      }
    }
  }

  private async readRegistersForSlave(
    slaveId: number,
    registers: RegisterState[],
    acc: Accumulator,
  ): Promise<void> {
    const batches = groupIntoBatches(
      registers,
      this.config.optimization,
      this.config.max_batch_size,
      this.config.max_gap,
    );

    for (const batch of batches) {
      try {
        await this.readBatch(slaveId, batch, acc);
      } catch (err) {
        if (isConnectionError(err)) throw err; // Propagate connection errors

        if (batch.members.length > 1) {
          // Batch read failed — fall back to individual reads to isolate the problem
          for (const reg of batch.members) {
            try {
              await this.readSingleRegister(slaveId, reg, acc);
            } catch (innerErr) {
              this.handleRegisterError(slaveId, reg, innerErr, acc);
            }
          }
        } else {
          this.handleRegisterError(slaveId, batch.members[0]!, err, acc);
        }
      }
    }
  }

  private async readBatch(
    slaveId: number,
    batch: BatchGroup,
    acc: Accumulator,
  ): Promise<void> {
    const { registerType, startAddress, totalCount, members } = batch;

    if (registerType === "coil") {
      const result = await this.client.readCoils(startAddress, totalCount);
      for (const reg of members) {
        const idx = reg.config.address - startAddress;
        const value = result.data[idx]!;
        this.emitValue(slaveId, reg, value, acc);
      }
      return;
    }

    if (registerType === "discrete") {
      const result = await this.client.readDiscreteInputs(startAddress, totalCount);
      for (const reg of members) {
        const idx = reg.config.address - startAddress;
        const value = result.data[idx]!;
        this.emitValue(slaveId, reg, value, acc);
      }
      return;
    }

    // holding or input registers
    const result = registerType === "holding"
      ? await this.client.readHoldingRegisters(startAddress, totalCount)
      : await this.client.readInputRegisters(startAddress, totalCount);

    for (const reg of members) {
      const regOffset = reg.config.address - startAddress;
      const value = this.decodeRegisterValue(reg, result.data, result.buffer, regOffset);
      this.emitValue(slaveId, reg, value, acc);
    }
  }

  private async readSingleRegister(
    slaveId: number,
    reg: RegisterState,
    acc: Accumulator,
  ): Promise<void> {
    if (reg.disabled) return;

    const { config } = reg;
    if (config.type === "coil") {
      const result = await this.client.readCoils(config.address, 1);
      this.emitValue(slaveId, reg, result.data[0]!, acc);
      return;
    }
    if (config.type === "discrete") {
      const result = await this.client.readDiscreteInputs(config.address, 1);
      this.emitValue(slaveId, reg, result.data[0]!, acc);
      return;
    }

    const count = reg.registerCount;
    const result = config.type === "holding"
      ? await this.client.readHoldingRegisters(config.address, count)
      : await this.client.readInputRegisters(config.address, count);

    const value = this.decodeRegisterValue(reg, result.data, result.buffer, 0);
    this.emitValue(slaveId, reg, value, acc);
  }

  private decodeRegisterValue(
    reg: RegisterState,
    data: number[],
    buffer: Buffer,
    regOffset: number,
  ): number | boolean {
    const { config } = reg;
    const byteOrder = config.byte_order ?? this.config.byte_order;
    const rawValue = data[regOffset]!;

    // Bit extraction overrides data_type
    if (config.bit !== undefined) {
      return ((rawValue >> config.bit) & 1) === 1;
    }

    switch (config.data_type) {
      case "bool":
        return rawValue !== 0;
      case "uint16":
        return rawValue * config.scale + config.offset;
      case "int16": {
        // Convert unsigned 16-bit to signed
        const signed = rawValue > 0x7FFF ? rawValue - 0x10000 : rawValue;
        return signed * config.scale + config.offset;
      }
      case "uint32":
      case "int32":
      case "float32": {
        const byteOffset = regOffset * 2; // 2 bytes per register
        const decoded = decodeMultiRegister(buffer, byteOffset, config.data_type, byteOrder);
        return decoded * config.scale + config.offset;
      }
    }
  }

  private emitValue(
    slaveId: number,
    reg: RegisterState,
    value: number | boolean,
    acc: Accumulator,
  ): void {
    acc.addFields(
      reg.config.name,
      { value },
      { slave_id: String(slaveId) },
    );
  }

  private handleRegisterError(
    slaveId: number,
    reg: RegisterState,
    err: unknown,
    acc: Accumulator,
  ): void {
    if (isModbusException(err)) {
      const code = err.modbusCode!;
      if (DISABLE_EXCEPTIONS.has(code)) {
        // Config error — disable this register permanently
        reg.disabled = true;
        const key = `${slaveId}:${reg.config.address}:${reg.config.type}`;
        this.disabledRegisters.add(key);
        getLogger().error("register disabled", {
          plugin: "modbus", register: reg.config.name, slave_id: slaveId,
          address: reg.config.address, exception: `0x${code.toString(16).padStart(2, "0")}`,
        });
      } else if (RETRY_EXCEPTIONS.has(code)) {
        // Transient error — retry next interval
        getLogger().warn("register error — will retry next interval", {
          plugin: "modbus", register: reg.config.name, slave_id: slaveId,
          address: reg.config.address, exception: `0x${code.toString(16).padStart(2, "0")}`,
        });
      }
    } else {
      acc.addError(err as Error);
    }
  }

  async close(): Promise<void> {
    try {
      this.client.close();
    } catch {
      // ignore close errors
    }
    this.connected = false;
  }
}

// ---------------------------------------------------------------------------
// Factory function for plugin registration
// ---------------------------------------------------------------------------

export function createModbusInput(rawConfig: unknown, client?: ModbusClient): ModbusInput {
  const config = ModbusConfigSchema.parse(rawConfig);
  return new ModbusInput(config, client);
}
