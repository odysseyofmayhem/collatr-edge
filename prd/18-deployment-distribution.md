## 18. Deployment & Distribution

### Binary

Single compiled Bun binary. Two targets for MVP:

| Target | Architecture | Use Case |
|--------|-------------|----------|
| `collatr-edge-linux-x64` | Linux x86_64 | Industrial PCs, servers, VMs |
| `collatr-edge-linux-arm64` | Linux aarch64 | Raspberry Pi 4/5, ARM gateways |

### Installation

```bash
# Download
curl -fsSL https://get.collatr.com/edge | sh

# Or manual
wget https://releases.collatr.com/edge/latest/collatr-edge-linux-arm64
chmod +x collatr-edge-linux-arm64
sudo mv collatr-edge-linux-arm64 /usr/local/bin/collatr-edge

# Generate default config
collatr-edge config init

# Run
collatr-edge run --config /etc/collatr-edge/config.toml

# Or install as systemd service
collatr-edge service install
```

### System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM | 512MB (with OPC-UA) / 256MB (Modbus only) | 1GB+ |
| Storage | 100MB (binary + SQLite) | 1GB+ (for buffer persistence) |
| CPU | 1 core ARM/x64 | 2+ cores |
| OS | Linux (kernel 5.x+) | Debian 12+, Ubuntu 22.04+, Alpine 3.18+ |

### CLI

```
collatr-edge run              Start the agent
collatr-edge config init      Generate default config (prompts for network policy mode)
collatr-edge config validate  Validate a config file (including network policy)
collatr-edge config test      Validate + dry-run plugin init (no data collection)
collatr-edge secrets set      Set a secret value
collatr-edge secrets list     List secret keys (not values)
collatr-edge secrets delete   Delete a secret
collatr-edge plugins list     List available plugins
collatr-edge export           Export data from local store (--from, --to, --format, --output)
collatr-edge service install  Install as systemd service
collatr-edge service remove   Remove systemd service
collatr-edge version          Print version and build info
```
