// CollatrEdge — Signal Descriptor System
// PRD refs: §17 Local Web UI
// Phase 12 Task 12.0: Config-driven signal metadata for dashboard and trends pages

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalDescriptor {
  name: string;          // Full signal name, e.g. "press.line_speed"
  equipment: string;     // Equipment prefix, e.g. "press"
  signal: string;        // Signal portion, e.g. "line_speed"
  displayName: string;   // Human-readable, e.g. "Line Speed"
  unit: string;          // e.g. "m/min", "°C", "" for unitless
  type: "numeric" | "boolean" | "counter" | "enum";
  category: "process" | "status" | "counter" | "environmental";
}

export interface EquipmentGroup {
  id: string;            // Equipment prefix
  displayName: string;   // Human-readable name
  order: number;         // Render priority
  signals: SignalDescriptor[];
  defaultTrendSignals: string[]; // Full signal names for default trend charts
}

// ---------------------------------------------------------------------------
// Known equipment display names and render order
// ---------------------------------------------------------------------------

const EQUIPMENT_DISPLAY: Record<string, { displayName: string; order: number }> = {
  press: { displayName: "Flexographic Press", order: 1 },
  laminator: { displayName: "Laminator", order: 2 },
  slitter: { displayName: "Slitter", order: 3 },
  coder: { displayName: "Coder", order: 4 },
  energy: { displayName: "Energy", order: 5 },
  env: { displayName: "Environment", order: 6 },
  vibration: { displayName: "Vibration", order: 7 },
};

// ---------------------------------------------------------------------------
// Curated default trend signals per equipment group
// ---------------------------------------------------------------------------

const DEFAULT_TREND_SIGNALS: Map<string, string[]> = new Map([
  ["press", ["line_speed", "web_tension", "dryer_temp_zone_1"]],
  ["laminator", ["nip_temp", "web_speed"]],
  ["slitter", ["speed", "web_tension"]],
  ["coder", ["ink_level", "printhead_temp"]],
  ["energy", ["line_power"]],
  ["env", ["ambient_temp", "ambient_humidity"]],
  ["vibration", ["main_drive_x"]],
]);

// ---------------------------------------------------------------------------
// Static signal metadata lookup table
// From factory simulator PRD §2.2-2.9 signal tables
// ---------------------------------------------------------------------------

interface SignalMeta {
  unit: string;
  type: "numeric" | "boolean" | "counter" | "enum";
  category: "process" | "status" | "counter" | "environmental";
}

