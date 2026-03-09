// CollatrEdge — Equipment card fragment for config-driven dashboard
// PRD refs: §17 Local Web UI
// Phase 12 Task 12.1: one card per equipment group with all signals

import type { EquipmentGroup, SignalDescriptor } from "../../signal-descriptors";
import { SignalValue, BooleanIndicator, DryerPairedValue, toDatastarName } from "./signal-value";

// ---------------------------------------------------------------------------
// Equipment card component
// ---------------------------------------------------------------------------

export function EquipmentCard({ group }: { group: EquipmentGroup }): string {
  const numericSignals = group.signals.filter((s) => s.type === "numeric");
  const booleanSignals = group.signals.filter((s) => s.type === "boolean");
  const counterSignals = group.signals.filter((s) => s.type === "counter");
  const enumSignals = group.signals.filter((s) => s.type === "enum");

  // Find equipment status signal (*.running boolean or *.machine_state enum)
  const statusHtml = EquipmentStatus({ group });

  // Separate dryer paired signals from regular numerics
  const { paired, regular } = partitionDryerPairs(numericSignals);

  return (
    <div class="card card-equipment" data-equipment={group.id}>
      <div class="card-header">
        <h2>{group.displayName}</h2>
        {statusHtml as "safe"}
      </div>

      {/* Numeric signals (regular) */}
      {regular.length > 0
        ? (
            <div class="signal-grid">
              {regular.map((s) => SignalValue({ descriptor: s })).join("") as "safe"}
            </div>
          )
        : ""}

      {/* Dryer temp/setpoint pairs */}
      {paired.length > 0
        ? (
            <div class="signal-grid">
              {paired
                .map((p) =>
                  DryerPairedValue({
                    tempDescriptor: p.temp,
                    setpointDescriptor: p.setpoint,
                  }),
                )
                .join("") as "safe"}
            </div>
          )
        : ""}

      {/* Counter signals */}
      {counterSignals.length > 0
        ? (
            <div class="signal-grid">
              {counterSignals.map((s) => SignalValue({ descriptor: s })).join("") as "safe"}
            </div>
          )
        : ""}

      {/* Enum signals */}
      {enumSignals.length > 0
        ? (
            <div class="signal-grid">
              {enumSignals.map((s) => SignalValue({ descriptor: s })).join("") as "safe"}
            </div>
          )
        : ""}

      {/* Boolean indicators */}
      {booleanSignals.length > 0
        ? (
            <div class="signal-booleans">
              {booleanSignals
                .map((s) =>
                  BooleanIndicator({
                    descriptor: s,
                    dsName: toDatastarName(s.name),
                  }),
                )
                .join("") as "safe"}
            </div>
          )
        : ""}
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Equipment status indicator
// Derived from *.running boolean or *.machine_state enum
// ---------------------------------------------------------------------------

function EquipmentStatus({ group }: { group: EquipmentGroup }): string {
  const runningSignal = group.signals.find(
    (s) => s.signal === "running" && s.type === "boolean",
  );
  const stateSignal = group.signals.find(
    (s) =>
      (s.signal === "machine_state" || s.signal === "state") &&
      s.type === "enum",
  );

  if (stateSignal) {
    // Use machine state enum for richer status display
    const dsName = toDatastarName(stateSignal.name);
    return (
      <span
        class="equipment-status"
        data-class={`{'status-running': parseInt($${dsName}) === 2, 'status-fault': parseInt($${dsName}) === 4, 'status-stopped': parseInt($${dsName}) === 0}`}
      >
        <span class="status-dot-inline"></span>
      </span>
    ) as string;
  }

  if (runningSignal) {
    const dsName = toDatastarName(runningSignal.name);
    return (
      <span
        class="equipment-status"
        data-class={`{'status-running': $${dsName} === 'true', 'status-stopped': $${dsName} !== 'true'}`}
      >
        <span class="status-dot-inline"></span>
      </span>
    ) as string;
  }

  // No status signal — show neutral
  return (<span class="equipment-status"></span>) as string;
}

// ---------------------------------------------------------------------------
// Dryer temp/setpoint pairing
// When both dryer_temp_zone_N and dryer_setpoint_zone_N exist, pair them
// ---------------------------------------------------------------------------

interface DryerPair {
  temp: SignalDescriptor;
  setpoint: SignalDescriptor;
}

function partitionDryerPairs(numerics: SignalDescriptor[]): {
  paired: DryerPair[];
  regular: SignalDescriptor[];
} {
  const paired: DryerPair[] = [];
  const pairedNames = new Set<string>();

  // Find matching temp/setpoint pairs
  for (const sig of numerics) {
    if (!sig.signal.startsWith("dryer_temp_zone_")) continue;
    const zoneNum = sig.signal.replace("dryer_temp_zone_", "");
    // Skip IR variants — they don't have setpoints
    if (zoneNum.endsWith("_ir")) continue;

    const setpointName = `${sig.equipment}.dryer_setpoint_zone_${zoneNum}`;
    const setpoint = numerics.find((s) => s.name === setpointName);
    if (setpoint) {
      paired.push({ temp: sig, setpoint });
      pairedNames.add(sig.name);
      pairedNames.add(setpointName);
    }
  }

  const regular = numerics.filter((s) => !pairedNames.has(s.name));
  return { paired, regular };
}
