// CollatrEdge — run command
// PRD refs: §8 Pipeline Lifecycle, §14 Error Handling, §17 Web UI, §18 CLI

import { loadConfigFile, type AgentConfig } from "../../core/config";
import { createLogger, getLogger, setGlobalLogger } from "../../core/logger";
import type { LogLevel } from "../../core/logger";
import { buildPipeline as buildPipelineFn } from "../../pipeline/plugin-factory";
import { PipelineRuntime, type PipelineOptions } from "../../pipeline/runtime";
import { PipelineWebUIAdapter, type OpcuaInputInfo } from "../../web/adapter";
import { createWebServer, startWebServer, stopWebServer, type WebApp } from "../../web/server";
import { LocalStoreOutput } from "../../plugins/outputs/local-store";
import packageJson from "../../../package.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pipeline interface for dependency injection in tests. */
export interface PipelineLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Register a metric sink (Phase 9: Web UI live metrics). Only available on PipelineRuntime. */
  registerMetricSink?(callback: (metric: import("../../core/metric").Metric) => void): void;
  /** Pipeline state (Phase 9). Only available on PipelineRuntime. */
  readonly state?: string;
  /** Epoch ms when started (Phase 9). Only available on PipelineRuntime. */
  readonly startedAt?: number | null;
}

/**
 * Injectable dependencies for testing.
 * All fields optional when passed to runCommand — unset fields use real implementations.
 */
export interface RunCommandDeps {
  loadConfig: (path: string) => Promise<AgentConfig>;
  buildPipeline: (config: AgentConfig) => PipelineOptions;
  createRuntime: (options: PipelineOptions) => PipelineLike;
  /** Returns a promise that resolves with the signal name when SIGINT/SIGTERM is received. */
  awaitSignal: () => { promise: Promise<string>; cleanup: () => void };
  /** Called for force-exit on double-signal or shutdown timeout. */
  forceExit: (code: number) => void;
  /** Shutdown timeout in ms (safety net if graceful shutdown hangs). Default: 30000. */
  shutdownTimeoutMs: number;
}

function createDefaultSignalAwaiter(): { promise: Promise<string>; cleanup: () => void } {
  let sigintHandler: () => void;
  let sigtermHandler: () => void;

  const promise = new Promise<string>((resolve) => {
    sigintHandler = () => resolve("SIGINT");
    sigtermHandler = () => resolve("SIGTERM");
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);
  });

  const cleanup = () => {
    process.off("SIGINT", sigintHandler!);
    process.off("SIGTERM", sigtermHandler!);
  };

  return { promise, cleanup };
}

