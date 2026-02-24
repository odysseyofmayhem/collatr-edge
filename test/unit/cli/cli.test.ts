// CollatrEdge — CLI framework tests
// PRD refs: §18 Deployment & Distribution (CLI)

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, parseGlobalOptions } from "../../../src/cli/index";

describe("CLI framework", () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let stdoutOutput: string[];
  let stderrOutput: string[];

  beforeEach(() => {
    stdoutOutput = [];
    stderrOutput = [];
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        const str =
          typeof chunk === "string"
            ? chunk
            : new TextDecoder().decode(chunk);
        stdoutOutput.push(str);
        return true;
      },
    );
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        const str =
          typeof chunk === "string"
            ? chunk
            : new TextDecoder().decode(chunk);
        stderrOutput.push(str);
        return true;
      },
    );
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function stdout(): string {
    return stdoutOutput.join("");
  }

  function stderr(): string {
    return stderrOutput.join("");
  }

  // =========================================================================
  // Unknown command
  // =========================================================================

  it("unknown command → exit 1, prints error + help", async () => {
    const code = await main(["banana"]);
    expect(code).toBe(1);
    expect(stderr()).toContain("Unknown command: banana");
    expect(stdout()).toContain("Usage:");
    expect(stdout()).toContain("Commands:");
  });

  // =========================================================================
  // No command → help
  // =========================================================================

  it("no command → prints help, returns 0", async () => {
    const code = await main([]);
    expect(code).toBe(0);
    expect(stdout()).toContain("Usage:");
    expect(stdout()).toContain("run");
    expect(stdout()).toContain("config init");
    expect(stdout()).toContain("config validate");
    expect(stdout()).toContain("version");
  });

  // =========================================================================
  // --help flag
  // =========================================================================

  it("--help → prints help, returns 0", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(stdout()).toContain("Usage:");
  });

  it("-h → prints help, returns 0", async () => {
    const code = await main(["-h"]);
    expect(code).toBe(0);
    expect(stdout()).toContain("Usage:");
  });

  // =========================================================================
  // Config path parsing
  // =========================================================================

  describe("parseGlobalOptions", () => {
    it("--config /path/to/file.toml extracts config path", () => {
      const { options, remaining } = parseGlobalOptions([
        "--config",
        "/path/to/file.toml",
        "run",
      ]);
      expect(options.configPath).toBe("/path/to/file.toml");
      expect(remaining).toEqual(["run"]);
    });

    it("-c /path/to/file.toml extracts config path (short form)", () => {
      const { options, remaining } = parseGlobalOptions([
        "-c",
        "/my/config.toml",
        "run",
      ]);
      expect(options.configPath).toBe("/my/config.toml");
      expect(remaining).toEqual(["run"]);
    });

    it("defaults to /etc/collatr-edge/config.toml when no --config", () => {
      const original = process.env.COLLATR_EDGE_CONFIG;
      delete process.env.COLLATR_EDGE_CONFIG;

      const { options } = parseGlobalOptions(["run"]);
      expect(options.configPath).toBe("/etc/collatr-edge/config.toml");

      // Restore
      if (original !== undefined) process.env.COLLATR_EDGE_CONFIG = original;
    });

    it("COLLATR_EDGE_CONFIG env var overrides default", () => {
      const original = process.env.COLLATR_EDGE_CONFIG;
      process.env.COLLATR_EDGE_CONFIG = "/from/env.toml";

      const { options } = parseGlobalOptions(["run"]);
      expect(options.configPath).toBe("/from/env.toml");

      // Restore
      if (original !== undefined) {
        process.env.COLLATR_EDGE_CONFIG = original;
      } else {
        delete process.env.COLLATR_EDGE_CONFIG;
      }
    });

    it("--config flag overrides env var", () => {
      const original = process.env.COLLATR_EDGE_CONFIG;
      process.env.COLLATR_EDGE_CONFIG = "/from/env.toml";

      const { options } = parseGlobalOptions([
        "--config",
        "/from/flag.toml",
        "run",
      ]);
      expect(options.configPath).toBe("/from/flag.toml");

      if (original !== undefined) {
        process.env.COLLATR_EDGE_CONFIG = original;
      } else {
        delete process.env.COLLATR_EDGE_CONFIG;
      }
    });

    it("--config at end of args (before command)", () => {
      const { options, remaining } = parseGlobalOptions([
        "run",
        "--config",
        "/my/config.toml",
      ]);
      expect(options.configPath).toBe("/my/config.toml");
      expect(remaining).toEqual(["run"]);
    });

    it("--config with no value → returns error", () => {
      const result = parseGlobalOptions(["--config"]);
      expect(result.error).toBeDefined();
      expect(stderr()).toContain("requires a path argument");
    });

    it("-c followed by another flag → returns error", () => {
      const result = parseGlobalOptions(["-c", "-h"]);
      expect(result.error).toBeDefined();
      expect(stderr()).toContain("requires a path argument");
    });
  });

  // =========================================================================
  // Config subcommand routing
  // =========================================================================

  it("config init → routes to config init handler", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "collatr-cli-init-"));
    const outPath = join(tmpDir, "test.toml");
    const code = await main(["config", "init", "--output", outPath]);
    expect(code).toBe(0);
    expect(stdout()).toContain("Generated default config");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("config validate → routes to config validate handler", async () => {
    // Uses default config path which doesn't exist → exit 1 with file not found
    const code = await main(["config", "validate"]);
    expect(code).toBe(1);
    expect(stdout()).toContain("Config file not found");
  });

  it("config (no subcommand) → error with usage", async () => {
    const code = await main(["config"]);
    expect(code).toBe(1);
    expect(stderr()).toContain("missing config subcommand");
  });

  it("config banana → unknown subcommand error", async () => {
    const code = await main(["config", "banana"]);
    expect(code).toBe(1);
    expect(stderr()).toContain("unknown config subcommand: banana");
  });

  // =========================================================================
  // Stub commands return non-zero until implemented
  // =========================================================================

  it("run (default config path) → exit 1 when config not found", async () => {
    const code = await main(["run"]);
    expect(code).toBe(1);
  });

  it("version → returns 0", async () => {
    const code = await main(["version"]);
    expect(code).toBe(0);
    expect(stdout()).toContain("CollatrEdge");
  });

  // =========================================================================
  // Config path flows through to subcommands
  // =========================================================================

  it("--config before command is parsed correctly", async () => {
    const code = await main(["--config", "/custom/path.toml", "config", "validate"]);
    // File doesn't exist → exit 1, but config path was parsed correctly
    expect(code).toBe(1);
    expect(stdout()).toContain("Config file not found: /custom/path.toml");
  });

  it("--config with missing value → exit 1", async () => {
    const code = await main(["--config"]);
    expect(code).toBe(1);
    expect(stderr()).toContain("requires a path argument");
  });
});
