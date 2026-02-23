## Appendix C: Sparkplug B Topic Map

```
spBv1.0/{group_id}/NBIRTH/{edge_node_id}
  ├── bdSeq: birth/death sequence number
  ├── Node Control/Rebirth: false (boolean, writeable)
  ├── Node Control/Config Version: "abc123" (config hash)
  ├── Properties/
  │   ├── sw_version: "0.1.0"
  │   ├── hw_platform: "linux-arm64"
  │   ├── hostname: "edge-line-3"
  │   └── plugins_loaded: "modbus,mqtt_consumer,internal"
  └── Agent Metrics/
      ├── uptime_seconds: 0
      ├── event_loop_lag_ms: 0
      └── buffer_total_length: 0

spBv1.0/{group_id}/DBIRTH/{edge_node_id}/{device_id}
  ├── All metrics the device will report (name + alias + type + current value)
  └── Properties/
      ├── plugin_type: "modbus"
      ├── plugin_alias: "wrapper_plc"
      └── controller: "tcp://192.168.10.100:502"

spBv1.0/{group_id}/DDATA/{edge_node_id}/{device_id}
  └── Changed metrics only (alias + timestamp + value)

spBv1.0/{group_id}/NCMD/{edge_node_id}
  ├── Node Control/Rebirth: true → triggers full rebirth
  ├── Node Control/Config: <payload> → config push from Hub
  └── Node Control/Restart: true → graceful restart

spBv1.0/{group_id}/NDEATH/{edge_node_id}
  └── bdSeq: correlates with NBIRTH (published by broker as Will Message)
```
