import { describe, it, expect } from "bun:test";
import { parse } from "smol-toml";
import { pack, unpack } from "msgpackr";

describe("smoke tests", () => {
  it("bun:test framework works", () => {
    expect(1 + 1).toBe(2);
  });

  it("TypeScript strict mode is active", () => {
    // This file compiles under strict: true — if it runs, strict mode works
    const value: string = "strict";
    expect(value).toBe("strict");
  });

  it("smol-toml parses TOML", () => {
    const toml = `
[agent]
hostname = "test-host"
interval = "10s"
`;
    const result = parse(toml);
    expect(result).toEqual({
      agent: {
        hostname: "test-host",
        interval: "10s",
      },
    });
  });

  it("msgpackr round-trips data", () => {
    const data = {
      name: "cpu.usage",
      value: 42.5,
      tags: { host: "pi-01" },
      timestamp: BigInt(Date.now()) * 1_000_000n,
    };
    const packed = pack(data);
    expect(packed).toBeInstanceOf(Uint8Array);

    const unpacked = unpack(packed) as typeof data;
    expect(unpacked.name).toBe("cpu.usage");
    expect(unpacked.value).toBe(42.5);
    expect(unpacked.tags.host).toBe("pi-01");
  });
});
