// CollatrEdge — Logger tests
// PRD refs: §15 Observability — Logging

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createLogger, setGlobalLogger, getLogger, type LogLevel } from "../../../src/core/logger";

describe("Logger", () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let written: string[];

  beforeEach(() => {
    written = [];
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  function parseLine(index = 0): Record<string, unknown> {
    return JSON.parse(written[index]!.trimEnd());
  }

  describe("level filtering", () => {
    it("suppresses debug and info when level is warn", () => {
      const logger = createLogger("warn");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(written).toHaveLength(2);
      expect(parseLine(0).level).toBe("warn");
      expect(parseLine(1).level).toBe("error");
    });

    it("emits all levels when level is debug", () => {
      const logger = createLogger("debug");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(written).toHaveLength(4);
    });

    it("emits only error when level is error", () => {
      const logger = createLogger("error");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(written).toHaveLength(1);
      expect(parseLine(0).level).toBe("error");
    });
  });

  describe("JSON format", () => {
    it("outputs valid JSON with required fields (ts, level, msg)", () => {
      const logger = createLogger("debug");
      logger.info("test message");

      expect(written).toHaveLength(1);
      const entry = parseLine();
      expect(entry.ts).toBeString();
      expect(entry.level).toBe("info");
      expect(entry.msg).toBe("test message");
    });

    it("outputs ISO 8601 timestamp", () => {
      const logger = createLogger("debug");
      logger.info("ts check");

      const entry = parseLine();
      // ISO 8601 regex
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });

    it("terminates each line with newline", () => {
      const logger = createLogger("debug");
      logger.info("line");

      expect(written[0]!.endsWith("\n")).toBe(true);
    });
  });

  describe("child logger", () => {
    it("includes context fields in child output", () => {
      const logger = createLogger("debug");
      const child = logger.child({ plugin: "inputs.modbus.plc_01" });
      child.info("gather timeout");

      const entry = parseLine();
      expect(entry.plugin).toBe("inputs.modbus.plc_01");
      expect(entry.msg).toBe("gather timeout");
    });

    it("inherits parent context", () => {
      const logger = createLogger("debug", { component: "pipeline" });
      const child = logger.child({ plugin: "inputs.modbus" });
      child.info("test");

      const entry = parseLine();
      expect(entry.component).toBe("pipeline");
      expect(entry.plugin).toBe("inputs.modbus");
    });

    it("child context overrides parent context on conflict", () => {
      const logger = createLogger("debug", { source: "parent" });
      const child = logger.child({ source: "child" });
      child.info("test");

      const entry = parseLine();
      expect(entry.source).toBe("child");
    });
  });

  describe("extra fields", () => {
    it("merges extra fields into output", () => {
      const logger = createLogger("debug");
      logger.warn("gather timeout", { timeout_ms: 5000, consecutive_timeouts: 3 });

      const entry = parseLine();
      expect(entry.timeout_ms).toBe(5000);
      expect(entry.consecutive_timeouts).toBe(3);
      expect(entry.msg).toBe("gather timeout");
    });
  });

  describe("per-plugin level override", () => {
    it("child logger can have a different level than parent", () => {
      const logger = createLogger("info");
      const debugChild = logger.child({ plugin: "inputs.modbus" }, "debug");
      const errorChild = logger.child({ plugin: "outputs.file" }, "error");

      debugChild.debug("debug message");
      errorChild.warn("warn message");

      // debugChild should emit debug (level override to debug)
      expect(written).toHaveLength(1);
      expect(parseLine(0).level).toBe("debug");
      expect(parseLine(0).plugin).toBe("inputs.modbus");
      // errorChild suppressed warn (level override to error)
    });
  });

  describe("global setter/getter", () => {
    it("setGlobalLogger + getLogger round-trips correctly", () => {
      const custom = createLogger("error", { custom: "true" });
      setGlobalLogger(custom);
      const retrieved = getLogger();

      // Should be the same logger — verify by logging
      retrieved.error("global test");
      expect(written).toHaveLength(1);
      expect(parseLine(0).custom).toBe("true");
    });

    it("getLogger returns default logger initially", () => {
      // Reset to default by setting a new one
      const defaultLogger = createLogger();
      setGlobalLogger(defaultLogger);
      const logger = getLogger();

      logger.info("default");
      expect(written).toHaveLength(1);
      expect(parseLine(0).msg).toBe("default");
    });
  });
});
