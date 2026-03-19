# CollatrEdge

IIoT data collection agent for SME manufacturers. Collects data from industrial protocols (OPC-UA, Modbus TCP, MQTT), processes it through a configurable pipeline, and stores/forwards it.

## System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM | 256MB (Modbus only) / 512MB (with OPC-UA) | 1GB+ |
| Storage | 100MB (binary + SQLite) | 1GB+ (for buffer persistence) |
| CPU | 1 core ARM/x64 | 2+ cores |
| OS | Linux (kernel 5.x+) | Debian 12+, Ubuntu 22.04+, Alpine 3.18+ |


## Development

Requires [Bun](https://bun.sh/) 1.3.9+.

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run in development
bun run src/index.ts run --config ./config.toml

# Build binary (x64)
bun build --compile --minify --sourcemap --external=@serialport/bindings-cpp --outfile collatr-edge src/index.ts

# Build binary (ARM64, for Raspberry Pi 4+)
bun build --compile --minify --sourcemap --target=bun-linux-arm64 --external=@serialport/bindings-cpp --outfile collatr-edge-arm64 src/index.ts
```
