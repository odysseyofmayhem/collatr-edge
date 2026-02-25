// CollatrEdge — config init command tests
// PRD refs: §7 Configuration, §18 Deployment, Appendix A

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configInitCommand,
  parseConfigInitArgs,
  generateConfigTemplate,
} from "../../../src/cli/commands/config-init";
import { configValidateCommand } from "../../../src/cli/commands/config-validate";
import { parseConfig } from "../../../src/core/config";

describe("config init command", () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let stdoutOutput: string[];
  let stderrOutput: string[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "collatr-init-"));
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function stdout(): string {
    return stdoutOutput.join("");
  }

  function stderr(): string {
    return stderrOutput.join("");
  }

  // =========================================================================
  // Arg parsing
  // =========================================================================

  describe("parseConfigInitArgs", () => {
    it("defaults: output=./collatr-edge.toml, mode=local_network, force=false", () => {
      const opts = parseConfigInitArgs([]);
      expect(opts.output).toBe("./collatr-edge.toml");
      expect(opts.mode).toBe("local_network");
      expect(opts.force).toBe(false);
    });

    it("--output /custom/path.toml", () => {
      const opts = parseConfigInitArgs(["--output", "/custom/path.toml"]);
      expect(opts.output).toBe("/custom/path.toml");
    });

    it("-o shorthand", () => {
      const opts = parseConfigInitArgs(["-o", "/short.toml"]);
      expect(opts.output).toBe("/short.toml");
    });

    it("--mode connected", () => {
      const opts = parseConfigInitArgs(["--mode", "connected"]);
      expect(opts.mode).toBe("connected");
    });

    it("--mode standalone", () => {
      const opts = parseConfigInitArgs(["--mode", "standalone"]);
      expect(opts.mode).toBe("standalone");
    });

    it("--force", () => {
      const opts = parseConfigInitArgs(["--force"]);
      expect(opts.force).toBe(true);
    });

    it("invalid --mode throws", () => {
      expect(() => parseConfigInitArgs(["--mode", "banana"])).toThrow(
        "Invalid mode",
      );
    });

    it("--output without value throws", () => {
      expect(() => parseConfigInitArgs(["--output"])).toThrow(
        "--output requires a file path",
      );
    });
  });

  // =========================================================================
  // Default generation
  // =========================================================================

  it("default generation creates file with valid content", async () => {
    const outPath = join(tmpDir, "collatr-edge.toml");
    const code = await configInitCommand(["--output", outPath]);

    expect(code).toBe(0);
    expect(stdout()).toContain("Generated default config");
    expect(stdout()).toContain(outPath);

    // File was created and has content
    const content = await Bun.file(outPath).text();
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("[agent]");
    expect(content).toContain("[global_tags]");
    expect(content).toContain("[[inputs.internal]]");
    expect(content).toContain("[outputs.local_store]");
  });

  // =========================================================================
  // File already exists
  // =========================================================================

  it("file exists without --force → exit 1 with error", async () => {
    const outPath = join(tmpDir, "existing.toml");
    writeFileSync(outPath, "# existing config\n");

    const code = await configInitCommand(["--output", outPath]);

    expect(code).toBe(1);
    expect(stderr()).toContain("File already exists");
    expect(stderr()).toContain("--force");
  });

  // =========================================================================
  // --force overwrites
  // =========================================================================

  it("--force overwrites existing file", async () => {
    const outPath = join(tmpDir, "overwrite.toml");
    writeFileSync(outPath, "# old content\n");

    const code = await configInitCommand(["--output", outPath, "--force"]);

    expect(code).toBe(0);
    const content = await Bun.file(outPath).text();
    expect(content).toContain("[agent]");
    expect(content).not.toContain("old content");
  });

  // =========================================================================
  // --output custom path
  // =========================================================================

  it("--output writes to specified path", async () => {
    const outPath = join(tmpDir, "custom", "my-config.toml");
    // Create the intermediate directory
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmpDir, "custom"), { recursive: true });

    const code = await configInitCommand(["--output", outPath]);

    expect(code).toBe(0);
    const exists = await Bun.file(outPath).exists();
    expect(exists).toBe(true);
  });

  // =========================================================================
  // --mode connected: Hub section uncommented
  // =========================================================================

  it("--mode connected includes Hub section uncommented", async () => {
    const outPath = join(tmpDir, "connected.toml");
    const code = await configInitCommand([
      "--output",
      outPath,
      "--mode",
      "connected",
    ]);

    expect(code).toBe(0);
    const content = await Bun.file(outPath).text();
    // Hub section should be uncommented (active TOML)
    expect(content).toMatch(/^\[agent\.hub\]/m);
    expect(content).toContain('mode = "connected"');
    expect(content).toContain("group_id");
    expect(content).toContain("broker");
  });

  // =========================================================================
  // --mode local_network: Hub section commented, network policy local
  // =========================================================================

  it("--mode local_network has Hub commented and local network policy", async () => {
    const outPath = join(tmpDir, "local.toml");
    const code = await configInitCommand([
      "--output",
      outPath,
      "--mode",
      "local_network",
    ]);

    expect(code).toBe(0);
    const content = await Bun.file(outPath).text();
    // Hub section should be commented out
    expect(content).not.toMatch(/^\[agent\.hub\]/m);
    expect(content).toContain("# [agent.hub]");
    // Network policy
    expect(content).toContain('mode = "local_network"');
  });

  // =========================================================================
  // --mode standalone: Hub commented, network policy blocks egress
  // =========================================================================

  it("--mode standalone has Hub commented and standalone network policy", async () => {
    const outPath = join(tmpDir, "standalone.toml");
    const code = await configInitCommand([
      "--output",
      outPath,
      "--mode",
      "standalone",
    ]);

    expect(code).toBe(0);
    const content = await Bun.file(outPath).text();
    // Hub section should be commented out
    expect(content).not.toMatch(/^\[agent\.hub\]/m);
    expect(content).toContain("# [agent.hub]");
    // Network policy
    expect(content).toContain('mode = "standalone"');
  });

  // =========================================================================
  // Generated config validates (most important integration test)
  // =========================================================================

  it("generated config (local_network) passes config validate", async () => {
    const outPath = join(tmpDir, "validate-local.toml");
    const initCode = await configInitCommand([
      "--output",
      outPath,
      "--mode",
      "local_network",
    ]);
    expect(initCode).toBe(0);

    // Clear stdout for validation output
    stdoutOutput.length = 0;

    const validateCode = await configValidateCommand(outPath);
    expect(validateCode).toBe(0);
    expect(stdout()).toContain("\u2713 Configuration valid");
  });

  it("generated config (connected) passes config validate", async () => {
    const outPath = join(tmpDir, "validate-connected.toml");
    const initCode = await configInitCommand([
      "--output",
      outPath,
      "--mode",
      "connected",
    ]);
    expect(initCode).toBe(0);

    // Clear stdout for validation output
    stdoutOutput.length = 0;

    const validateCode = await configValidateCommand(outPath);
    expect(validateCode).toBe(0);
    // Connected mode has hub with secret refs — should warn but not fail
    expect(stdout()).toContain("\u2713 Configuration valid");
  });

  it("generated config (standalone) passes config validate", async () => {
    const outPath = join(tmpDir, "validate-standalone.toml");
    const initCode = await configInitCommand([
      "--output",
      outPath,
      "--mode",
      "standalone",
    ]);
    expect(initCode).toBe(0);

    // Clear stdout for validation output
    stdoutOutput.length = 0;

    const validateCode = await configValidateCommand(outPath);
    expect(validateCode).toBe(0);
    expect(stdout()).toContain("\u2713 Configuration valid");
  });

  // =========================================================================
  // Template content checks
  // =========================================================================

  // =========================================================================
  // WebUI section in templates (Task 9.7)
  // =========================================================================

  it("connected template includes active [webui] section", () => {
    const template = generateConfigTemplate("connected");
    expect(template).toMatch(/^\[webui\]/m);
    expect(template).toContain("enabled = true");
    expect(template).toContain("port = 8080");
    expect(template).toContain('bind = "127.0.0.1"');
  });

  it("local_network template includes active [webui] section", () => {
    const template = generateConfigTemplate("local_network");
    expect(template).toMatch(/^\[webui\]/m);
    expect(template).toContain("enabled = true");
    expect(template).toContain("port = 8080");
  });

  it("standalone template has [webui] section commented out", () => {
    const template = generateConfigTemplate("standalone");
    // Should NOT have an active [webui] line
    expect(template).not.toMatch(/^\[webui\]/m);
    // Should have a commented version
    expect(template).toContain("# [webui]");
    expect(template).toContain("#   enabled = true");
  });

  it("generated standalone template with [webui] commented still parses", () => {
    const template = generateConfigTemplate("standalone");
    const config = parseConfig(template);
    // Default webui since it's commented out
    expect(config.webui.enabled).toBe(true);
    expect(config.webui.port).toBe(8080);
  });

  // =========================================================================
  // Template content checks
  // =========================================================================

  it("template includes commented examples for modbus, opcua, file", () => {
    const template = generateConfigTemplate("local_network");
    // Commented modbus example
    expect(template).toContain("# [[inputs.modbus]]");
    expect(template).toContain("# [[inputs.opcua]]");
    expect(template).toContain("# [[outputs.file]]");
    expect(template).toContain("# [[outputs.stdout]]");
    expect(template).toContain("# [[processors.rename]]");
    expect(template).toContain("# [[aggregators.basicstats]]");
  });

  it("success message includes validate and run instructions", async () => {
    const outPath = join(tmpDir, "instructions.toml");
    const code = await configInitCommand(["--output", outPath]);

    expect(code).toBe(0);
    expect(stdout()).toContain("config validate");
    expect(stdout()).toContain("collatr-edge run");
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  it("invalid --mode → exit 1 with error", async () => {
    const code = await configInitCommand(["--mode", "invalid"]);

    expect(code).toBe(1);
    expect(stderr()).toContain("Invalid mode");
  });

  // =========================================================================
  // Mode template parseability and network policy (Task 8.4)
  // =========================================================================

  describe("mode template parseability and policy", () => {
    it("all 3 mode templates generate valid configs that parse without error", () => {
      for (const mode of ["connected", "local_network", "standalone"] as const) {
        const template = generateConfigTemplate(mode);
        // parseConfig should not throw for any mode template
        const config = parseConfig(template);
        expect(config.networkPolicy.mode).toBe(mode);
        // All templates should have at least inputs.internal active
        expect(config.inputs.internal).toBeDefined();
        expect(config.inputs.internal!.length).toBeGreaterThan(0);
      }
    });

    it("standalone template does not include active (uncommented) MQTT outputs", () => {
      const template = generateConfigTemplate("standalone");

      // No uncommented [[outputs.mqtt]] lines in the template
      const lines = template.split("\n");
      const activeMqttOutputLines = lines.filter(
        (line) =>
          line.trim().startsWith("[[outputs.mqtt]]") ||
          line.trim() === "[outputs.mqtt]",
      );
      expect(activeMqttOutputLines).toHaveLength(0);

      // Verify at the parse level — no MQTT outputs in parsed config
      const config = parseConfig(template);
      expect(config.outputs.mqtt).toBeUndefined();
    });

    it("connected template passes validation without policy warnings", async () => {
      const outPath = join(tmpDir, "connected-no-warnings.toml");
      const initCode = await configInitCommand([
        "--output", outPath, "--mode", "connected",
      ]);
      expect(initCode).toBe(0);

      stdoutOutput.length = 0;

      const validateCode = await configValidateCommand(outPath);
      expect(validateCode).toBe(0);

      const out = stdout();
      // Should not have any policy-related WARNING lines
      // (Secret reference warnings use a different format: "⚠ Secret references found")
      expect(out).not.toContain("WARNING:");
      expect(out).toContain("CONNECTED");
      expect(out).toContain("\u2713 Configuration valid");
    });
  });
});