const SIGNAL_LOOKUP: Record<string, SignalMeta> = {
  // Press — numeric process signals
  "press.line_speed": { unit: "m/min", type: "numeric", category: "process" },
  "press.web_tension": { unit: "N", type: "numeric", category: "process" },
  "press.registration_error_x": { unit: "mm", type: "numeric", category: "process" },
  "press.registration_error_y": { unit: "mm", type: "numeric", category: "process" },
  "press.ink_viscosity": { unit: "s", type: "numeric", category: "process" },
  "press.ink_temperature": { unit: "°C", type: "numeric", category: "process" },
  "press.dryer_temp_zone_1": { unit: "°C", type: "numeric", category: "process" },
  "press.dryer_temp_zone_2": { unit: "°C", type: "numeric", category: "process" },
  "press.dryer_temp_zone_3": { unit: "°C", type: "numeric", category: "process" },
  "press.dryer_setpoint_zone_1": { unit: "°C", type: "numeric", category: "process" },
  "press.dryer_setpoint_zone_2": { unit: "°C", type: "numeric", category: "process" },
  "press.dryer_setpoint_zone_3": { unit: "°C", type: "numeric", category: "process" },
  "press.main_drive_current": { unit: "A", type: "numeric", category: "process" },
  "press.main_drive_speed": { unit: "RPM", type: "numeric", category: "process" },
  "press.nip_pressure": { unit: "bar", type: "numeric", category: "process" },
  "press.unwind_diameter": { unit: "mm", type: "numeric", category: "process" },
  "press.rewind_diameter": { unit: "mm", type: "numeric", category: "process" },
  "press.dryer_temp_zone_1_ir": { unit: "°C", type: "numeric", category: "process" },
  "press.dryer_temp_zone_2_ir": { unit: "°C", type: "numeric", category: "process" },
  "press.dryer_temp_zone_3_ir": { unit: "°C", type: "numeric", category: "process" },
  "press.ink_temperature_ir": { unit: "°C", type: "numeric", category: "process" },

  // Press — counters
  "press.impression_count": { unit: "count", type: "counter", category: "counter" },
  "press.good_count": { unit: "count", type: "counter", category: "counter" },
  "press.waste_count": { unit: "count", type: "counter", category: "counter" },

  // Press — enums
  "press.machine_state": { unit: "", type: "enum", category: "status" },
  "press.fault_code": { unit: "", type: "enum", category: "status" },

  // Press — booleans
  "press.running": { unit: "", type: "boolean", category: "status" },
  "press.fault_active": { unit: "", type: "boolean", category: "status" },
  "press.emergency_stop": { unit: "", type: "boolean", category: "status" },
  "press.web_break": { unit: "", type: "boolean", category: "status" },
  "press.guard_door_open": { unit: "", type: "boolean", category: "status" },
  "press.material_present": { unit: "", type: "boolean", category: "status" },
  "press.cycle_complete": { unit: "", type: "boolean", category: "status" },

  // Laminator — numeric
  "laminator.nip_temp": { unit: "°C", type: "numeric", category: "process" },
  "laminator.nip_pressure": { unit: "bar", type: "numeric", category: "process" },
  "laminator.tunnel_temp": { unit: "°C", type: "numeric", category: "process" },
  "laminator.web_speed": { unit: "m/min", type: "numeric", category: "process" },
  "laminator.adhesive_weight": { unit: "g/m²", type: "numeric", category: "process" },
  "laminator.nip_temp_ir": { unit: "°C", type: "numeric", category: "process" },
  "laminator.tunnel_temp_ir": { unit: "°C", type: "numeric", category: "process" },

  // Laminator — boolean
  "laminator.running": { unit: "", type: "boolean", category: "status" },

  // Slitter — numeric
  "slitter.speed": { unit: "m/min", type: "numeric", category: "process" },
  "slitter.web_tension": { unit: "N", type: "numeric", category: "process" },

  // Slitter — counter
  "slitter.reel_count": { unit: "count", type: "counter", category: "counter" },

  // Slitter — boolean
  "slitter.running": { unit: "", type: "boolean", category: "status" },

  // Coder — numeric
  "coder.ink_level": { unit: "%", type: "numeric", category: "process" },
  "coder.printhead_temp": { unit: "°C", type: "numeric", category: "process" },
  "coder.ink_pump_speed": { unit: "RPM", type: "numeric", category: "process" },
  "coder.ink_pressure": { unit: "mbar", type: "numeric", category: "process" },
  "coder.ink_viscosity_actual": { unit: "cP", type: "numeric", category: "process" },
  "coder.supply_voltage": { unit: "V", type: "numeric", category: "process" },
  "coder.nozzle_health": { unit: "%", type: "numeric", category: "process" },

  // Coder — counters
  "coder.prints_total": { unit: "count", type: "counter", category: "counter" },
  "coder.ink_consumption_ml": { unit: "ml", type: "counter", category: "counter" },

  // Coder — enum
  "coder.state": { unit: "", type: "enum", category: "status" },

  // Coder — boolean
  "coder.gutter_fault": { unit: "", type: "boolean", category: "status" },

  // Environment — numeric
  "env.ambient_temp": { unit: "°C", type: "numeric", category: "environmental" },
  "env.ambient_humidity": { unit: "%RH", type: "numeric", category: "environmental" },

  // Energy — numeric
  "energy.line_power": { unit: "kW", type: "numeric", category: "process" },

  // Energy — counter
  "energy.cumulative_kwh": { unit: "kWh", type: "counter", category: "counter" },

  // Vibration — numeric
  "vibration.main_drive_x": { unit: "mm/s", type: "numeric", category: "process" },
  "vibration.main_drive_y": { unit: "mm/s", type: "numeric", category: "process" },
  "vibration.main_drive_z": { unit: "mm/s", type: "numeric", category: "process" },
};

