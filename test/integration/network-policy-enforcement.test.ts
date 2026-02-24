// CollatrEdge — Integration tests: Network policy enforcement
// PRD refs: §10 Network Policy, §16 Security, §22 Acceptance Criteria
//
// Tests the full path: TOML config → parseConfig → buildPipeline → PipelineRuntime
// with network policy enforcement at each stage.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { parseConfig } from "@core/config";
import { buildPipeline } from "@pipeline/plugin-factory";
import { PipelineRuntime } from "@pipeline/runtime";
import { PolicyViolationError } from "@core/network-policy";

// ---------------------------------------------------------------------------
// TOML config fixtures
// ---------------------------------------------------------------------------

/** Standalone mode + MQTT output → should fail at output.connect() */
const STANDALONE_MQTT_TOML = `
[agent]
  interval = "100ms"
  flush_interval = "100ms"

[network_policy]
  mode = "standalone"

[[inputs.internal]]

[[outputs.mqtt]]
  servers = ["tcp://192.168.1.10:1883"]
  topic = "test/metrics"
`;

/** Local network mode + stdout only → should start/stop cleanly */
const LOCAL_NETWORK_STDOUT_TOML = `
[agent]
  interval = "100ms"
  flush_interval = "100ms"

[network_policy]
  mode = "local_network"

[[inputs.internal]]

[[outputs.stdout]]
`;

/** Connected mode + hub + sparkplug → buildPipeline creates hub link */
const CONNECTED_HUB_SPARKPLUG_TOML = `
[agent]
  interval = "100ms"
  flush_interval = "100ms"

[agent.hub]
  enabled = true
  group_id = "factory"
  edge_node_id = "edge1"
  broker = "mqtt://hub.collatr.cloud:1883"
  heartbeat_interval = "30s"

[network_policy]
  mode = "connected"

[[inputs.internal]]

[[outputs.mqtt]]
  sparkplug = true
`;

/** Local network + MQTT targeting an allowed host → buildPipeline succeeds */
const LOCAL_NETWORK_MQTT_ALLOWED_TOML = `
[agent]
  interval = "100ms"
  flush_interval = "100ms"

[network_policy]
  mode = "local_network"

[network_policy.egress]
  allowed_hosts = ["192.168.1.10:1883"]

[[inputs.internal]]

[[outputs.mqtt]]
  servers = ["tcp://192.168.1.10:1883"]
  topic = "test/metrics"
`;

/** Local network + MQTT targeting a disallowed host → should fail at connect() */
const LOCAL_NETWORK_MQTT_DISALLOWED_TOML = `
[agent]
  interval = "100ms"
  flush_interval = "100ms"

[network_policy]
  mode = "local_network"

[[inputs.internal]]

[[outputs.mqtt]]
  servers = ["tcp://10.0.0.50:1883"]
  topic = "test/metrics"
`;

/** Standalone mode + local_store only → should start/stop cleanly (no network) */
const STANDALONE_LOCAL_STORE_TOML = `
[agent]
  interval = "100ms"
  flush_interval = "100ms"

[network_policy]
  mode = "standalone"

[[inputs.internal]]

[[outputs.local_store]]
  path = ":memory:"
`;

