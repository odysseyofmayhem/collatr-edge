// CollatrEdge — run command tests
// PRD refs: §8 Pipeline Lifecycle, §14 Error Handling, §18 CLI

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand, type RunCommandDeps } from "../../../src/cli/commands/run";
import {
  createLogger,
  setGlobalLogger,
  getLogger,
  type Logger,
} from "../../../src/core/logger";
import type { AgentConfig } from "../../../src/core/config";
import type { PipelineOptions } from "../../../src/pipeline/runtime";
import { resolveNetworkPolicy } from "../../../src/core/network-policy";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_CONFIG: AgentConfig = {
  agent: {
    interval: "10s",
    round_interval: true,
    collection_jitter: "0s",
    collection_offset: "0s",
    flush_interval: "10s",
    flush_jitter: "0s",
    precision: "1ms",
    log_level: "info",
  },
  global_tags: {},
  inputs: {},
  processors: {},
  aggregators: {},
  outputs: {},
  networkPolicy: resolveNetworkPolicy(),
  webui: { enabled: true, port: 8080, bind: "127.0.0.1" },
  secretRefs: [],
  warnings: [],
};

const MOCK_PIPELINE_OPTIONS: PipelineOptions = {
  inputs: [],
  processors: [],
  aggregators: [],
  outputs: [],
  gatherIntervalMs: 10_000,
  flushIntervalMs: 10_000,
};

