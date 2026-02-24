// CollatrEdge — config validate command
// PRD refs: §7 Configuration, §14 Error Handling

import { loadConfigFile, parseConfig } from "../../core/config";
import type { AgentConfig, ConfigWarning, PluginInstanceConfig } from "../../core/config";
import { PLUGIN_SCHEMAS } from "../../core/plugin-schemas";
import { OVERRIDE_KEYS, FILTER_KEYS } from "../../pipeline/plugin-factory";
import { parseMqttServerUrl } from "../../plugins/outputs/mqtt";
import { z } from "zod/v4";

/** Strip per-plugin override and filter fields from raw config before schema validation. */
function stripOverrideFields(instance: PluginInstanceConfig): PluginInstanceConfig {
  const stripped: Record<string, unknown> = {};
  const overrideSet = new Set<string>([...(OVERRIDE_KEYS as readonly string[]), ...(FILTER_KEYS as readonly string[])]);
  for (const [key, value] of Object.entries(instance)) {
    if (!overrideSet.has(key)) {
      stripped[key] = value;
    }
  }
  return stripped as PluginInstanceConfig;
}

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
    } else if (msg.startsWith("Invalid [network_policy]")) {
      process.stdout.write("\u2713 TOML syntax valid\n");
      process.stdout.write("\u2713 [agent] section valid\n");
      process.stdout.write(`\u2717 ${msg}\n`);
    } else {
      process.stdout.write(`\u2717 ${msg}\n`);
    }
    return 1;
  }

  process.stdout.write("\u2713 TOML syntax valid\n");
  process.stdout.write("\u2713 [agent] section valid\n");
  process.stdout.write("\u2713 [global_tags] valid\n");

  // 2. Network policy
  const np = config.networkPolicy;
  process.stdout.write(`\u2713 [network_policy] ${np.summary()}\n`);
  process.stdout.write(`  mode: ${np.mode}\n`);
  process.stdout.write(`  egress: DNS ${np.egress.allowDns ? "allowed" : "blocked"}, Hub ${np.egress.allowMqttHub ? "allowed" : "blocked"}, ${np.egress.unrestricted ? "unrestricted" : `${np.egress.allowedHosts.length} allowed hosts`}\n`);
  process.stdout.write(`  ingress: WebUI ${np.ingress.allowLocalWebui ? "allowed" : "blocked"}, API ${np.ingress.allowLocalApi ? "allowed" : "blocked"}, CIDRs ${np.ingress.allowedCidrs.join(", ") || "(none)"}\n`);

  // 3. Report config warnings (hub/policy conflicts, etc.)
  for (const warning of config.warnings) {
    process.stdout.write(`WARNING: ${warning.message}\n`);
  }

  // 3a. Detect output/policy conflicts (MQTT servers blocked by policy)
  const outputConflicts = detectOutputPolicyConflicts(config);
  for (const warning of outputConflicts) {
    process.stdout.write(`WARNING: ${warning.message}\n`);
  }

  // 4. Validate each plugin instance against its Zod schema
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

        const result = schema.safeParse(stripOverrideFields(instance));
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

  // 5. Report secret references as warnings
  if (config.secretRefs.length > 0) {
    process.stdout.write(
      `\u26A0 Secret references found (not resolved during validation):\n`,
    );
    for (const ref of config.secretRefs) {
      process.stdout.write(`  - ${ref}\n`);
    }
  }

  // 6. Final verdict
  if (hasErrors) {
    process.stdout.write("\u2717 Configuration has errors\n");
    return 1;
  }

  process.stdout.write("\u2713 Configuration valid\n");
  return 0;
}

// ---------------------------------------------------------------------------
// Output / network policy conflict detection
// ---------------------------------------------------------------------------

/**
 * Scan configured outputs against the resolved network policy.
 * Returns warning strings for any output that would be blocked at startup.
 * Does NOT instantiate plugins — only inspects raw config fields.
 */
function detectOutputPolicyConflicts(config: AgentConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  const policy = config.networkPolicy;

  // TODO: extend to HTTP and other network outputs when implemented (PRD Appendix A)
  // Check MQTT output instances for structural issues (independent of policy mode)
  const mqttInstances = config.outputs.mqtt ?? [];
  for (let i = 0; i < mqttInstances.length; i++) {
    const instance = mqttInstances[i]!;
    const isSparkplug = instance.sparkplug as boolean | undefined;

    // Sparkplug mode — check hub is actually enabled (structural, not policy-dependent)
    if (isSparkplug) {
      const hubEnabled = config.agent.hub?.enabled === true;
      if (!hubEnabled) {
        warnings.push({
          code: "sparkplug_no_hub",
          severity: "warning",
          message: `MQTT output[${i}] has sparkplug=true but [agent.hub] is not enabled. ` +
            `The pipeline will fail to start with this configuration.`,
        });
      }
      // Hub + policy conflict is already handled by config.warnings
      continue;
    }

    // Policy-based checks only apply when not unrestricted
    if (policy.egress.unrestricted) continue;

    const servers = instance.servers as string[] | undefined;
    if (!servers || servers.length === 0) continue;

    for (const server of servers) {
      const target = parseMqttServerUrl(server, `outputs.mqtt[${i}]`);
      const result = policy.checkEgress(target);
      if (!result.allowed) {
        const portStr = target.port ? `:${target.port}` : "";
        warnings.push({
          code: "mqtt_server_blocked",
          severity: "warning",
          message: `MQTT output server ${target.host}${portStr} blocked by network_policy ("${policy.mode}" mode). ` +
            `The pipeline will fail to start with this configuration.`,
        });
      }
    }
  }

  return warnings;
}
