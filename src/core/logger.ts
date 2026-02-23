// CollatrEdge — Structured JSON Logger
// PRD refs: §15 Observability — Logging

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(context: Record<string, string>, levelOverride?: LogLevel): Logger;
}

/**
 * Create a structured JSON logger.
 *
 * Output format (one JSON line per entry to stderr):
 * {"ts":"2026-02-22T10:30:00.123Z","level":"warn","msg":"gather timeout","plugin":"inputs.modbus.plc_01"}
 */
export function createLogger(
  level: LogLevel = "info",
  context: Record<string, string> = {},
): Logger {
  const minLevel = LEVEL_ORDER[level];

  function emit(lvl: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_ORDER[lvl] < minLevel) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      ...context,
      msg,
      ...extra,
    };
    process.stderr.write(JSON.stringify(entry) + "\n");
  }

  return {
    debug(msg, extra) { emit("debug", msg, extra); },
    info(msg, extra) { emit("info", msg, extra); },
    warn(msg, extra) { emit("warn", msg, extra); },
    error(msg, extra) { emit("error", msg, extra); },
    child(childContext, levelOverride) {
      return createLogger(levelOverride ?? level, { ...context, ...childContext });
    },
  };
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let globalLogger: Logger = createLogger();

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger;
}

export function getLogger(): Logger {
  return globalLogger;
}
