## Appendix A: Full Config Example

```toml
# CollatrEdge configuration — packaging production line
# Running in local_network mode (most common UK SME deployment)

[agent]
  hostname = "edge-line-3"
  interval = "10s"
  round_interval = true
  collection_jitter = "500ms"
  flush_interval = "10s"
  flush_jitter = "500ms"
  precision = "1ms"
  log_level = "info"

[agent.buffer]
  sync_mode = "normal"

# Network Policy — local network only, no internet
[network_policy]
  mode = "local_network"

[network_policy.egress]
  allow_dns = false
  allow_mqtt_hub = false
  allowed_hosts = [
    "192.168.10.200:8086",     # Local InfluxDB
    "192.168.10.1:123",        # Local NTP server
  ]

[network_policy.ingress]
  allow_local_webui = true
  allow_local_api = true
  allowed_cidrs = ["192.168.10.0/24"]

# Hub — configured but inactive (mode = local_network blocks it)
# Credentials preserved for future transition to connected mode
[agent.hub]
  enabled = true
  group_id = "factory_a"
  edge_node_id = "edge-line-3"
  broker = "mqtts://hub.collatr.com:8883"
  tls_cert = "@{secrets:hub_cert}"
  tls_key = "@{secrets:hub_key}"
  heartbeat_interval = "30s"

[global_tags]
  site = "factory_a"
  area = "packaging"
  line = "line_3"

# --- Inputs ---

# --- Direct PLC connection (dedicated mode, default) ---
[[inputs.modbus]]
  alias = "wrapper_plc"
  controller = "tcp://192.168.10.100:502"
  connection_mode = "dedicated"    # one TCP connection to one PLC
  interval = "5s"
  timeout = "3s"
  error_behavior = "retry"
  # Schneider PLC — big-endian (Modbus spec default)
  byte_order = "ABCD"
  # Batch reads: combine contiguous registers into single requests
  optimization = "batch"
  max_batch_size = 125
  max_gap = 10          # split batch if gap > 10 registers

  # READ-ONLY: CollatrEdge only uses FC01-FC04 (read functions).
  # Write function codes (FC05/06/15/16) are not supported.

  [[inputs.modbus.registers]]
    address = 100
    name = "motor_speed"
    type = "holding"
    data_type = "float32"
    scale = 0.01        # raw 8550 → 85.50 RPM
    offset = 0.0
  [[inputs.modbus.registers]]
    address = 102
    name = "temperature"
    type = "holding"
    data_type = "float32"
  [[inputs.modbus.registers]]
    address = 104
    name = "running"
    type = "coil"
  [[inputs.modbus.registers]]
    address = 200
    name = "fault_active"
    type = "holding"
    data_type = "uint16"
    bit = 3             # extract bit 3 as boolean

# --- Modbus TCP gateway with multiple slaves (shared mode) ---
# Use for Moxa MGate, Anybus, or similar gateways that expose
# multiple RS-485 slaves on one TCP endpoint.
# One TCP connection is shared across all slaves — prevents
# exhausting the gateway's connection pool (typically 4-8 max).
[[inputs.modbus]]
  alias = "oven_gateway"
  controller = "tcp://192.168.10.200:502"
  connection_mode = "shared"
  interval = "5s"
  timeout = "3s"
  error_behavior = "retry"
  byte_order = "BADC"             # Eurotherm controllers behind gateway

  [[inputs.modbus.slaves]]
    slave_id = 1                  # Zone 1 controller
    [[inputs.modbus.slaves.registers]]
      address = 1
      name = "temp_zone1"
      data_type = "float32"
      scale = 0.1
  [[inputs.modbus.slaves]]
    slave_id = 2                  # Zone 2 controller
    [[inputs.modbus.slaves.registers]]
      address = 1
      name = "temp_zone2"
      data_type = "float32"
      scale = 0.1
  [[inputs.modbus.slaves]]
    slave_id = 3                  # Zone 3 controller
    [[inputs.modbus.slaves.registers]]
      address = 1
      name = "temp_zone3"
      data_type = "float32"
      scale = 0.1

[[inputs.mqtt_consumer]]
  alias = "env_sensors"
  servers = ["tcp://192.168.10.50:1883"]
  topics = ["sensors/env/#"]
  data_format = "json"
  tags = { sensor_type = "environmental" }

[[inputs.internal]]
  interval = "30s"

# --- Processors ---

[[processors.rename]]
  order = 1
  [[processors.rename.replace]]
    field = "temperature"
    dest = "motor_temp_c"

# --- Aggregators ---

[[aggregators.basicstats]]
  period = "60s"
  drop_original = false
  namepass = ["motor_speed", "motor_temp_c"]

# --- Outputs ---

# Local data store — always-on in local_network mode
[outputs.local_store]
  enabled = true
  path = "/var/collatr/data"
  retention_days = 90
  retention_max_gb = 10
  rotation = "daily"
  downsample_after_days = 7
  downsample_interval = "1m"
  backup_smb_path = "//fileserver/backups/collatredge/edge-line-3/"
  backup_schedule = "02:00"
  backup_credentials = "@{secrets:smb_backup}"

[[outputs.http]]
  alias = "local_influx"
  url = "http://192.168.10.200:8086/api/v2/write?org=factory&bucket=line3"
  data_format = "influx"
  metric_batch_size = 500
  metric_buffer_limit = 10000
  overflow_policy = "disk_spill"
  timeout = "10s"
  retry_max = 5
  retry_backoff = "exponential_jitter"
  [outputs.http.headers]
    Authorization = "Token @{secrets:influx_token}"

[[outputs.file]]
  alias = "debug_log"
  path = "/var/log/collatr-edge/metrics.jsonl"
  data_format = "json"
  enabled = false   # Disabled by default, enable for debugging
```
