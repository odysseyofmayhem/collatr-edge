// CollatrEdge — config validate command tests
// PRD refs: §7 Configuration, §14 Error Handling

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
import { configValidateCommand } from "../../../src/cli/commands/config-validate";

describe("config validate command", () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let stdoutOutput: string[];
  let stderrOutput: string[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "collatr-validate-"));
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

  function writeConfig(filename: string, content: string): string {
    const path = join(tmpDir, filename);
    writeFileSync(path, content);
    return path;
  }

  // =========================================================================
  // Valid config
  // =========================================================================

  it("valid minimal config → exit 0, checkmarks", async () => {
    const path = writeConfig(
      "valid.toml",
      `
[agent]
interval = "10s"

[[inputs.internal]]
collect_memstats = true

[[outputs.stdout]]
data_format = "json"
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0);
    expect(out).toContain("\u2713 TOML syntax valid");
    expect(out).toContain("\u2713 [agent] section valid");
    expect(out).toContain("\u2713 [global_tags] valid");
    expect(out).toContain("1 input configured");
    expect(out).toContain("inputs.internal[0]");
    expect(out).toContain("valid");
    expect(out).toContain("1 output configured");
    expect(out).toContain("outputs.stdout[0]");
    expect(out).toContain("\u2713 Configuration valid");
  });

  it("valid config with alias shows alias in output", async () => {
    const path = writeConfig(
      "alias.toml",
      `
[agent]

[[inputs.internal]]
alias = "self_metrics"
collect_memstats = true

[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0);
    expect(out).toContain("(alias: self_metrics)");
  });

  // =========================================================================
  // Invalid agent section
  // =========================================================================

  it("invalid agent section → exit 1, error details", async () => {
    const path = writeConfig(
      "bad-agent.toml",
      `
[agent]
interval = "not-a-duration"

[[inputs.internal]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(1);
    expect(out).toContain("\u2713 TOML syntax valid");
    expect(out).toContain("\u2717");
    expect(out).toContain("Invalid [agent]");
    expect(out).toContain("interval");
  });

  // =========================================================================
  // Invalid TOML syntax
  // =========================================================================

  it("invalid TOML → exit 1, TOML parse error", async () => {
    const path = writeConfig(
      "bad-toml.toml",
      `
[agent
  interval = "10s"
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(1);
    expect(out).toContain("\u2717");
    expect(out).toContain("Invalid TOML");
  });

  // =========================================================================
  // Unknown plugin type
  // =========================================================================

  it("unknown plugin type → warning, doesn't error", async () => {
    const path = writeConfig(
      "unknown-plugin.toml",
      `
[agent]

[[inputs.future_sensor]]
endpoint = "tcp://192.168.1.99:5020"

[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0);
    expect(out).toContain("\u26A0");
    expect(out).toContain("inputs.future_sensor[0]");
    expect(out).toContain("unknown plugin type");
    expect(out).toContain("\u2713 Configuration valid");
  });

  // =========================================================================
  // Invalid plugin config
  // =========================================================================

  it("invalid plugin config → exit 1, plugin-specific error", async () => {
    const path = writeConfig(
      "bad-plugin.toml",
      `
[agent]

[[inputs.modbus]]
# Missing required 'controller' field

[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(1);
    expect(out).toContain("\u2717");
    expect(out).toContain("inputs.modbus[0]");
    expect(out).toContain("invalid");
    expect(out).toContain("\u2717 Configuration has errors");
  });

  // =========================================================================
  // Secret references
  // =========================================================================

  it("secret references → listed as warnings, doesn't fail", async () => {
    const path = writeConfig(
      "secrets.toml",
      `
[agent]
[agent.hub]
group_id = "plant_floor"
edge_node_id = "node_01"
broker = "mqtts://hub.example.com:8883"
tls_cert = "@{secrets:hub_cert}"
tls_key = "@{secrets:hub_key}"

[[inputs.internal]]
[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0);
    expect(out).toContain("\u26A0 Secret references found");
    expect(out).toContain("@{secrets:hub_cert}");
    expect(out).toContain("@{secrets:hub_key}");
    expect(out).toContain("\u2713 Configuration valid");
  });

  // =========================================================================
  // Missing config file
  // =========================================================================

  it("missing config file → exit 1, file not found", async () => {
    const code = await configValidateCommand("/nonexistent/path/config.toml");
    const out = stdout();

    expect(code).toBe(1);
    expect(out).toContain("\u2717");
    expect(out).toContain("Config file not found");
  });

  // =========================================================================
  // Empty config (all defaults)
  // =========================================================================

  it("empty config → valid (all defaults), exit 0", async () => {
    const path = writeConfig("empty.toml", "");

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0);
    expect(out).toContain("\u2713 TOML syntax valid");
    expect(out).toContain("\u2713 [agent] section valid");
    expect(out).toContain("\u2713 Configuration valid");
  });

  // =========================================================================
  // Multiple plugins
  // =========================================================================

  it("multiple inputs and outputs are all validated", async () => {
    const path = writeConfig(
      "multi.toml",
      `
[agent]

[[inputs.internal]]
collect_memstats = true

[[inputs.internal]]
alias = "second_internal"
collect_memstats = false

[[outputs.stdout]]
data_format = "json"

[[outputs.file]]
path = "/tmp/test-metrics.json"
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0);
    expect(out).toContain("2 inputs configured");
    expect(out).toContain("inputs.internal[0]");
    expect(out).toContain("inputs.internal[1]");
    expect(out).toContain("2 outputs configured");
    expect(out).toContain("outputs.stdout[0]");
    expect(out).toContain("outputs.file[0]");
  });

  // =========================================================================
  // Network policy in validation output (Task 8.1)
  // =========================================================================

  it("validation output includes network policy section", async () => {
    const path = writeConfig(
      "policy.toml",
      `
[agent]

[network_policy]
mode = "local_network"

[network_policy.egress]
allowed_hosts = ["192.168.1.50:8086"]

[[inputs.internal]]
[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0);
    expect(out).toContain("[network_policy]");
    expect(out).toContain("LOCAL NETWORK");
    expect(out).toContain("mode: local_network");
    expect(out).toContain("DNS blocked");
    expect(out).toContain("Hub blocked");
    expect(out).toContain("1 allowed hosts");
  });

  it("config without [network_policy] shows connected mode in validation", async () => {
    const path = writeConfig(
      "no-policy.toml",
      `
[agent]
[[inputs.internal]]
[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0);
    expect(out).toContain("CONNECTED");
    expect(out).toContain("mode: connected");
  });

  it("hub + standalone policy → warning in validate output", async () => {
    const path = writeConfig(
      "hub-standalone.toml",
      `
[agent]
[agent.hub]
enabled = true
group_id = "plant"
edge_node_id = "node1"
broker = "mqtts://hub.collatr.com:8883"

[network_policy]
mode = "standalone"

[[inputs.internal]]
[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0); // syntactically valid config
    expect(out).toContain("WARNING:");
    expect(out).toContain("Hub credentials configured");
    expect(out).toContain("prevents Hub connectivity");
  });

  it("invalid network_policy mode → exit 1 with error", async () => {
    const path = writeConfig(
      "bad-policy.toml",
      `
[agent]

[network_policy]
mode = "bogus"

[[inputs.internal]]
[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(1);
    expect(out).toContain("\u2713 TOML syntax valid");
    expect(out).toContain("\u2713 [agent] section valid");
    expect(out).toContain("\u2717");
    expect(out).toContain("Invalid [network_policy]");
  });

  // =========================================================================
  // Mixed valid and invalid plugins
  // =========================================================================

  it("one valid and one invalid plugin → exit 1, both reported", async () => {
    const path = writeConfig(
      "mixed.toml",
      `
[agent]

[[inputs.internal]]
collect_memstats = true

[[inputs.modbus]]
# Missing required controller

[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(1);
    expect(out).toContain("inputs.internal[0]");
    expect(out).toContain("valid");
    expect(out).toContain("inputs.modbus[0]");
    expect(out).toContain("invalid");
  });

  // =========================================================================
  // Processors and aggregators
  // =========================================================================

  it("validates processors and aggregators", async () => {
    const path = writeConfig(
      "full.toml",
      `
[agent]

[[inputs.internal]]

[[processors.rename]]
[[processors.rename.replace]]
field = "old"
dest = "new"

[[aggregators.basicstats]]
period = "30s"
drop_original = false

[[outputs.stdout]]
`,
    );

    const code = await configValidateCommand(path);
    const out = stdout();

    expect(code).toBe(0);
    expect(out).toContain("1 processor configured");
    expect(out).toContain("processors.rename[0]");
    expect(out).toContain("1 aggregator configured");
    expect(out).toContain("aggregators.basicstats[0]");
    expect(out).toContain("\u2713 Configuration valid");
  });
});
