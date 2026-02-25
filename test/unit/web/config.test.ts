// CollatrEdge — WebUI config parsing tests
// PRD refs: §7 Configuration, §17 Local Web UI
// Phase 9 Task 9.7: config parsing for [webui] section

import { describe, it, expect } from "bun:test";
import { parseConfig, type WebUIConfig } from "../../../src/core/config";

describe("WebUI config parsing", () => {
  // =========================================================================
  // Defaults
  // =========================================================================

  it("config without [webui] section defaults to enabled=true, port=8080, bind=127.0.0.1", () => {
    const config = parseConfig(`
[agent]
interval = "10s"
`);
    expect(config.webui).toBeDefined();
    expect(config.webui.enabled).toBe(true);
    expect(config.webui.port).toBe(8080);
    expect(config.webui.bind).toBe("127.0.0.1");
  });

  // =========================================================================
  // Explicit values
  // =========================================================================

  it("config with [webui] section parses all fields", () => {
    const config = parseConfig(`
[agent]

[webui]
enabled = false
port = 9090
bind = "0.0.0.0"
`);
    expect(config.webui.enabled).toBe(false);
    expect(config.webui.port).toBe(9090);
    expect(config.webui.bind).toBe("0.0.0.0");
  });

  it("config with partial [webui] fills defaults for missing fields", () => {
    const config = parseConfig(`
[agent]

[webui]
port = 3000
`);
    expect(config.webui.enabled).toBe(true);
    expect(config.webui.port).toBe(3000);
    expect(config.webui.bind).toBe("127.0.0.1");
  });

  it("webui.enabled=false is respected", () => {
    const config = parseConfig(`
[agent]

[webui]
enabled = false
`);
    expect(config.webui.enabled).toBe(false);
    // Port and bind still get defaults
    expect(config.webui.port).toBe(8080);
    expect(config.webui.bind).toBe("127.0.0.1");
  });

  // =========================================================================
  // Validation errors
  // =========================================================================

  it("invalid port (0) throws validation error", () => {
    expect(() => parseConfig(`
[agent]

[webui]
port = 0
`)).toThrow("Invalid [webui]");
  });

  it("invalid port (65536) throws validation error", () => {
    expect(() => parseConfig(`
[agent]

[webui]
port = 65536
`)).toThrow("Invalid [webui]");
  });

  it("invalid port (non-integer) throws validation error", () => {
    expect(() => parseConfig(`
[agent]

[webui]
port = 8080.5
`)).toThrow("Invalid [webui]");
  });

  it("invalid enabled (string) throws validation error", () => {
    expect(() => parseConfig(`
[agent]

[webui]
enabled = "yes"
`)).toThrow("Invalid [webui]");
  });

  // =========================================================================
  // Integration with other config sections
  // =========================================================================

  it("webui config coexists with all other sections", () => {
    const config = parseConfig(`
[agent]
interval = "10s"

[global_tags]
site = "factory"

[network_policy]
mode = "local_network"

[webui]
port = 9090

[[inputs.internal]]
collect_memstats = true

[outputs.local_store]
path = "/tmp/test"
`);
    expect(config.webui.port).toBe(9090);
    expect(config.webui.enabled).toBe(true);
    expect(config.agent.interval).toBe("10s");
    expect(config.global_tags.site).toBe("factory");
    expect(config.networkPolicy.mode).toBe("local_network");
    expect(config.inputs.internal).toBeDefined();
    expect(config.outputs.local_store).toBeDefined();
  });
});
