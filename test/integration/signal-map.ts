/**
 * Signal name mapping for integration test verification.
 *
 * Maps between:
 * - Batch CSV signal_id (simulator output)
 * - Edge metric name (from TOML config alias + register/node name)
 * - Edge _device_id tag (TOML input alias)
 * - MQTT full topic path
 *
 * Source: Simulator PRD Appendices A, B, C + factory.yaml + collatr-edge-packaging.toml
 */

// ---------------------------------------------------------------------------
// Device IDs (from TOML input aliases)
// ---------------------------------------------------------------------------

export const DEVICE_ID = {
  MODBUS: "packaging_press",
  OPCUA: "packaging_opcua",
  MQTT: "packaging_mqtt",
  INTERNAL: "internal",
} as const;

// ---------------------------------------------------------------------------
// MQTT topic prefix
// ---------------------------------------------------------------------------

/** Full MQTT topic prefix: {topic_prefix}/{site_id}/{line_id} */
export const MQTT_TOPIC_PREFIX = "collatr/factory/demo/packaging1";

// ---------------------------------------------------------------------------
// Signal definitions
// ---------------------------------------------------------------------------

export interface SignalDef {
  /** Signal ID in batch CSV (e.g. "press.line_speed") */
  csvId: string;
  /** Edge metric name for Modbus (null if not on Modbus) */
  modbusName: string | null;
  /** Edge metric name for OPC-UA (null if not on OPC-UA) */
  opcuaName: string | null;
  /** Full MQTT topic (null if not on MQTT) */
  mqttTopic: string | null;
  /** Expected data type */
  dataType: "float" | "uint16" | "uint32" | "int16" | "bool" | "enum";
  /** Whether this is a counter (monotonically non-decreasing) */
  isCounter: boolean;
  /** Expected MQTT publish interval in ms (null if not on MQTT or event-driven) */
  mqttIntervalMs: number | null;
  /** Whether MQTT publish is event-driven (not timed) */
  mqttEventDriven: boolean;
}

// Helper to build a full MQTT topic
const mqtt = (suffix: string) => `${MQTT_TOPIC_PREFIX}/${suffix}`;

/**
 * Complete signal map for the packaging profile.
 *
 * Key = batch CSV signal_id (canonical identifier).
 */
