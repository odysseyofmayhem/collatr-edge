import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  expandEnvVars,
  parseDuration,
  parseConfig,
  loadConfigFile,
  findSecretRefs,
} from "@core/config";

// Helper to set/unset env vars safely during tests
const envBackup = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  envBackup.set(key, process.env[key]);
  process.env[key] = value;
}

function unsetEnv(key: string): void {
  envBackup.set(key, process.env[key]);
  delete process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of envBackup) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  envBackup.clear();
}

// Minimal valid TOML for agent config
const MINIMAL_TOML = `
[agent]
  interval = "10s"
  flush_interval = "10s"
`;

// Full example config
const FULL_TOML = `
[agent]
  hostname = "test-host"
  interval = "5s"
  round_interval = true
  collection_jitter = "1s"
  collection_offset = "0s"
  flush_interval = "10s"
  flush_jitter = "2s"
  precision = "1ms"
  log_level = "info"

[global_tags]
  site = "factory_a"
  area = "production"

[[inputs.modbus]]
  alias = "plc_01"
  controller = "tcp://192.168.1.100:502"
  slave_id = 1

[[inputs.modbus]]
  alias = "plc_02"
  controller = "tcp://192.168.1.101:502"
  slave_id = 2

[[processors.rename]]
  order = 1

[[aggregators.basicstats]]
  period = "30s"
  drop_original = false

[[outputs.http]]
  alias = "influx"
  url = "http://influxdb.local:8086/write"
  metric_batch_size = 500
`;

