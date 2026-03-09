// CollatrEdge — Signal value rendering fragment
// PRD refs: §17 Local Web UI
// Phase 12 Task 12.1: type-aware signal value display with Datastar bindings

import type { SignalDescriptor } from "../../signal-descriptors";
import { MACHINE_STATE_LABELS, CODER_STATE_LABELS } from "../../signal-descriptors";

// ---------------------------------------------------------------------------
// Datastar signal name helper
// Must match the sanitisation used by flattenMetrics() in stream.ts
// ---------------------------------------------------------------------------

export function toDatastarName(signalName: string): string {
  return signalName.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ---------------------------------------------------------------------------
// Signal value component
// ---------------------------------------------------------------------------

/**
 * Render a single signal value with appropriate formatting for its type.
 * Returns JSX string with Datastar data-text/data-class bindings.
 */
export function SignalValue({ descriptor }: { descriptor: SignalDescriptor }): string {
  const dsName = toDatastarName(descriptor.name);

  switch (descriptor.type) {
    case "numeric":
      return NumericValue({ descriptor, dsName });
    case "boolean":
      return BooleanIndicator({ descriptor, dsName });
    case "counter":
      return CounterValue({ descriptor, dsName });
    case "enum":
      return EnumBadge({ descriptor, dsName });
    default:
      return NumericValue({ descriptor, dsName });
  }
}

// ---------------------------------------------------------------------------
// Numeric signal: label + value + unit
// ---------------------------------------------------------------------------

function NumericValue({
  descriptor,
  dsName,
}: {
  descriptor: SignalDescriptor;
  dsName: string;
}): string {
  return (
    <div class="signal-value signal-numeric">
      <span class="signal-label">{descriptor.displayName}</span>
      <span class="signal-reading">
        <span data-text={`$${dsName}`}>&mdash;</span>
        {descriptor.unit ? (
          <span class="signal-unit">{` ${descriptor.unit}`}</span>
        ) : (
          ""
        )}
      </span>
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Boolean signal: coloured indicator dot + label
// AD-7: green for expected state, red for alarm state
// ---------------------------------------------------------------------------

/** Signals where true = alarm/bad state (red when true, green when false). */
const ALARM_WHEN_TRUE = new Set([
  "fault_active",
  "emergency_stop",
  "web_break",
  "guard_door_open",
  "gutter_fault",
]);

export function BooleanIndicator({
  descriptor,
  dsName,
}: {
  descriptor: SignalDescriptor;
  dsName: string;
}): string {
  const isAlarm = ALARM_WHEN_TRUE.has(descriptor.signal);

  // For alarm signals: true=red, false=green
  // For normal signals (running, material_present, cycle_complete): true=green, false=grey
  const onClass = isAlarm ? "bool-alarm" : "bool-on";
  const offClass = isAlarm ? "bool-ok" : "bool-off";

  return (
    <div class="signal-value signal-bool">
      <span
        class="bool-dot"
        data-class={`{'${onClass}': $${dsName} === 'true', '${offClass}': $${dsName} !== 'true'}`}
      ></span>
      <span class="bool-label">{descriptor.displayName}</span>
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Counter signal: comma-formatted value
// ---------------------------------------------------------------------------

function CounterValue({
  descriptor,
  dsName,
}: {
  descriptor: SignalDescriptor;
  dsName: string;
}): string {
  // Use data-text with Number formatting for comma separators
  return (
    <div class="signal-value signal-counter">
      <span class="signal-label">{descriptor.displayName}</span>
      <span class="signal-reading signal-reading-counter">
        <span data-text={`Number($${dsName}).toLocaleString() || $${dsName}`}>&mdash;</span>
      </span>
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Enum signal: state label + coloured badge
// ---------------------------------------------------------------------------

function EnumBadge({
  descriptor,
  dsName,
}: {
  descriptor: SignalDescriptor;
  dsName: string;
}): string {
  const labels =
    descriptor.name === "press.machine_state"
      ? MACHINE_STATE_LABELS
      : descriptor.name === "coder.state"
        ? CODER_STATE_LABELS
        : null;

  if (!labels) {
    // Unknown enum — just show the raw value
    return (
      <div class="signal-value signal-enum">
        <span class="signal-label">{descriptor.displayName}</span>
        <span class="enum-badge" data-text={`$${dsName}`}>&mdash;</span>
      </div>
    ) as string;
  }

  // Build inline label lookup expression for data-text
  const labelEntries = Object.entries(labels)
    .map(([k, v]) => `${k}:'${v.label}'`)
    .join(",");
  const labelExpr = `({${labelEntries}})[parseInt($${dsName})] ?? $${dsName}`;

  // Build data-class for colour
  const colourClasses = Object.entries(labels)
    .map(([k, v]) => `'enum-${v.colour}': parseInt($${dsName}) === ${k}`)
    .join(", ");

  return (
    <div class="signal-value signal-enum">
      <span class="signal-label">{descriptor.displayName}</span>
      <span
        class="enum-badge"
        data-text={labelExpr}
        data-class={`{${colourClasses}}`}
      >
        &mdash;
      </span>
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Dryer temp/setpoint paired value
// Shows "actual / setpoint °C" when both signals exist
// ---------------------------------------------------------------------------

export function DryerPairedValue({
  tempDescriptor,
  setpointDescriptor,
}: {
  tempDescriptor: SignalDescriptor;
  setpointDescriptor: SignalDescriptor;
}): string {
  const tempDs = toDatastarName(tempDescriptor.name);
  const setDs = toDatastarName(setpointDescriptor.name);

  return (
    <div class="signal-value signal-numeric signal-paired">
      <span class="signal-label">{tempDescriptor.displayName}</span>
      <span class="signal-reading">
        <span data-text={`$${tempDs}`}>&mdash;</span>
        {" / "}
        <span data-text={`$${setDs}`}>&mdash;</span>
        <span class="signal-unit">{` ${tempDescriptor.unit}`}</span>
      </span>
    </div>
  ) as string;
}