/** Create a full set of mock deps with optional overrides. */
function mockDeps(
  overrides: Partial<RunCommandDeps> = {},
): Partial<RunCommandDeps> {
  return {
    loadConfig: async () => MOCK_CONFIG,
    buildPipeline: () => MOCK_PIPELINE_OPTIONS,
    createRuntime: () => ({
      start: async () => {},
      stop: async () => {},
    }),
    awaitSignal: () => ({
      promise: Promise.resolve("SIGINT"),
      cleanup: () => {},
    }),
    forceExit: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("run command", () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let stderrOutput: string[];
  let savedLogger: Logger;

  beforeEach(() => {
    stderrOutput = [];
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
    // Save logger for restoration after test
    savedLogger = getLogger();
    setGlobalLogger(createLogger());
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setGlobalLogger(savedLogger);
  });

  function stderr(): string {
    return stderrOutput.join("");
  }

  // =========================================================================
  // Config errors
  // =========================================================================

  it("missing config file → exit 1 with error", async () => {
    const code = await runCommand("/nonexistent/path/config.toml");
    expect(code).toBe(1);
    expect(stderr()).toContain("failed to load config");
    expect(stderr()).toContain("/nonexistent/path/config.toml");
  });

  it("invalid TOML → exit 1 with parse error", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "collatr-run-"));
    const configPath = join(tmpDir, "bad.toml");
    writeFileSync(configPath, "this is not [valid toml");

    try {
      const code = await runCommand(configPath);
      expect(code).toBe(1);
      expect(stderr()).toContain("failed to load config");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("invalid agent config → exit 1", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "collatr-run-"));
    const configPath = join(tmpDir, "bad-agent.toml");
    writeFileSync(configPath, `[agent]\ninterval = "not-a-duration"\n`);

    try {
      const code = await runCommand(configPath);
      expect(code).toBe(1);
      expect(stderr()).toContain("failed to load config");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Pipeline errors
  // =========================================================================

  it("buildPipeline throws → exit 1", async () => {
    const code = await runCommand("/any/path.toml", mockDeps({
      buildPipeline: () => {
        throw new Error("unknown plugin: banana");
      },
    }));
    expect(code).toBe(1);
    expect(stderr()).toContain("failed to build pipeline");
    expect(stderr()).toContain("unknown plugin: banana");
  });

  it("pipeline.start() throws (connect error) → exit 1", async () => {
    const code = await runCommand("/any/path.toml", mockDeps({
      createRuntime: () => ({
        start: async () => {
          throw new Error("output connect failed");
        },
        stop: async () => {},
      }),
    }));
    expect(code).toBe(1);
    expect(stderr()).toContain("failed to start pipeline");
    expect(stderr()).toContain("output connect failed");
  });

  // =========================================================================
  // Graceful shutdown
  // =========================================================================

  it("SIGINT → pipeline.stop() called, exit 0", async () => {
    let stopCalled = false;
    const code = await runCommand("/any/path.toml", mockDeps({
      createRuntime: () => ({
        start: async () => {},
        stop: async () => {
          stopCalled = true;
        },
      }),
    }));
    expect(code).toBe(0);
    expect(stopCalled).toBe(true);
  });

  it("SIGTERM → pipeline.stop() called, exit 0 (systemd production path)", async () => {
    let stopCalled = false;
    const code = await runCommand("/any/path.toml", mockDeps({
      awaitSignal: () => ({
        promise: Promise.resolve("SIGTERM"),
        cleanup: () => {},
      }),
      createRuntime: () => ({
        start: async () => {},
        stop: async () => {
          stopCalled = true;
        },
      }),
    }));
    expect(code).toBe(0);
    expect(stopCalled).toBe(true);
    expect(stderr()).toContain("Received SIGTERM");
  });

  it("logs startup banner and shutdown summary", async () => {
    const code = await runCommand("/any/path.toml", mockDeps());
    expect(code).toBe(0);
    expect(stderr()).toContain("CollatrEdge starting");
    expect(stderr()).toContain("Pipeline started");
    expect(stderr()).toContain("Received SIGINT");
    expect(stderr()).toContain("CollatrEdge stopped");
  });

  it("startup banner includes version and config path", async () => {
    const code = await runCommand("/my/custom/config.toml", mockDeps());
    expect(code).toBe(0);
    expect(stderr()).toContain("/my/custom/config.toml");
    expect(stderr()).toContain("0.1.0");
  });

  it("pipeline started log includes plugin counts", async () => {
    const opts: PipelineOptions = {
      ...MOCK_PIPELINE_OPTIONS,
      inputs: [{ plugin: { gather: async () => {} } }],
      outputs: [
        { plugin: { connect: async () => {}, write: async () => {}, close: async () => {} } },
      ],
    };
    const code = await runCommand("/any/path.toml", mockDeps({
      buildPipeline: () => opts,
    }));
    expect(code).toBe(0);
    // Parse the "Pipeline started" log line from stderr
    const lines = stderrOutput.filter((l) => l.includes("Pipeline started"));
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.inputs).toBe(1);
    expect(parsed.outputs).toBe(1);
    expect(parsed.processors).toBe(0);
    expect(parsed.aggregators).toBe(0);
  });

  it("configures logger from agent.log_level", async () => {
    const debugConfig: AgentConfig = {
      ...MOCK_CONFIG,
      agent: { ...MOCK_CONFIG.agent, log_level: "debug" },
    };
    const code = await runCommand("/any/path.toml", mockDeps({
      loadConfig: async () => debugConfig,
    }));
    expect(code).toBe(0);
    // After configuring the logger with debug level, info-level startup banner is visible
    expect(stderr()).toContain("CollatrEdge starting");
  });

  it("shutdown error is logged but still returns 0", async () => {
    const code = await runCommand("/any/path.toml", mockDeps({
      createRuntime: () => ({
        start: async () => {},
        stop: async () => {
          throw new Error("cleanup failed");
        },
      }),
    }));
    expect(code).toBe(0);
    expect(stderr()).toContain("shutdown error");
    expect(stderr()).toContain("cleanup failed");
  });

  // =========================================================================
  // Double signal / force exit
  // =========================================================================

  it("shutdown timeout → forceExit called", async () => {
    let forceExitCode: number | null = null;
    let resolveStop: (() => void) | undefined;

    const runPromise = runCommand("/any/path.toml", mockDeps({
      createRuntime: () => ({
        start: async () => {},
        stop: () =>
          new Promise<void>((resolve) => {
            resolveStop = resolve;
          }),
      }),
      shutdownTimeoutMs: 50, // Very short timeout for test
      forceExit: (code) => {
        forceExitCode = code;
        resolveStop?.();
      },
    }));

    await runPromise;

    expect(forceExitCode).toBe(1);
    expect(stderr()).toContain("Shutdown timeout");
  }, 5_000);

  // =========================================================================
  // Web UI integration (Task 9.7)
  // =========================================================================

  it("webui.enabled=false → no web UI URL in logs", async () => {
    const noWebConfig: AgentConfig = {
      ...MOCK_CONFIG,
      webui: { enabled: false, port: 8080, bind: "127.0.0.1" },
    };
    const code = await runCommand("/any/path.toml", mockDeps({
      loadConfig: async () => noWebConfig,
    }));
    expect(code).toBe(0);
    // Should NOT log any web UI URL
    expect(stderr()).not.toContain("Web UI available at");
  });

  it("ingress allow_local_webui=false → logs reason, no web server", async () => {
    const blockedConfig: AgentConfig = {
      ...MOCK_CONFIG,
      networkPolicy: resolveNetworkPolicy({
        mode: "standalone",
        ingress: { allow_local_webui: false },
      }),
    };
    const code = await runCommand("/any/path.toml", mockDeps({
      loadConfig: async () => blockedConfig,
    }));
    expect(code).toBe(0);
    expect(stderr()).toContain("Web UI disabled by network_policy");
    expect(stderr()).not.toContain("Web UI available at");
  });

  it("webui enabled with registerMetricSink → web server starts and stops", async () => {
    let metricSinkRegistered = false;
    let webStarted = false;

    // Use a random high port to avoid conflicts
    const testPort = 18000 + Math.floor(Math.random() * 1000);
    const webConfig: AgentConfig = {
      ...MOCK_CONFIG,
      webui: { enabled: true, port: testPort, bind: "127.0.0.1" },
    };

    const code = await runCommand("/any/path.toml", {
      ...mockDeps({
        loadConfig: async () => webConfig,
      }),
      createRuntime: () => ({
        start: async () => {},
        stop: async () => {},
        registerMetricSink: () => { metricSinkRegistered = true; },
        state: "running" as const,
        startedAt: Date.now(),
      }),
    });

    expect(code).toBe(0);
    expect(metricSinkRegistered).toBe(true);
    // The web UI URL should be logged
    expect(stderr()).toContain("Web UI available at");
    expect(stderr()).toContain(String(testPort));
  });

  it("webui enabled but registerMetricSink missing → no web server (mock pipeline)", async () => {
    // Default mock pipeline has no registerMetricSink — web UI should be skipped
    const code = await runCommand("/any/path.toml", mockDeps());
    expect(code).toBe(0);
    // No web UI URL logged (mock doesn't support it)
    expect(stderr()).not.toContain("Web UI available at");
  });

  // =========================================================================
  // Double signal / force exit
  // =========================================================================

  it("double signal during shutdown → forceExit called", async () => {
    let forceExitCode: number | null = null;
    let resolveStop: (() => void) | undefined;

    const runPromise = runCommand("/any/path.toml", mockDeps({
      createRuntime: () => ({
        start: async () => {},
        stop: () =>
          new Promise<void>((resolve) => {
            resolveStop = resolve;
          }),
      }),
      forceExit: (code) => {
        forceExitCode = code;
        // Unblock the hanging stop() so runCommand can complete
        resolveStop?.();
      },
    }));

    // Allow runCommand to progress past all resolved awaits to await pipeline.stop()
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Emit second signal during shutdown — triggers the forceExitHandler
    process.emit("SIGINT");

    // Wait for runCommand to finish (forceExit resolved the stop promise)
    await runPromise;

    expect(forceExitCode).toBe(1);
    expect(stderr()).toContain("Received second signal");
  }, 5_000);
});