export const SIGNALS: Record<string, SignalDef> = {
  // ---- Press process values (HR) + OPC-UA ----
  "press.line_speed": {
    csvId: "press.line_speed",
    modbusName: "press.line_speed",
    opcuaName: "press.line_speed",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.web_tension": {
    csvId: "press.web_tension",
    modbusName: "press.web_tension",
    opcuaName: "press.web_tension",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.ink_viscosity": {
    csvId: "press.ink_viscosity",
    modbusName: "press.ink_viscosity",
    opcuaName: "press.ink_viscosity",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.ink_temperature": {
    csvId: "press.ink_temperature",
    modbusName: "press.ink_temperature",
    opcuaName: "press.ink_temperature",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.dryer_temp_zone_1": {
    csvId: "press.dryer_temp_zone_1",
    modbusName: "press.dryer_temp_zone_1",
    opcuaName: "press.dryer_temp_zone_1",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.dryer_temp_zone_2": {
    csvId: "press.dryer_temp_zone_2",
    modbusName: "press.dryer_temp_zone_2",
    opcuaName: "press.dryer_temp_zone_2",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.dryer_temp_zone_3": {
    csvId: "press.dryer_temp_zone_3",
    modbusName: "press.dryer_temp_zone_3",
    opcuaName: "press.dryer_temp_zone_3",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Press setpoints (HR) + OPC-UA ----
  "press.dryer_setpoint_zone_1": {
    csvId: "press.dryer_setpoint_zone_1",
    modbusName: "press.dryer_setpoint_zone_1",
    opcuaName: "press.dryer_setpoint_zone_1",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.dryer_setpoint_zone_2": {
    csvId: "press.dryer_setpoint_zone_2",
    modbusName: "press.dryer_setpoint_zone_2",
    opcuaName: "press.dryer_setpoint_zone_2",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.dryer_setpoint_zone_3": {
    csvId: "press.dryer_setpoint_zone_3",
    modbusName: "press.dryer_setpoint_zone_3",
    opcuaName: "press.dryer_setpoint_zone_3",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Press counters (HR) + OPC-UA ----
  "press.impression_count": {
    csvId: "press.impression_count",
    modbusName: "press.impression_count",
    opcuaName: "press.impression_count",
    mqttTopic: null,
    dataType: "uint32",
    isCounter: true,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.good_count": {
    csvId: "press.good_count",
    modbusName: "press.good_count",
    opcuaName: "press.good_count",
    mqttTopic: null,
    dataType: "uint32",
    isCounter: true,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.waste_count": {
    csvId: "press.waste_count",
    modbusName: "press.waste_count",
    opcuaName: "press.waste_count",
    mqttTopic: null,
    dataType: "uint32",
    isCounter: true,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Press state (HR) + OPC-UA ----
  "press.machine_state": {
    csvId: "press.machine_state",
    modbusName: "press.machine_state",
    opcuaName: "press.machine_state",
    mqttTopic: null,
    dataType: "uint16",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.fault_code": {
    csvId: "press.fault_code",
    modbusName: "press.fault_code",
    opcuaName: "press.fault_code",
    mqttTopic: null,
    dataType: "uint16",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Press drive/mechanical (HR) + OPC-UA ----
  "press.main_drive_current": {
    csvId: "press.main_drive_current",
    modbusName: "press.main_drive_current",
    opcuaName: "press.main_drive_current",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.main_drive_speed": {
    csvId: "press.main_drive_speed",
    modbusName: "press.main_drive_speed",
    opcuaName: "press.main_drive_speed",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.nip_pressure": {
    csvId: "press.nip_pressure",
    modbusName: "press.nip_pressure",
    opcuaName: "press.nip_pressure",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.unwind_diameter": {
    csvId: "press.unwind_diameter",
    modbusName: "press.unwind_diameter",
    opcuaName: "press.unwind_diameter",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.rewind_diameter": {
    csvId: "press.rewind_diameter",
    modbusName: "press.rewind_diameter",
    opcuaName: "press.rewind_diameter",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Press OPC-UA only (registration errors) ----
  "press.registration_error_x": {
    csvId: "press.registration_error_x",
    modbusName: null,
    opcuaName: "press.registration_error_x",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.registration_error_y": {
    csvId: "press.registration_error_y",
    modbusName: null,
    opcuaName: "press.registration_error_y",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Laminator (HR) + OPC-UA ----
  "laminator.nip_temp": {
    csvId: "laminator.nip_temp",
    modbusName: "laminator.nip_temp",
    opcuaName: "laminator.nip_temp",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "laminator.nip_pressure": {
    csvId: "laminator.nip_pressure",
    modbusName: "laminator.nip_pressure",
    opcuaName: "laminator.nip_pressure",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "laminator.tunnel_temp": {
    csvId: "laminator.tunnel_temp",
    modbusName: "laminator.tunnel_temp",
    opcuaName: "laminator.tunnel_temp",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "laminator.web_speed": {
    csvId: "laminator.web_speed",
    modbusName: "laminator.web_speed",
    opcuaName: "laminator.web_speed",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "laminator.adhesive_weight": {
    csvId: "laminator.adhesive_weight",
    modbusName: "laminator.adhesive_weight",
    opcuaName: "laminator.adhesive_weight",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Slitter (HR) + OPC-UA ----
  "slitter.speed": {
    csvId: "slitter.speed",
    modbusName: "slitter.speed",
    opcuaName: "slitter.speed",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "slitter.web_tension": {
    csvId: "slitter.web_tension",
    modbusName: "slitter.web_tension",
    opcuaName: "slitter.web_tension",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "slitter.reel_count": {
    csvId: "slitter.reel_count",
    modbusName: "slitter.reel_count",
    opcuaName: "slitter.reel_count",
    mqttTopic: null,
    dataType: "uint32",
    isCounter: true,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Energy (HR) + OPC-UA ----
  "energy.line_power": {
    csvId: "energy.line_power",
    modbusName: "energy.line_power",
    opcuaName: "energy.line_power",
    mqttTopic: null,
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "energy.cumulative_kwh": {
    csvId: "energy.cumulative_kwh",
    modbusName: "energy.cumulative_kwh",
    opcuaName: "energy.cumulative_kwh",
    mqttTopic: null,
    dataType: "float",
    isCounter: true,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Modbus Input Registers (int16 x10, Modbus only) ----
  "press.dryer_temp_zone_1_ir": {
    csvId: "press.dryer_temp_zone_1",  // Same underlying signal as HR, different encoding
    modbusName: "press.dryer_temp_zone_1_ir",
    opcuaName: null,
    mqttTopic: null,
    dataType: "int16",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.dryer_temp_zone_2_ir": {
    csvId: "press.dryer_temp_zone_2",
    modbusName: "press.dryer_temp_zone_2_ir",
    opcuaName: null,
    mqttTopic: null,
    dataType: "int16",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.dryer_temp_zone_3_ir": {
    csvId: "press.dryer_temp_zone_3",
    modbusName: "press.dryer_temp_zone_3_ir",
    opcuaName: null,
    mqttTopic: null,
    dataType: "int16",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.ink_temperature_ir": {
    csvId: "press.ink_temperature",
    modbusName: "press.ink_temperature_ir",
    opcuaName: null,
    mqttTopic: null,
    dataType: "int16",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "laminator.nip_temp_ir": {
    csvId: "laminator.nip_temp",
    modbusName: "laminator.nip_temp_ir",
    opcuaName: null,
    mqttTopic: null,
    dataType: "int16",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "laminator.tunnel_temp_ir": {
    csvId: "laminator.tunnel_temp",
    modbusName: "laminator.tunnel_temp_ir",
    opcuaName: null,
    mqttTopic: null,
    dataType: "int16",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Modbus Coils (Modbus only) ----
  "press.running": {
    csvId: "press.running",
    modbusName: "press.running",
    opcuaName: null,
    mqttTopic: null,
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.fault_active": {
    csvId: "press.fault_active",
    modbusName: "press.fault_active",
    opcuaName: null,
    mqttTopic: null,
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.emergency_stop": {
    csvId: "press.emergency_stop",
    modbusName: "press.emergency_stop",
    opcuaName: null,
    mqttTopic: null,
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.web_break": {
    csvId: "press.web_break",
    modbusName: "press.web_break",
    opcuaName: null,
    mqttTopic: null,
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "laminator.running": {
    csvId: "laminator.running",
    modbusName: "laminator.running",
    opcuaName: null,
    mqttTopic: null,
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "slitter.running": {
    csvId: "slitter.running",
    modbusName: "slitter.running",
    opcuaName: null,
    mqttTopic: null,
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- Modbus Discrete Inputs (Modbus only) ----
  "press.guard_door_open": {
    csvId: "press.guard_door_open",
    modbusName: "press.guard_door_open",
    opcuaName: null,
    mqttTopic: null,
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.material_present": {
    csvId: "press.material_present",
    modbusName: "press.material_present",
    opcuaName: null,
    mqttTopic: null,
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },
  "press.cycle_complete": {
    csvId: "press.cycle_complete",
    modbusName: "press.cycle_complete",
    opcuaName: null,
    mqttTopic: null,
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: false,
  },

  // ---- MQTT: Coder signals ----
  "coder.state": {
    csvId: "coder.state",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/state"),
    dataType: "enum",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: true,
  },
  "coder.prints_total": {
    csvId: "coder.prints_total",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/prints_total"),
    dataType: "uint32",
    isCounter: true,
    mqttIntervalMs: null,
    mqttEventDriven: true,
  },
  "coder.ink_level": {
    csvId: "coder.ink_level",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/ink_level"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 60000,
    mqttEventDriven: false,
  },
  "coder.printhead_temp": {
    csvId: "coder.printhead_temp",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/printhead_temp"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 30000,
    mqttEventDriven: false,
  },
  "coder.ink_pump_speed": {
    csvId: "coder.ink_pump_speed",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/ink_pump_speed"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 5000,
    mqttEventDriven: false,
  },
  "coder.ink_pressure": {
    csvId: "coder.ink_pressure",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/ink_pressure"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 5000,
    mqttEventDriven: false,
  },
  "coder.ink_viscosity_actual": {
    csvId: "coder.ink_viscosity_actual",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/ink_viscosity_actual"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 30000,
    mqttEventDriven: false,
  },
  "coder.supply_voltage": {
    csvId: "coder.supply_voltage",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/supply_voltage"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 60000,
    mqttEventDriven: false,
  },
  "coder.ink_consumption_ml": {
    csvId: "coder.ink_consumption_ml",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/ink_consumption_ml"),
    dataType: "float",
    isCounter: true,
    mqttIntervalMs: 60000,
    mqttEventDriven: false,
  },
  "coder.nozzle_health": {
    csvId: "coder.nozzle_health",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/nozzle_health"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: true,
  },
  "coder.gutter_fault": {
    csvId: "coder.gutter_fault",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("coder/gutter_fault"),
    dataType: "bool",
    isCounter: false,
    mqttIntervalMs: null,
    mqttEventDriven: true,
  },

  // ---- MQTT: Environment signals ----
  "environment.ambient_temp": {
    csvId: "environment.ambient_temp",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("env/ambient_temp"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 60000,
    mqttEventDriven: false,
  },
  "environment.ambient_humidity": {
    csvId: "environment.ambient_humidity",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("env/ambient_humidity"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 60000,
    mqttEventDriven: false,
  },

  // ---- MQTT: Vibration signals ----
  "vibration.main_drive_x": {
    csvId: "vibration.main_drive_x",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("vibration/main_drive_x"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 1000,
    mqttEventDriven: false,
  },
  "vibration.main_drive_y": {
    csvId: "vibration.main_drive_y",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("vibration/main_drive_y"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 1000,
    mqttEventDriven: false,
  },
  "vibration.main_drive_z": {
    csvId: "vibration.main_drive_z",
    modbusName: null,
    opcuaName: null,
    mqttTopic: mqtt("vibration/main_drive_z"),
    dataType: "float",
    isCounter: false,
    mqttIntervalMs: 1000,
    mqttEventDriven: false,
  },
};

// ---------------------------------------------------------------------------
// Cross-protocol overlap table
// ---------------------------------------------------------------------------

/** Signals that appear on both Modbus HR and OPC-UA (same values, different encoding). */
export const CROSS_PROTOCOL_OVERLAP = [
  "press.line_speed",
  "press.web_tension",
  "press.ink_viscosity",
  "press.ink_temperature",
  "press.dryer_temp_zone_1",
  "press.dryer_temp_zone_2",
  "press.dryer_temp_zone_3",
  "press.dryer_setpoint_zone_1",
  "press.dryer_setpoint_zone_2",
  "press.dryer_setpoint_zone_3",
  "press.impression_count",
  "press.good_count",
  "press.waste_count",
  "press.machine_state",
  "press.fault_code",
  "press.main_drive_current",
  "press.main_drive_speed",
  "press.nip_pressure",
  "press.unwind_diameter",
  "press.rewind_diameter",
  "laminator.nip_temp",
  "laminator.nip_pressure",
  "laminator.tunnel_temp",
  "laminator.web_speed",
  "laminator.adhesive_weight",
  "slitter.speed",
  "slitter.web_tension",
  "slitter.reel_count",
  "energy.line_power",
  "energy.cumulative_kwh",
] as const;

/**
 * Modbus IR signals and their corresponding HR signal (same underlying value,
 * different encoding: int16 x10 vs float32). IR value * 0.1 should match HR value.
 */
export const IR_TO_HR_PAIRS: Array<{ irName: string; hrName: string }> = [
  { irName: "press.dryer_temp_zone_1_ir", hrName: "press.dryer_temp_zone_1" },
  { irName: "press.dryer_temp_zone_2_ir", hrName: "press.dryer_temp_zone_2" },
  { irName: "press.dryer_temp_zone_3_ir", hrName: "press.dryer_temp_zone_3" },
  { irName: "press.ink_temperature_ir", hrName: "press.ink_temperature" },
  { irName: "laminator.nip_temp_ir", hrName: "laminator.nip_temp" },
  { irName: "laminator.tunnel_temp_ir", hrName: "laminator.tunnel_temp" },
];

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** All expected Modbus metric names (including IR, coils, DI). */
export const EXPECTED_MODBUS_NAMES = Object.values(SIGNALS)
  .filter((s) => s.modbusName !== null)
  .map((s) => s.modbusName!);

/** All expected OPC-UA metric names. */
export const EXPECTED_OPCUA_NAMES = Object.values(SIGNALS)
  .filter((s) => s.opcuaName !== null)
  .map((s) => s.opcuaName!);

/** All expected MQTT topics. */
export const EXPECTED_MQTT_TOPICS = Object.values(SIGNALS)
  .filter((s) => s.mqttTopic !== null)
  .map((s) => s.mqttTopic!);

/** Counter signal names (for monotonicity checks). */
export const COUNTER_SIGNALS = Object.values(SIGNALS)
  .filter((s) => s.isCounter)
  .map((s) => s.csvId);

/** Build a lookup from MQTT topic to CSV signal ID. */
export const MQTT_TOPIC_TO_CSV_ID = new Map<string, string>(
  Object.values(SIGNALS)
    .filter((s) => s.mqttTopic !== null)
    .map((s) => [s.mqttTopic!, s.csvId]),
);

/** Build a lookup from Edge metric name to CSV signal ID for Modbus. */
export const MODBUS_NAME_TO_CSV_ID = new Map<string, string>(
  Object.values(SIGNALS)
    .filter((s) => s.modbusName !== null)
    .map((s) => [s.modbusName!, s.csvId]),
);

/** Build a lookup from Edge metric name to CSV signal ID for OPC-UA. */
export const OPCUA_NAME_TO_CSV_ID = new Map<string, string>(
  Object.values(SIGNALS)
    .filter((s) => s.opcuaName !== null)
    .map((s) => [s.opcuaName!, s.csvId]),
);
