## 16. Security

### Secret Store

**Default:** SQLite with AES-256 encrypted values.

- Secret values encrypted at rest in SQLite
- Encryption key derived from device-specific seed: `/etc/machine-id` + configurable passphrase (set during provisioning)
- Referenced in config via `@{secrets:key_name}`
- Managed via CLI: `collatr-edge secrets set mqtt_password`, `collatr-edge secrets list`
- **Pluggable interface:** post-MVP backends include JOSE, TPM/HSM, HashiCorp Vault

### TLS

- Hub link: TLS required for production (`mqtts://`). Client certificates supported for mutual TLS.
- Web UI: HTTPS optional (recommended when exposed beyond localhost)
- Output plugins: TLS configurable per-output

### Plugin Isolation

| Plugin Type | Isolation |
|-------------|-----------|
| Built-in | Same process. Trusted. Error-isolated via try/catch. |
| In-process external | Same process. Trusted by operator. Error-isolated via try/catch. |
| Execd external | Separate process. Full isolation. Crash doesn't affect agent. |

### Network Policy Enforcement

See §10 for full details. Key security properties:

- **Explicit egress control:** Network policy defines exactly which hosts the agent can connect to. Enforced at the output plugin layer with startup validation.
- **DNS blocking:** In `local_network` and `standalone` modes, DNS resolution is disabled by default — the agent cannot resolve cloud hostnames even if misconfigured.
- **Fail-fast validation:** Outputs that violate the network policy are rejected at startup with clear error messages, not silently dropped at runtime.
- **Audit logging:** All network policy changes, mode transitions, and blocked connection attempts are logged in the audit trail (see §11).

### Network Posture

- **No open inbound ports required** for Hub connectivity — edge nodes make outbound connections to the broker
- Web UI listens on a configurable local port (default: 8080, bind to localhost by default)
- All MQTT connections are outbound
- In `standalone` mode, the agent has zero network activity — no heartbeats, no retry loops, no background DNS lookups

### Authentication

**MVP:** Basic authentication on the Web UI with two roles:

| Role | Capabilities |
|------|-------------|
| **Admin** | Full access: configuration, secrets, network policy changes, export, mode transitions |
| **Viewer** | Read-only: dashboards, metrics, logs, status. Cannot change configuration or export data. |

Credentials are stored in the local secret store (SQLite + AES-256). Default admin password is set during `collatr-edge config init` or first Web UI access.

**Post-MVP:** LDAP/AD integration for enterprise environments. SSO via Hub for connected mode.
