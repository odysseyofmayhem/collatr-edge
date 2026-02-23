// CollatrEdge — CLI framework
// PRD refs: §18 Deployment & Distribution (CLI command list)

import { getLogger } from "../core/logger";
import { configValidateCommand } from "./commands/config-validate";
import { versionCommand } from "./commands/version";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `CollatrEdge — IIoT data collection agent

Usage: collatr-edge [command] [options]

Commands:
  run              Start the agent
  config init      Generate default configuration
  config validate  Validate a configuration file
  version          Print version and build info

Global options:
  --help, -h       Show help
  --config, -c     Config file path (default: /etc/collatr-edge/config.toml)
                   Can also be set via COLLATR_EDGE_CONFIG env var
`;

// ---------------------------------------------------------------------------
// Arg parsing utilities
// ---------------------------------------------------------------------------

export interface ParsedGlobalOptions {
  configPath: string;
}

const DEFAULT_CONFIG_PATH = "/etc/collatr-edge/config.toml";

/**
 * Extract global options (--config/-c) from args.
 * Returns the parsed options and the remaining args with global flags removed.
 */
export function parseGlobalOptions(args: string[]): {
  options: ParsedGlobalOptions;
  remaining: string[];
} {
  const configFromEnv = process.env.COLLATR_EDGE_CONFIG;
  let configPath = configFromEnv || DEFAULT_CONFIG_PATH;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--config" || arg === "-c") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write(`Error: ${arg} requires a path argument\n`);
        configPath = DEFAULT_CONFIG_PATH;
      } else {
        configPath = next;
        i++; // skip the value
      }
    } else {
      remaining.push(arg);
    }
  }

  return { options: { configPath }, remaining };
}

// ---------------------------------------------------------------------------
// Subcommand routing
// ---------------------------------------------------------------------------

function helpCommand(): number {
  process.stdout.write(HELP_TEXT);
  return 0;
}

/**
 * Route `config` subcommands (init, validate).
 * Stubs return 1 until implemented in later tasks.
 */
async function configCommand(
  args: string[],
  options: ParsedGlobalOptions,
): Promise<number> {
  const subcommand = args[0];
  switch (subcommand) {
    case "init":
      // Implemented in task 6.4
      process.stderr.write("Error: config init not yet implemented\n");
      return 1;
    case "validate":
      return await configValidateCommand(options.configPath);
    default:
      process.stderr.write(
        subcommand
          ? `Error: unknown config subcommand: ${subcommand}\n\n`
          : "Error: missing config subcommand\n\n",
      );
      process.stdout.write(
        "Usage: collatr-edge config <init|validate> [options]\n",
      );
      return 1;
  }
}

/**
 * CLI entry point. Parses argv and routes to the appropriate subcommand.
 * Returns an exit code (0 = success, 1 = error).
 * Only src/index.ts should call process.exit() with this return value.
 */
export async function main(
  args: string[] = process.argv.slice(2),
): Promise<number> {
  // Parse global options first (--config/-c)
  const { options, remaining } = parseGlobalOptions(args);
  const command = remaining[0];

  switch (command) {
    case "run":
      // Implemented in task 6.6
      process.stderr.write("Error: run command not yet implemented\n");
      return 1;
    case "config":
      return await configCommand(remaining.slice(1), options);
    case "version":
      return versionCommand();
    case "--help":
    case "-h":
    case undefined:
      return helpCommand();
    default:
      getLogger().error("unknown command", { command });
      process.stderr.write(`Unknown command: ${command}\n\n`);
      helpCommand();
      return 1;
  }
}
