// CollatrEdge — config validate command
// PRD refs: §7 Configuration, §14 Error Handling

import { loadConfigFile, parseConfig } from "../../core/config";
import type { AgentConfig, PluginInstanceConfig } from "../../core/config";
import { PLUGIN_SCHEMAS } from "../../core/plugin-schemas";
import { z } from "zod/v4";

/**
 * Validate a config file: parse TOML, validate [agent], validate per-plugin schemas.
 * Outputs human-readable results to stdout.
 * Returns 0 if valid, 1 if invalid.
 */
export async function configValidateCommand(
  configPath: string,
): Promise<number> {
  let config: AgentConfig;

  // 1. Load and parse config (TOML syntax + agent section validation)
  try {
    config = await loadConfigFile(configPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish TOML syntax vs agent validation vs file-not-found
    if (msg.startsWith("Config file not found")) {
      process.stdout.write(`\u2717 ${msg}\n`);
    } else if (msg.startsWith("Invalid TOML")) {
      process.stdout.write(`\u2717 ${msg}\n`);
    } else if (msg.startsWith("Invalid [agent]")) {
      process.stdout.write("\u2713 TOML syntax valid\n");
      process.stdout.write(`\u2717 ${msg}\n`);
    } else {
      process.stdout.write(`\u2717 ${msg}\n`);
    }
    return 1;
  }

  process.stdout.write("\u2713 TOML syntax valid\n");
  process.stdout.write("\u2713 [agent] section valid\n");
  process.stdout.write("\u2713 [global_tags] valid\n");

  // 2. Validate each plugin instance against its Zod schema
  let hasErrors = false;

  const sections: Array<{
    label: string;
    key: keyof Pick<AgentConfig, "inputs" | "processors" | "aggregators" | "outputs">;
  }> = [
    { label: "input", key: "inputs" },
    { label: "processor", key: "processors" },
    { label: "aggregator", key: "aggregators" },
    { label: "output", key: "outputs" },
  ];

  for (const { label, key } of sections) {
    const section = config[key];
    const pluginNames = Object.keys(section);
    const totalInstances = pluginNames.reduce(
      (sum, name) => sum + section[name]!.length,
      0,
    );

    if (totalInstances === 0) continue;

    process.stdout.write(
      `\u2713 ${totalInstances} ${label}${totalInstances !== 1 ? "s" : ""} configured\n`,
    );

    for (const pluginName of pluginNames) {
      const instances = section[pluginName]!;
      const schemaKey = `${key}.${pluginName}`;
      const schema = PLUGIN_SCHEMAS[schemaKey];

      for (let i = 0; i < instances.length; i++) {
        const instance = instances[i]!;
        const aliasStr = instance.alias ? ` (alias: ${instance.alias})` : "";
        const instanceLabel = `${key}.${pluginName}[${i}]${aliasStr}`;

        if (!schema) {
          // Unknown plugin — warn but don't error (forward-compatibility)
          process.stdout.write(`  \u26A0 ${instanceLabel} \u2014 unknown plugin type (skipped validation)\n`);
          continue;
        }

        const result = schema.safeParse(instance);
        if (result.success) {
          process.stdout.write(`  - ${instanceLabel} \u2014 valid\n`);
        } else {
          hasErrors = true;
          const issues = (result.error as z.ZodError).issues
            .map((issue) => `    ${issue.path.join(".")}: ${issue.message}`)
            .join("\n");
          process.stdout.write(`  \u2717 ${instanceLabel} \u2014 invalid\n${issues}\n`);
        }
      }
    }
  }

  // 3. Report secret references as warnings
  if (config.secretRefs.length > 0) {
    process.stdout.write(
      `\u26A0 Secret references found (not resolved during validation):\n`,
    );
    for (const ref of config.secretRefs) {
      process.stdout.write(`  - ${ref}\n`);
    }
  }

  // 4. Final verdict
  if (hasErrors) {
    process.stdout.write("\u2717 Configuration has errors\n");
    return 1;
  }

  process.stdout.write("\u2713 Configuration valid\n");
  return 0;
}
