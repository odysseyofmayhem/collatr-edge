// Phase 12 Task 12.0: Signal descriptor system tests

import { describe, expect, it } from "bun:test";
import {
  buildSignalDescriptors,
  MACHINE_STATE_LABELS,
  CODER_STATE_LABELS,
} from "../../../src/web/signal-descriptors";
import type { EquipmentGroup, SignalDescriptor } from "../../../src/web/signal-descriptors";

describe("buildSignalDescriptors", () => {
  it("returns empty array for empty input", () => {
    expect(buildSignalDescriptors([])).toEqual([]);
  });

  it("groups signals by equipment prefix", () => {
    const groups = buildSignalDescriptors([
      "press.line_speed",
      "press.web_tension",
      "laminator.nip_temp",
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].id).toBe("press");
    expect(groups[0].signals).toHaveLength(2);
    expect(groups[1].id).toBe("laminator");
    expect(groups[1].signals).toHaveLength(1);
  });

  it("orders known equipment groups by render priority", () => {
    const groups = buildSignalDescriptors([
      "vibration.main_drive_x",
      "press.line_speed",
      "env.ambient_temp",
      "laminator.nip_temp",
    ]);
    const ids = groups.map((g) => g.id);
    expect(ids).toEqual(["press", "laminator", "env", "vibration"]);
  });

  it("assigns correct display names to known equipment", () => {
    const groups = buildSignalDescriptors([
      "press.line_speed",
      "laminator.nip_temp",
      "slitter.speed",
      "coder.ink_level",
      "energy.line_power",
      "env.ambient_temp",
      "vibration.main_drive_x",
    ]);

    const nameMap = new Map(groups.map((g) => [g.id, g.displayName]));
    expect(nameMap.get("press")).toBe("Flexographic Press");
    expect(nameMap.get("laminator")).toBe("Laminator");
    expect(nameMap.get("slitter")).toBe("Slitter");
    expect(nameMap.get("coder")).toBe("Coder");
    expect(nameMap.get("energy")).toBe("Energy");
    expect(nameMap.get("env")).toBe("Environment");
    expect(nameMap.get("vibration")).toBe("Vibration");
  });

  it("populates known signal metadata correctly", () => {
    const groups = buildSignalDescriptors(["press.line_speed"]);
    const signal = groups[0].signals[0];
    expect(signal.name).toBe("press.line_speed");
    expect(signal.equipment).toBe("press");
    expect(signal.signal).toBe("line_speed");
    expect(signal.displayName).toBe("Line Speed");
    expect(signal.unit).toBe("m/min");
    expect(signal.type).toBe("numeric");
    expect(signal.category).toBe("process");
  });

  it("handles boolean signals with correct type and category", () => {
    const groups = buildSignalDescriptors(["press.running", "press.fault_active"]);
    for (const signal of groups[0].signals) {
      expect(signal.type).toBe("boolean");
      expect(signal.category).toBe("status");
      expect(signal.unit).toBe("");
    }
  });

  it("handles counter signals correctly", () => {
    const groups = buildSignalDescriptors(["press.impression_count"]);
    const signal = groups[0].signals[0];
    expect(signal.type).toBe("counter");
    expect(signal.category).toBe("counter");
    expect(signal.unit).toBe("count");
  });

  it("handles enum signals correctly", () => {
    const groups = buildSignalDescriptors(["press.machine_state", "coder.state"]);
    const pressSignal = groups[0].signals[0];
    expect(pressSignal.type).toBe("enum");
    expect(pressSignal.category).toBe("status");

    const coderSignal = groups[1].signals[0];
    expect(coderSignal.type).toBe("enum");
  });

  it("sorts signals within a group: numeric, boolean, counter, enum", () => {
    const groups = buildSignalDescriptors([
      "press.machine_state",    // enum
      "press.impression_count", // counter
      "press.running",          // boolean
      "press.line_speed",       // numeric
    ]);
    const types = groups[0].signals.map((s) => s.type);
    expect(types).toEqual(["numeric", "boolean", "counter", "enum"]);
  });

  describe("unknown signal handling", () => {
    it("assigns reasonable defaults to unknown signals", () => {
      const groups = buildSignalDescriptors(["custom.my_sensor_value"]);
      const group = groups[0];
      expect(group.displayName).toBe("Custom");
      expect(group.order).toBe(100); // sorts after known groups

      const signal = group.signals[0];
      expect(signal.name).toBe("custom.my_sensor_value");
      expect(signal.equipment).toBe("custom");
      expect(signal.signal).toBe("my_sensor_value");
      expect(signal.displayName).toBe("My Sensor Value");
      expect(signal.unit).toBe("");
      expect(signal.type).toBe("numeric");
      expect(signal.category).toBe("process");
    });

    it("places unknown equipment groups after known ones", () => {
      const groups = buildSignalDescriptors([
        "zzz.value",
        "press.line_speed",
        "aaa.reading",
      ]);
      const ids = groups.map((g) => g.id);
      expect(ids[0]).toBe("press");
      // Unknown groups sorted alphabetically among themselves
      expect(ids.indexOf("aaa")).toBeLessThan(ids.indexOf("zzz"));
    });

    it("skips metric names without a dot prefix", () => {
      const groups = buildSignalDescriptors(["noprefixsignal", "press.line_speed"]);
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe("press");
    });
  });

  describe("default trend signals", () => {
    it("returns curated defaults for known equipment", () => {
      const groups = buildSignalDescriptors([
        "press.line_speed",
        "press.web_tension",
        "press.dryer_temp_zone_1",
        "press.ink_viscosity",
        "press.running",
      ]);
      const press = groups[0];
      expect(press.defaultTrendSignals).toEqual([
        "press.line_speed",
        "press.web_tension",
        "press.dryer_temp_zone_1",
      ]);
    });

    it("filters curated defaults to only include existing signals", () => {
      // Only line_speed exists — web_tension and dryer_temp_zone_1 are missing
      const groups = buildSignalDescriptors(["press.line_speed", "press.running"]);
      const press = groups[0];
      expect(press.defaultTrendSignals).toEqual(["press.line_speed"]);
    });

    it("returns all numeric signals as defaults for unknown equipment", () => {
      const groups = buildSignalDescriptors([
        "custom.sensor_a",
        "custom.sensor_b",
        "custom.active", // will be "numeric" since unknown
      ]);
      const custom = groups[0];
      // All unknown signals default to numeric
      expect(custom.defaultTrendSignals).toEqual([
        "custom.sensor_a",
        "custom.sensor_b",
        "custom.active",
      ]);
    });

    it("populates curated defaults for all known equipment groups", () => {
      const groups = buildSignalDescriptors([
        "press.line_speed", "press.web_tension", "press.dryer_temp_zone_1",
        "laminator.nip_temp", "laminator.web_speed",
        "slitter.speed", "slitter.web_tension",
        "coder.ink_level", "coder.printhead_temp",
        "energy.line_power",
        "env.ambient_temp", "env.ambient_humidity",
        "vibration.main_drive_x",
      ]);

      const byId = new Map(groups.map((g) => [g.id, g]));

      expect(byId.get("press")!.defaultTrendSignals).toEqual([
        "press.line_speed", "press.web_tension", "press.dryer_temp_zone_1",
      ]);
      expect(byId.get("laminator")!.defaultTrendSignals).toEqual([
        "laminator.nip_temp", "laminator.web_speed",
      ]);
      expect(byId.get("slitter")!.defaultTrendSignals).toEqual([
        "slitter.speed", "slitter.web_tension",
      ]);
      expect(byId.get("coder")!.defaultTrendSignals).toEqual([
        "coder.ink_level", "coder.printhead_temp",
      ]);
      expect(byId.get("energy")!.defaultTrendSignals).toEqual(["energy.line_power"]);
      expect(byId.get("env")!.defaultTrendSignals).toEqual([
        "env.ambient_temp", "env.ambient_humidity",
      ]);
      expect(byId.get("vibration")!.defaultTrendSignals).toEqual(["vibration.main_drive_x"]);
    });

    it("excludes boolean and counter signals from unknown equipment defaults", () => {
      // If a known boolean signal is in an unknown equipment group...
      // Unknown signals all default to "numeric", so this tests with known signals
      // mixed into a known group
      const groups = buildSignalDescriptors([
        "press.running",          // boolean — excluded from trends
        "press.impression_count", // counter — excluded from trends
        "press.line_speed",       // numeric — included
      ]);
      const press = groups[0];
      // Curated defaults for press: line_speed (exists), web_tension (missing), dryer_temp_zone_1 (missing)
      expect(press.defaultTrendSignals).toEqual(["press.line_speed"]);
    });
  });

  describe("comprehensive signal coverage", () => {
    it("handles all laminator signals", () => {
      const groups = buildSignalDescriptors([
        "laminator.nip_temp", "laminator.nip_pressure", "laminator.tunnel_temp",
        "laminator.web_speed", "laminator.adhesive_weight",
        "laminator.nip_temp_ir", "laminator.tunnel_temp_ir",
        "laminator.running",
      ]);
      const lam = groups[0];
      expect(lam.signals).toHaveLength(8);

      const numericSignals = lam.signals.filter((s) => s.type === "numeric");
      expect(numericSignals).toHaveLength(7);

      const boolSignals = lam.signals.filter((s) => s.type === "boolean");
      expect(boolSignals).toHaveLength(1);
      expect(boolSignals[0].signal).toBe("running");
    });

    it("handles environment signals with correct units", () => {
      const groups = buildSignalDescriptors(["env.ambient_temp", "env.ambient_humidity"]);
      const env = groups[0];
      expect(env.displayName).toBe("Environment");

      const temp = env.signals.find((s) => s.signal === "ambient_temp")!;
      expect(temp.unit).toBe("°C");

      const humidity = env.signals.find((s) => s.signal === "ambient_humidity")!;
      expect(humidity.unit).toBe("%RH");
    });

    it("handles vibration signals with mm/s units", () => {
      const groups = buildSignalDescriptors([
        "vibration.main_drive_x",
        "vibration.main_drive_y",
        "vibration.main_drive_z",
      ]);
      for (const signal of groups[0].signals) {
        expect(signal.unit).toBe("mm/s");
        expect(signal.type).toBe("numeric");
      }
    });
  });
});

describe("enum state labels", () => {
  it("MACHINE_STATE_LABELS covers states 0-5", () => {
    expect(Object.keys(MACHINE_STATE_LABELS)).toHaveLength(6);
    expect(MACHINE_STATE_LABELS[0].label).toBe("Off");
    expect(MACHINE_STATE_LABELS[2].label).toBe("Running");
    expect(MACHINE_STATE_LABELS[2].colour).toBe("green");
    expect(MACHINE_STATE_LABELS[4].label).toBe("Fault");
    expect(MACHINE_STATE_LABELS[4].colour).toBe("red");
  });

  it("CODER_STATE_LABELS covers states 0-4", () => {
    expect(Object.keys(CODER_STATE_LABELS)).toHaveLength(5);
    expect(CODER_STATE_LABELS[0].label).toBe("Off");
    expect(CODER_STATE_LABELS[2].label).toBe("Printing");
    expect(CODER_STATE_LABELS[2].colour).toBe("green");
    expect(CODER_STATE_LABELS[3].label).toBe("Fault");
    expect(CODER_STATE_LABELS[3].colour).toBe("red");
  });
});