// ---------------------------------------------------------------------------
// Machine state enum labels
// ---------------------------------------------------------------------------

export const MACHINE_STATE_LABELS: Record<number, { label: string; colour: string }> = {
  0: { label: "Off", colour: "grey" },
  1: { label: "Setup", colour: "amber" },
  2: { label: "Running", colour: "green" },
  3: { label: "Idle", colour: "blue" },
  4: { label: "Fault", colour: "red" },
  5: { label: "Maintenance", colour: "amber" },
};

export const CODER_STATE_LABELS: Record<number, { label: string; colour: string }> = {
  0: { label: "Off", colour: "grey" },
  1: { label: "Ready", colour: "blue" },
  2: { label: "Printing", colour: "green" },
  3: { label: "Fault", colour: "red" },
  4: { label: "Standby", colour: "amber" },
};

// ---------------------------------------------------------------------------
// Helper: convert signal name portion to human-readable display name
// ---------------------------------------------------------------------------

function toDisplayName(signal: string): string {
  return signal
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Build signal descriptors from a list of metric names
// ---------------------------------------------------------------------------

export function buildSignalDescriptors(metricNames: string[]): EquipmentGroup[] {
  if (metricNames.length === 0) return [];

  // Group metrics by equipment prefix
  const grouped = new Map<string, string[]>();
  for (const name of metricNames) {
    const dotIndex = name.indexOf(".");
    if (dotIndex === -1) continue; // Skip unprefixed metric names
    const equipment = name.substring(0, dotIndex);
    const existing = grouped.get(equipment);
    if (existing) {
      existing.push(name);
    } else {
      grouped.set(equipment, [name]);
    }
  }

  const groups: EquipmentGroup[] = [];

  for (const [equipmentId, names] of grouped) {
    const known = EQUIPMENT_DISPLAY[equipmentId];
    const displayName = known?.displayName ?? capitalise(equipmentId);
    const order = known?.order ?? 100; // Unknown equipment sorts after known

    const signals: SignalDescriptor[] = [];
    for (const name of names) {
      const signalPart = name.substring(equipmentId.length + 1);
      const meta = SIGNAL_LOOKUP[name];

      signals.push({
        name,
        equipment: equipmentId,
        signal: signalPart,
        displayName: toDisplayName(signalPart),
        unit: meta?.unit ?? "",
        type: meta?.type ?? "numeric",
        category: meta?.category ?? "process",
      });
    }

    // Sort signals: numeric first, then boolean, counter, enum
    const typeOrder: Record<string, number> = { numeric: 0, boolean: 1, counter: 2, enum: 3 };
    signals.sort((a, b) => (typeOrder[a.type] ?? 0) - (typeOrder[b.type] ?? 0));

    // Build default trend signals
    const curatedDefaults = DEFAULT_TREND_SIGNALS.get(equipmentId);
    let defaultTrendSignals: string[];

    if (curatedDefaults) {
      // Use curated defaults, filtering to signals that actually exist
      defaultTrendSignals = curatedDefaults
        .map((s) => `${equipmentId}.${s}`)
        .filter((fullName) => names.includes(fullName));
    } else {
      // Unknown equipment: all numeric signals as defaults
      defaultTrendSignals = signals
        .filter((s) => s.type === "numeric")
        .map((s) => s.name);
    }

    groups.push({
      id: equipmentId,
      displayName,
      order,
      signals,
      defaultTrendSignals,
    });
  }

  // Sort groups by order, then alphabetically for same order
  groups.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  return groups;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalise(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
