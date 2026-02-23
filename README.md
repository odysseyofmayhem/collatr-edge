# CollatrEdge

IIoT data collection agent for UK SME manufacturers. Collects data from industrial protocols (OPC-UA, Modbus TCP, MQTT), processes it through a configurable pipeline, and stores/forwards it.

## System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM | 256MB (Modbus only) / 512MB (with OPC-UA) | 1GB+ |
| Storage | 100MB (binary + SQLite) | 1GB+ (for buffer persistence) |
| CPU | 1 core ARM/x64 | 2+ cores |
| OS | Linux (kernel 5.x+) | Debian 12+, Ubuntu 22.04+, Alpine 3.18+ |

## Quick Start

```bash
# Download the binary for your architecture
# x64:
wget https://releases.collatr.com/edge/latest/collatr-edge-linux-x64
# ARM64 (Raspberry Pi 4+):
wget https://releases.collatr.com/edge/latest/collatr-edge-linux-arm64

chmod +x collatr-edge-linux-*
sudo mv collatr-edge-linux-* /usr/local/bin/collatr-edge

# Generate default config
collatr-edge config init --output /etc/collatr-edge/config.toml

# Edit config for your environment
nano /etc/collatr-edge/config.toml

# Validate config
collatr-edge config validate --config /etc/collatr-edge/config.toml

# Run
collatr-edge run --config /etc/collatr-edge/config.toml
```

## CLI Commands

```
collatr-edge run              Start the agent
collatr-edge config init      Generate default configuration
collatr-edge config validate  Validate a configuration file
collatr-edge version          Print version and build info
```

### Global Options

| Flag | Default | Description |
|------|---------|-------------|
| `--config`, `-c` | `/etc/collatr-edge/config.toml` | Config file path (also: `COLLATR_EDGE_CONFIG` env var) |
| `--help`, `-h` | | Show help |

### `config init` Options

| Flag | Default | Description |
|------|---------|-------------|
| `--output`, `-o` | `./collatr-edge.toml` | Output file path |
| `--mode` | `local_network` | Network policy preset: `connected`, `local_network`, `standalone` |
| `--force` | `false` | Overwrite existing file |

## Systemd Service

Install as a systemd service for automatic startup and restart on failure.

### Setup

```bash
# Create service user
sudo useradd --system --no-create-home --shell /usr/sbin/nologin collatr-edge

# Create data directories
sudo mkdir -p /var/collatr/data /var/log/collatr-edge /etc/collatr-edge
sudo chown collatr-edge:collatr-edge /var/collatr /var/collatr/data /var/log/collatr-edge

# Generate and edit config
collatr-edge config init --output /etc/collatr-edge/config.toml
sudo nano /etc/collatr-edge/config.toml

# Install systemd unit file
sudo cp deploy/collatr-edge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable collatr-edge
sudo systemctl start collatr-edge
```

### Management

```bash
# Check status
sudo systemctl status collatr-edge

# View logs
sudo journalctl -u collatr-edge -f

# Restart after config change
sudo systemctl restart collatr-edge

# Stop
sudo systemctl stop collatr-edge
```

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