/** Hub enabled + local_network → buildPipeline throws (hub broker is hostname) */
const HUB_LOCAL_NETWORK_TOML = `
[agent]
  interval = "100ms"
  flush_interval = "100ms"

[agent.hub]
  enabled = true
  group_id = "factory"
  edge_node_id = "edge1"
  broker = "mqtt://hub.collatr.cloud:1883"
  heartbeat_interval = "30s"

[network_policy]
  mode = "local_network"

[[inputs.internal]]

[[outputs.stdout]]
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("network policy enforcement (integration)", () => {
  let stderrOutput: string[];
  let stderrSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrOutput = [];
    // Capture logger output (writes to stderr)
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderrOutput.push(
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
        );
        return true;
      },
    );
    // Suppress stdout output from stdout plugin
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 1. standalone + MQTT → start() throws PolicyViolationError
  // -------------------------------------------------------------------------

  it("standalone + MQTT output → start() throws PolicyViolationError", async () => {
    const config = parseConfig(STANDALONE_MQTT_TOML);
    const opts = buildPipeline(config);
    const runtime = new PipelineRuntime(opts);

    let thrown: unknown;
    try {
      await runtime.start();
    } catch (err) {
      thrown = err;
    } finally {
      await runtime.stop();
    }

    expect(thrown).toBeInstanceOf(PolicyViolationError);
    expect((thrown as PolicyViolationError).policyMode).toBe("standalone");
  });

  // -------------------------------------------------------------------------
  // 2. local_network + stdout only → start succeeds
  // -------------------------------------------------------------------------

  it("local_network + stdout only → starts and stops cleanly", async () => {
    const config = parseConfig(LOCAL_NETWORK_STDOUT_TOML);
    const opts = buildPipeline(config);
    const runtime = new PipelineRuntime(opts);

    await runtime.start();
    await runtime.stop();
    // No error = success
  });

  // -------------------------------------------------------------------------
  // 3. connected + hub + sparkplug → buildPipeline creates hub link
  // -------------------------------------------------------------------------

  it("connected + hub + sparkplug → buildPipeline creates hub link", () => {
    const config = parseConfig(CONNECTED_HUB_SPARKPLUG_TOML);
    const opts = buildPipeline(config);

    expect(opts.hubLink).toBeDefined();
    expect(opts.outputs).toHaveLength(1);
    expect(opts.networkPolicy?.mode).toBe("connected");
  });

  // -------------------------------------------------------------------------
  // 4. local_network + allowed MQTT host → buildPipeline succeeds
  // -------------------------------------------------------------------------

  it("local_network + allowed MQTT host → buildPipeline succeeds", () => {
    const config = parseConfig(LOCAL_NETWORK_MQTT_ALLOWED_TOML);
    const opts = buildPipeline(config);

    expect(opts.outputs).toHaveLength(1);
    expect(opts.networkPolicy?.mode).toBe("local_network");

    // Verify policy allows this specific host:port
    const checkResult = config.networkPolicy.checkEgress({
      host: "192.168.1.10",
      port: 1883,
      protocol: "mqtt",
      description: "test",
    });
    expect(checkResult.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. local_network + disallowed MQTT host → start() throws
  // -------------------------------------------------------------------------

  it("local_network + disallowed MQTT host → start() throws PolicyViolationError", async () => {
    const config = parseConfig(LOCAL_NETWORK_MQTT_DISALLOWED_TOML);
    const opts = buildPipeline(config);
    const runtime = new PipelineRuntime(opts);

    let thrown: unknown;
    try {
      await runtime.start();
    } catch (err) {
      thrown = err;
    } finally {
      await runtime.stop();
    }

    expect(thrown).toBeInstanceOf(PolicyViolationError);
    expect((thrown as PolicyViolationError).policyMode).toBe("local_network");
  });

  // -------------------------------------------------------------------------
  // 6. hub + local_network → buildPipeline throws (before runtime)
  // -------------------------------------------------------------------------

  it("hub enabled + local_network → buildPipeline throws PolicyViolationError", () => {
    const config = parseConfig(HUB_LOCAL_NETWORK_TOML);

    let thrown: unknown;
    try {
      buildPipeline(config);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PolicyViolationError);
    expect((thrown as PolicyViolationError).policyMode).toBe("local_network");
  });

  // -------------------------------------------------------------------------
  // 7. standalone + local_store only → starts cleanly (no network = not blocked)
  // -------------------------------------------------------------------------

  it("standalone + local_store only → starts and stops cleanly", async () => {
    const config = parseConfig(STANDALONE_LOCAL_STORE_TOML);
    const opts = buildPipeline(config);
    const runtime = new PipelineRuntime(opts);

    await runtime.start();
    await runtime.stop();
    // No error = success — local_store is never blocked by network policy
  });

  // -------------------------------------------------------------------------
  // 8. network policy summary logged at startup
  // -------------------------------------------------------------------------

  it("logs network policy summary at startup", async () => {
    const config = parseConfig(LOCAL_NETWORK_STDOUT_TOML);
    const opts = buildPipeline(config);
    const runtime = new PipelineRuntime(opts);

    await runtime.start();
    await runtime.stop();

    const logOutput = stderrOutput.join("");
    // Runtime logs: getLogger().info("network policy", { mode, summary })
    expect(logOutput).toContain("network policy");
    expect(logOutput).toContain("local_network");
    expect(logOutput).toContain("[LOCAL NETWORK]");
  });
});
