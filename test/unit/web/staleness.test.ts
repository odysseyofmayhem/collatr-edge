import { describe, it, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Staleness classification logic — pure function tests
// Import the actual classifyStaleness function from the browser module.
// staleness.js exports via module.exports for Node/Bun compatibility.
// ---------------------------------------------------------------------------

// Import the actual classifyStaleness from staleness.js so tests catch
// divergence if thresholds or logic change. We evaluate the source directly
// because server.ts imports staleness.js with { type: "file" } for static
// serving, which corrupts Bun's module cache and prevents normal import/require.
const stalenessSource = await Bun.file(
  new URL("../../../src/web/public/components/staleness.js", import.meta.url),
).text();

const extractExports = new Function(
  stalenessSource.replace(/^export /gm, "") +
    "\nreturn { classifyStaleness, STALE_MS, DEAD_MS };",
);
const {
  classifyStaleness,
  STALE_MS,
  DEAD_MS,
} = extractExports() as {
  classifyStaleness: (lastUpdate: number, now: number) => "fresh" | "stale" | "dead";
  STALE_MS: number;
  DEAD_MS: number;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("staleness classification", () => {
  const BASE_TIME = 1_700_000_000_000;

  it("returns 'fresh' when signal updated less than 30s ago", () => {
    expect(classifyStaleness(BASE_TIME, BASE_TIME)).toBe("fresh");
    expect(classifyStaleness(BASE_TIME, BASE_TIME + 1000)).toBe("fresh");
    expect(classifyStaleness(BASE_TIME, BASE_TIME + 15_000)).toBe("fresh");
    expect(classifyStaleness(BASE_TIME, BASE_TIME + 29_999)).toBe("fresh");
  });

  it("returns 'stale' when signal updated 30-60s ago", () => {
    expect(classifyStaleness(BASE_TIME, BASE_TIME + 30_000)).toBe("stale");
    expect(classifyStaleness(BASE_TIME, BASE_TIME + 45_000)).toBe("stale");
    expect(classifyStaleness(BASE_TIME, BASE_TIME + 59_999)).toBe("stale");
  });

  it("returns 'dead' when signal updated more than 60s ago", () => {
    expect(classifyStaleness(BASE_TIME, BASE_TIME + 60_000)).toBe("dead");
    expect(classifyStaleness(BASE_TIME, BASE_TIME + 120_000)).toBe("dead");
    expect(classifyStaleness(BASE_TIME, BASE_TIME + 3_600_000)).toBe("dead");
  });

  it("handles exact boundary at 30s (stale)", () => {
    expect(classifyStaleness(BASE_TIME, BASE_TIME + STALE_MS)).toBe("stale");
  });

  it("handles exact boundary at 60s (dead)", () => {
    expect(classifyStaleness(BASE_TIME, BASE_TIME + DEAD_MS)).toBe("dead");
  });

  it("handles zero elapsed time as fresh", () => {
    expect(classifyStaleness(BASE_TIME, BASE_TIME)).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// Signal value HTML rendering includes staleness attributes
// ---------------------------------------------------------------------------

import { SignalValue, DryerPairedValue, BooleanIndicator, toDatastarName } from "../../../src/web/views/fragments/signal-value";
import type { SignalDescriptor } from "../../../src/web/signal-descriptors";

describe("signal-value staleness attributes", () => {
  const numericDescriptor: SignalDescriptor = {
    name: "press.line_speed",
    equipment: "press",
    signal: "line_speed",
    displayName: "Line Speed",
    unit: "m/min",
    type: "numeric",
    category: "process",
  };

  const booleanDescriptor: SignalDescriptor = {
    name: "press.running",
    equipment: "press",
    signal: "running",
    displayName: "Running",
    unit: "",
    type: "boolean",
    category: "status",
  };

  const counterDescriptor: SignalDescriptor = {
    name: "press.impression_count",
    equipment: "press",
    signal: "impression_count",
    displayName: "Impression Count",
    unit: "count",
    type: "counter",
    category: "counter",
  };

  const enumDescriptor: SignalDescriptor = {
    name: "press.machine_state",
    equipment: "press",
    signal: "machine_state",
    displayName: "Machine State",
    unit: "",
    type: "enum",
    category: "status",
  };

  it("numeric signal has data-staleness-signal attribute", () => {
    const html = SignalValue({ descriptor: numericDescriptor });
    expect(html).toContain('data-staleness-signal="press_line_speed"');
  });

  it("boolean signal has data-staleness-signal attribute", () => {
    const dsName = toDatastarName(booleanDescriptor.name);
    const html = BooleanIndicator({ descriptor: booleanDescriptor, dsName });
    expect(html).toContain('data-staleness-signal="press_running"');
  });

  it("counter signal has data-staleness-signal attribute", () => {
    const html = SignalValue({ descriptor: counterDescriptor });
    expect(html).toContain('data-staleness-signal="press_impression_count"');
  });

  it("enum signal has data-staleness-signal attribute", () => {
    const html = SignalValue({ descriptor: enumDescriptor });
    expect(html).toContain('data-staleness-signal="press_machine_state"');
  });

  it("dryer paired value has data-staleness-signal attribute", () => {
    const tempDesc: SignalDescriptor = {
      name: "press.dryer_temp_zone_1",
      equipment: "press",
      signal: "dryer_temp_zone_1",
      displayName: "Dryer Temp Zone 1",
      unit: "°C",
      type: "numeric",
      category: "process",
    };
    const setpointDesc: SignalDescriptor = {
      name: "press.dryer_setpoint_zone_1",
      equipment: "press",
      signal: "dryer_setpoint_zone_1",
      displayName: "Dryer Setpoint Zone 1",
      unit: "°C",
      type: "numeric",
      category: "process",
    };
    const html = DryerPairedValue({
      tempDescriptor: tempDesc,
      setpointDescriptor: setpointDesc,
    });
    expect(html).toContain('data-staleness-signal="press_dryer_temp_zone_1"');
  });
});

// ---------------------------------------------------------------------------
// CSS classes exist in the layout
// ---------------------------------------------------------------------------

import { Layout } from "../../../src/web/views/layout";

describe("staleness CSS in layout", () => {
  it("contains staleness CSS classes", () => {
    const html = Layout({ title: "Test", children: "<p>hello</p>" });
    expect(html).toContain(".signal-fresh");
    expect(html).toContain(".signal-stale");
    expect(html).toContain(".signal-dead");
  });

  it("includes staleness.js script tag", () => {
    const html = Layout({ title: "Test", children: "<p>hello</p>" });
    expect(html).toContain('src="/static/components/staleness.js"');
  });
});