const DEFAULT_DEPS: RunCommandDeps = {
  loadConfig: loadConfigFile,
  buildPipeline: buildPipelineFn,
  createRuntime: (opts) => new PipelineRuntime(opts),
  awaitSignal: createDefaultSignalAwaiter,
  forceExit: (code) => process.exit(code),
  shutdownTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Web UI helpers
// ---------------------------------------------------------------------------

/**
 * Extract the LocalStoreOutput instance from pipeline outputs.
 * Returns null if no local_store output is configured.
 */
function findLocalStore(options: PipelineOptions): LocalStoreOutput | null {
  for (const output of options.outputs) {
    if (output.plugin instanceof LocalStoreOutput) {
      return output.plugin;
    }
  }
  return null;
}

/**
 * Extract OPC-UA input info from parsed config for the certificate helper page.
 * Returns empty array if no OPC-UA inputs are configured.
 */
function extractOpcuaInputInfo(config: AgentConfig): OpcuaInputInfo[] {
  const opcuaInstances = config.inputs.opcua ?? [];
  return opcuaInstances.map((instance) => ({
    alias: (instance.alias as string) ?? "opcua",
    endpoint: instance.endpoint as string,
    certificatePath: instance.certificate as string | undefined,
    privateKeyPath: instance.private_key as string | undefined,
  }));
}

/**
 * Determine whether the Web UI should be created.
 * Checks webui.enabled and network_policy.ingress.allow_local_webui.
 */
function shouldStartWebUI(config: AgentConfig): boolean {
  if (!config.webui.enabled) return false;
  if (!config.networkPolicy.ingress.allowLocalWebui) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Run command
// ---------------------------------------------------------------------------

/**
 * Start the agent: load config → build pipeline → run until signal → graceful shutdown.
 *
 * @param configPath  Path to the TOML config file
 * @param deps        Optional dependency overrides (for testing)
 * @returns Exit code (0 = success, 1 = error)
 */
export async function runCommand(
  configPath: string,
  deps: Partial<RunCommandDeps> = {},
): Promise<number> {
  const d: RunCommandDeps = { ...DEFAULT_DEPS, ...deps };

  // 1. Load and parse config (PRD §7)
  let config: AgentConfig;
  try {
    config = await d.loadConfig(configPath);
  } catch (err) {
    getLogger().error("failed to load config", {
      path: configPath,
      error: (err as Error).message,
    });
    return 1;
  }

  // 2. Configure logger from agent.log_level (PRD §15)
  setGlobalLogger(createLogger(config.agent.log_level as LogLevel));
  const log = getLogger();

  // 3. Log startup banner
  log.info("CollatrEdge starting", {
    version: packageJson.version,
    config: configPath,
    platform: `${process.platform}-${process.arch}`,
  });

  // 4. Build pipeline — validate + instantiate plugins (PRD §6, §7)
  let pipelineOptions: PipelineOptions;
  try {
    pipelineOptions = d.buildPipeline(config);
  } catch (err) {
    log.error("failed to build pipeline", { error: (err as Error).message });
    return 1;
  }

  // 5. Create runtime
  const pipeline = d.createRuntime(pipelineOptions);

  // 6. Set up Web UI adapter before pipeline.start() so metric sink is ready
  //    (the sink must be registered before start() wires it to the broadcaster)
  let webApp: WebApp | null = null;
  const webEnabled = shouldStartWebUI(config);

  if (!config.webui.enabled) {
    // Disabled in config — no logging needed
  } else if (!config.networkPolicy.ingress.allowLocalWebui) {
    log.info("Web UI disabled by network_policy (ingress.allow_local_webui = false)");
  }

  if (webEnabled && pipeline.registerMetricSink) {
    const localStore = findLocalStore(pipelineOptions);
    const opcuaInputs = extractOpcuaInputInfo(config);

    // Auto-generate admin_token if not configured (PRD §16: Admin auth on write endpoints)
    if (!config.webui.admin_token) {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      config.webui.admin_token = Buffer.from(bytes).toString("base64url");
      log.info("Web UI admin token generated (not configured in [webui])", {
        token: config.webui.admin_token,
      });
    }

    // Create adapter with pipeline as state source
    const stateSource = {
      get state() { return (pipeline as PipelineRuntime).state; },
      get startedAt() { return (pipeline as PipelineRuntime).startedAt; },
    };
    const adapter = new PipelineWebUIAdapter(
      pipelineOptions,
      stateSource,
      localStore,
      opcuaInputs,
    );

    // Register metric sink so live dashboard values are populated
    pipeline.registerMetricSink(adapter.handleMetric.bind(adapter));

    // Create the Elysia app (routes registered but not listening yet)
    webApp = createWebServer(config.webui, adapter);
  }

  // 7. Start pipeline (PRD §8 startup sequence: connect outputs,
  //    start service inputs, begin gather loops)
  const startTime = Date.now();
  try {
    await pipeline.start();
  } catch (err) {
    log.error("failed to start pipeline", { error: (err as Error).message });
    return 1;
  }

  // 8. Start Web UI after pipeline is running (PRD §17: served by same Bun process)
  if (webApp) {
    try {
      await startWebServer(webApp, config.webui);
      log.info(`Web UI available at http://${config.webui.bind}:${config.webui.port}`);
    } catch (err) {
      // Web UI failure doesn't prevent pipeline from running
      log.error("failed to start web UI", { error: (err as Error).message });
      webApp = null;
    }
  }

  // 9. Log pipeline started + summary
  log.info("Pipeline started", {
    inputs: pipelineOptions.inputs.length,
    processors: pipelineOptions.processors.length,
    aggregators: pipelineOptions.aggregators.length,
    outputs: pipelineOptions.outputs.length,
  });

  // 10. Await termination signal (SIGINT or SIGTERM)
  const { promise: signalPromise, cleanup: cleanupSignal } = d.awaitSignal();
  const signal = await signalPromise;
  cleanupSignal();

  log.info(`Received ${signal}, shutting down...`);

  // 11. Register double-signal force exit + shutdown timeout (PRD §8 shutdown)
  const forceExitHandler = () => {
    log.warn("Received second signal, forcing exit");
    d.forceExit(1);
  };
  process.on("SIGINT", forceExitHandler);
  process.on("SIGTERM", forceExitHandler);

  const shutdownTimer = setTimeout(() => {
    log.error("Shutdown timeout, forcing exit", { timeout_ms: d.shutdownTimeoutMs });
    d.forceExit(1);
  }, d.shutdownTimeoutMs);
  // Unref so the timer doesn't keep the process alive if shutdown completes first
  shutdownTimer.unref();

  // 12. Stop Web UI first (stop accepting requests before pipeline shutdown)
  if (webApp) {
    try {
      stopWebServer(webApp);
      log.debug("Web UI stopped");
    } catch (err) {
      log.error("web UI stop error", { error: (err as Error).message });
    }
  }

  // 13. Graceful pipeline shutdown (PRD §8 shutdown sequence)
  try {
    await pipeline.stop();
  } catch (err) {
    log.error("shutdown error", { error: (err as Error).message });
  }

  // 14. Cleanup
  clearTimeout(shutdownTimer);
  process.off("SIGINT", forceExitHandler);
  process.off("SIGTERM", forceExitHandler);

  const uptimeS = Math.floor((Date.now() - startTime) / 1000);
  log.info("CollatrEdge stopped", { uptime_s: uptimeS });

  return 0;
}
