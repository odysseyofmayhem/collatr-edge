// CollatrEdge — run command
// PRD refs: §8 Pipeline Lifecycle, §14 Error Handling, §18 CLI

import { loadConfigFile, type AgentConfig } from "../../core/config";
import { createLogger, getLogger, setGlobalLogger } from "../../core/logger";
import type { LogLevel } from "../../core/logger";
import { buildPipeline as buildPipelineFn } from "../../pipeline/plugin-factory";
import { PipelineRuntime, type PipelineOptions } from "../../pipeline/runtime";
import packageJson from "../../../package.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pipeline interface for dependency injection in tests. */
export interface PipelineLike {
  start(): Promise<void>;
  stop(): Promise<void>;
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
};

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

  // 5. Create runtime and start (PRD §8 startup sequence: connect outputs,
  //    start service inputs, begin gather loops)
  const pipeline = d.createRuntime(pipelineOptions);
  const startTime = Date.now();
  try {
    await pipeline.start();
  } catch (err) {
    log.error("failed to start pipeline", { error: (err as Error).message });
    return 1;
  }

  // 6. Log pipeline started + summary
  log.info("Pipeline started", {
    inputs: pipelineOptions.inputs.length,
    processors: pipelineOptions.processors.length,
    aggregators: pipelineOptions.aggregators.length,
    outputs: pipelineOptions.outputs.length,
  });

  // 7. Await termination signal (SIGINT or SIGTERM)
  const { promise: signalPromise, cleanup: cleanupSignal } = d.awaitSignal();
  const signal = await signalPromise;
  cleanupSignal();

  log.info(`Received ${signal}, shutting down...`);

  // 8. Register double-signal force exit + shutdown timeout (PRD §8 shutdown)
  const forceExitHandler = () => {
    log.warn("Received second signal, forcing exit");
    d.forceExit(1);
  };
  process.on("SIGINT", forceExitHandler);
  process.on("SIGTERM", forceExitHandler);

  const shutdownTimer = setTimeout(() => {
    log.error("Shutdown timeout (30s), forcing exit");
    d.forceExit(1);
  }, 30_000);
  // Unref so the timer doesn't keep the process alive if shutdown completes first
  if (shutdownTimer && typeof (shutdownTimer as Record<string, unknown>).unref === "function") {
    (shutdownTimer as unknown as { unref: () => void }).unref();
  }

  // 9. Graceful shutdown (PRD §8 shutdown sequence)
  try {
    await pipeline.stop();
  } catch (err) {
    log.error("shutdown error", { error: (err as Error).message });
  }

  // 10. Cleanup
  clearTimeout(shutdownTimer);
  process.off("SIGINT", forceExitHandler);
  process.off("SIGTERM", forceExitHandler);

  const uptimeS = Math.floor((Date.now() - startTime) / 1000);
  log.info("CollatrEdge stopped", { uptime_s: uptimeS });

  return 0;
}