describe("Config parser", () => {
  afterEach(() => {
    restoreEnv();
  });

  describe("parseConfig — valid TOML", () => {
    it("parse valid TOML config → correct structure", () => {
      const config = parseConfig(FULL_TOML);

      expect(config.agent.hostname).toBe("test-host");
      expect(config.agent.interval).toBe("5s");
      expect(config.agent.round_interval).toBe(true);
      expect(config.agent.log_level).toBe("info");

      expect(config.global_tags.site).toBe("factory_a");
      expect(config.global_tags.area).toBe("production");

      expect(Object.keys(config.inputs)).toEqual(["modbus"]);
      expect(config.inputs.modbus!.length).toBe(2);
      expect(config.inputs.modbus![0]!.alias).toBe("plc_01");
      expect(config.inputs.modbus![1]!.controller).toBe("tcp://192.168.1.101:502");

      expect(Object.keys(config.processors)).toEqual(["rename"]);
      expect(Object.keys(config.aggregators)).toEqual(["basicstats"]);
      expect(Object.keys(config.outputs)).toEqual(["http"]);
    });
  });

  describe("expandEnvVars", () => {
    it("${HOME} resolves to actual env var value", () => {
      setEnv("TEST_CONFIG_VAR", "hello-world");
      const result = expandEnvVars('value = "${TEST_CONFIG_VAR}"');
      expect(result).toBe('value = "hello-world"');
    });

    it("${MISSING:-fallback} resolves to 'fallback'", () => {
      unsetEnv("DEFINITELY_MISSING_VAR");
      const result = expandEnvVars('value = "${DEFINITELY_MISSING_VAR:-fallback}"');
      expect(result).toBe('value = "fallback"');
    });

    it("${MISSING:?must set this} throws with 'must set this' in message", () => {
      unsetEnv("DEFINITELY_MISSING_VAR");
      expect(() =>
        expandEnvVars('value = "${DEFINITELY_MISSING_VAR:?must set this}"'),
      ).toThrow("must set this");
    });

    it("${MISSING} throws with variable name in message", () => {
      unsetEnv("DEFINITELY_MISSING_VAR");
      expect(() =>
        expandEnvVars('value = "${DEFINITELY_MISSING_VAR}"'),
      ).toThrow("DEFINITELY_MISSING_VAR");
    });

    it("${SET:-default} uses actual value, not default", () => {
      setEnv("TEST_SET_VAR", "real-value");
      const result = expandEnvVars('value = "${TEST_SET_VAR:-fallback}"');
      expect(result).toBe('value = "real-value"');
    });
  });

  describe("parseDuration", () => {
    it("Duration: '10s'→10000, '5m'→300000, '100ms'→100, '1h'→3600000", () => {
      expect(parseDuration("10s")).toBe(10_000);
      expect(parseDuration("5m")).toBe(300_000);
      expect(parseDuration("100ms")).toBe(100);
      expect(parseDuration("1h")).toBe(3_600_000);
    });

    it("invalid duration string → clear error", () => {
      expect(() => parseDuration("abc")).toThrow("Invalid duration");
      expect(() => parseDuration("10")).toThrow("Invalid duration");
      expect(() => parseDuration("10x")).toThrow("Invalid duration");
      expect(() => parseDuration("")).toThrow("Invalid duration");
      expect(() => parseDuration("s")).toThrow("Invalid duration");
    });
  });

  describe("TOML errors", () => {
    it("invalid TOML → error with line info", () => {
      const badToml = `
[agent]
  interval = "10s"
  bad_line ===
`;
      expect(() => parseConfig(badToml)).toThrow(/Invalid TOML/);
    });
  });

  describe("agent schema validation", () => {
    it("invalid agent log_level → clear validation error", () => {
      const toml = `
[agent]
  log_level = "verbose"
`;
      expect(() => parseConfig(toml)).toThrow(/Invalid \[agent\] config/);
    });

    it("missing [agent] section uses defaults", () => {
      const config = parseConfig("");
      expect(config.agent.interval).toBe("10s");
      expect(config.agent.flush_interval).toBe("10s");
      expect(config.agent.round_interval).toBe(true);
      expect(config.agent.log_level).toBe("info");
      expect(config.agent.precision).toBe("1ms");
    });
  });

  describe("alias uniqueness", () => {
    it("duplicate plugin aliases → error naming both aliases", () => {
      const toml = `
[agent]
  interval = "10s"

[[inputs.modbus]]
  alias = "duplicate_name"
  controller = "tcp://192.168.1.100:502"

[[inputs.modbus]]
  alias = "duplicate_name"
  controller = "tcp://192.168.1.101:502"
`;
      expect(() => parseConfig(toml)).toThrow(/Duplicate plugin alias "duplicate_name"/);
      expect(() => parseConfig(toml)).toThrow(/modbus\[0\]/);
      expect(() => parseConfig(toml)).toThrow(/modbus\[1\]/);
    });
  });

  describe("secret references", () => {
    it("@{secrets:key} detected and preserved (not resolved)", () => {
      const toml = `
[agent]
  interval = "10s"

[agent.hub]
  group_id = "plant"
  edge_node_id = "node1"
  broker = "mqtts://hub.collatr.com:8883"
  tls_cert = "@{secrets:hub_cert}"
  tls_key = "@{secrets:hub_key}"
`;
      const config = parseConfig(toml);

      // Secret refs detected
      expect(config.secretRefs.length).toBe(2);
      expect(config.secretRefs.some((r) => r.includes("@{secrets:hub_cert}"))).toBe(true);
      expect(config.secretRefs.some((r) => r.includes("@{secrets:hub_key}"))).toBe(true);

      // Secret refs preserved as-is in config (not resolved)
      expect(config.agent.hub!.tls_cert).toBe("@{secrets:hub_cert}");
      expect(config.agent.hub!.tls_key).toBe("@{secrets:hub_key}");
    });
  });

  describe("loadConfigFile", () => {
    it("missing config file → helpful error message", async () => {
      try {
        await loadConfigFile("/nonexistent/path/collatr-edge.toml");
        expect(true).toBe(false); // should not reach here
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("Config file not found");
        expect((err as Error).message).toContain("/nonexistent/path/collatr-edge.toml");
      }
    });
  });

  describe("plugin section extraction", () => {
    it("plugin sections extracted correctly (inputs.modbus, processors.rename, etc.)", () => {
      const config = parseConfig(FULL_TOML);

      // inputs.modbus — 2 instances
      expect(config.inputs.modbus).toBeDefined();
      expect(config.inputs.modbus!.length).toBe(2);
      expect(config.inputs.modbus![0]!.controller).toBe("tcp://192.168.1.100:502");
      expect(config.inputs.modbus![1]!.slave_id).toBe(2);

      // processors.rename — 1 instance
      expect(config.processors.rename).toBeDefined();
      expect(config.processors.rename!.length).toBe(1);
      expect(config.processors.rename![0]!.order).toBe(1);

      // aggregators.basicstats — 1 instance
      expect(config.aggregators.basicstats).toBeDefined();
      expect(config.aggregators.basicstats!.length).toBe(1);
      expect(config.aggregators.basicstats![0]!.period).toBe("30s");

      // outputs.http — 1 instance
      expect(config.outputs.http).toBeDefined();
      expect(config.outputs.http!.length).toBe(1);
      expect(config.outputs.http![0]!.url).toBe("http://influxdb.local:8086/write");

      // Empty sections return empty objects
      expect(Object.keys(config.inputs).length).toBe(1);
    });
  });

  describe("duration — fractional values", () => {
    it("fractional duration strings: '2.5s' → 2500, '0.5h' → 1800000", () => {
      expect(parseDuration("2.5s")).toBe(2_500);
      expect(parseDuration("0.5h")).toBe(1_800_000);
      expect(parseDuration("1.5m")).toBe(90_000);
      expect(parseDuration("0.1ms")).toBe(0.1);
    });
  });

  describe("duration validation in agent schema", () => {
    it("invalid duration in agent interval → clear validation error", () => {
      const toml = `
[agent]
  interval = "banana"
`;
      expect(() => parseConfig(toml)).toThrow(/Invalid \[agent\] config/);
    });

    it("invalid duration in flush_interval → clear validation error", () => {
      const toml = `
[agent]
  flush_interval = "10x"
`;
      expect(() => parseConfig(toml)).toThrow(/Invalid \[agent\] config/);
    });
  });

  describe("alias uniqueness — cross-type", () => {
    it("same alias across input and output → error", () => {
      const toml = `
[agent]
  interval = "10s"

[[inputs.modbus]]
  alias = "shared_name"
  controller = "tcp://192.168.1.100:502"

[[outputs.http]]
  alias = "shared_name"
  url = "http://localhost:8086"
`;
      expect(() => parseConfig(toml)).toThrow(/Duplicate plugin alias "shared_name"/);
    });
  });
});
