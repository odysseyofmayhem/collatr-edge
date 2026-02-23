# Bun Runtime Validation — Spike Results

**Date:** 2026-02-23
**Runtime tested:** Bun 1.3.9
**Host:** Linux x86_64 (Docker container)
**Verdict:** ✅ **ALL SPIKES PASS — Bun confirmed as CollatrEdge runtime**

---

## Summary

Five validation spikes were executed sequentially to confirm Bun as the runtime for CollatrEdge before committing to the 8–10 week build. Each spike was run by an independent agent with full test criteria, and results were reviewed before proceeding to the next.

| # | Spike | Risk | Verdict | Key Finding |
|---|-------|------|---------|-------------|
| 1 | SQLite (`bun:sqlite`) | 🟢 Low | ✅ GO | Built-in, 613k rows/sec, no native deps |
| 2 | Single Binary (`bun build --compile`) | 🟢 Low | ✅ GO | 97.8 MB binary, 27ms startup |
| 3 | node-opcua | 🔴 High | ✅ GO | Pure JS in v4.x — biggest risk eliminated |
| 4 | ARM64 Cross-Compilation | 🟡 Medium | ✅ GO | 103 MB arm64 binary, same compile speed |
| 5 | Modbus TCP (`modbus-serial`) | 🟡 Medium | ✅ GO | `--external=@serialport/bindings-cpp` fixes compile |

---

## Spike 1: SQLite (`bun:sqlite`)

**Tests:** 8/8 pass, 17/18 edge cases pass

Bun ships with `bun:sqlite` as a built-in module — no `better-sqlite3`, no `node-gyp`, no C++ toolchain required on target devices.

### Performance
| Operation | Measurement |
|-----------|-------------|
| 10k batch insert (transaction) | 16 ms (613k rows/sec) |
| 100k batch insert | 230 ms (435k rows/sec) |
| Range query (4k from 100k, indexed) | 0.29 ms |
| Individual autocommit inserts (10k) | 381 ms (26k rows/sec) |

### Validated Features
- WAL mode — enables, persists across reopen, concurrent read/write ✅
- MessagePack field encoding via `msgpackr` — all types round-trip ✅
- Daily file rotation (multiple concurrent DBs) ✅
- WAL checkpoint (TRUNCATE/PASSIVE) + integrity check ✅
- BEGIN IMMEDIATE + SQLITE_BUSY handling ✅
- Prepared statement caching (100k iterations, stable memory) ✅
- FTS5, JSON functions, window functions, UPSERT, RETURNING, ATTACH ✅

### Known Limitation
- `msgpackr` encodes `-0` (negative zero) as integer `0`, losing the sign bit. This is a msgpackr encoder limitation, not SQLite. Irrelevant for IIoT metrics — no OPC-UA or Modbus type semantically distinguishes `-0` from `0`.

### Conclusion
No need for a `better-sqlite3` fallback. `bun:sqlite` eliminates a native compilation dependency and performs well above CollatrEdge requirements.

---

## Spike 2: Single Binary Compilation

**Tests:** 9/9 pass

`bun build --compile` produces a fully self-contained ELF executable with no runtime dependencies.

### Measurements
| Metric | Value |
|--------|-------|
| Binary size (base) | 97.8 MB |
| User code contribution | ~118 KB |
| Compilation time | ~86 ms |
| Startup time (avg of 10) | ~27 ms |

### Validated Features
- SQLite full lifecycle in compiled binary (identical to interpreted) ✅
- Embedded static assets via `import with { type: "text" }` ✅
- CLI args (`process.argv`, `Bun.argv`) and env vars ✅
- Signal handling (SIGTERM, SIGINT) ✅
- Exit codes (including unhandled exceptions) ✅
- `Bun.serve()` HTTP server ✅
- `Bun.spawn()` subprocess execution ✅
- `Bun.Worker` (web workers) ✅
- Dynamic `import()` ✅
- `--minify --sourcemap` (small binary + readable stack traces) ✅

### Production Build Command
```bash
bun build --compile --minify --sourcemap --external=@serialport/bindings-cpp --outfile collatr-edge ./src/main.ts
```

### Notes
- `import.meta.dir` resolves to `/$bunfs/root` in compiled binaries — use `process.cwd()` for actual filesystem paths
- Must compile from project directory (compiling to `/tmp` produces null ELF headers — likely a Bun bug with output path handling)

---

## Spike 3: node-opcua

**Tests:** 9/9 pass

This was anticipated as the highest-risk spike. node-opcua is a massive package (200+ internal modules) originally built for Node.js with native C++ crypto addons. The result was the cleanest of all spikes.

### Key Finding
**node-opcua-crypto v4.x has moved to pure JavaScript.** The native C++ crypto addons that were the primary risk no longer exist. Bun's built-in `crypto` module covers all of node-opcua's requirements.

### Performance
| Operation | Measurement |
|-----------|-------------|
| Install time | 2.59 s |
| Cold import time | 606 ms |
| Client connect | 46 ms |
| Session create | 43 ms |
| Single value read | 1–11 ms |
| Batch read (6 nodes) | 6 ms |
| Compile time | 192 ms |
| Binary size (with node-opcua) | 105 MB |
| RSS (client + server in-process) | ~270 MB |
| RSS (compiled binary, client + server) | ~232 MB |

### Validated Features
- Client connect + session creation ✅
- All data type reads (Boolean, Int32, Float, Double, String, DateTime) ✅
- Subscriptions with data change callbacks ✅
- Address space browsing ✅
- Self-signed certificate generation (TOFU) ✅
- Compilation to standalone binary (all operations work) ✅

### Minor Quirks (non-blocking)
Three certificate *inspection* utility functions have Bun compatibility issues:
1. `exploreCertificate()` — Bun returns `X509Certificate` where node-opcua expects `Buffer` for DER
2. `certificateMatchesPrivateKey()` — Bun's `CryptoKey` doesn't expose `.export()` like Node's `KeyObject`
3. `coerceCertificate()` — same root cause as #1

All three are in diagnostic/validation helpers, not the communication path. The actual TLS handshake, certificate exchange, and session security all work correctly. Categorised as **Fixable** — a thin shim converting `X509Certificate` → `Buffer` would resolve them if needed for the Web UI certificate inspector.

### Memory Estimate for Production
Client-only agent (no test server): ~150–180 MB RSS. Acceptable for Raspberry Pi 4 (1–8 GB RAM).

---

## Spike 4: ARM64 Cross-Compilation

**Tests:** 5/6 pass, 1 skipped (QEMU unavailable)

### Measurements
| Metric | x64 | ARM64 |
|--------|-----|-------|
| Base binary | 98 MB | 96 MB |
| Full stack (+ node-opcua) | 105 MB | 103 MB |
| Compile time | ~300 ms | ~300 ms (same) |

### Validated
- `--target=bun-linux-arm64` produces genuine AArch64 ELF binaries (verified via `file` + `readelf -h`) ✅
- ARM64 Bun runtime downloaded on first cross-compile, cached thereafter ✅
- `--minify --sourcemap` work with ARM64 target ✅

### Not Validated (low risk)
- Runtime execution on ARM64 hardware (QEMU not available in container, no sudo to install). Risk is very low: Bun's ARM64 runtime is an official build, and node-opcua + modbus-serial are pure JS.

### Platform Requirements
- GLIBC 2.25+ required — Raspberry Pi OS Buster (2019) and newer. All Pi 4 hardware meets this.
- 64-bit ARM only (aarch64). No 32-bit ARM support. Pi 1/2/Zero not supported (not our target).

### Available Targets
`bun-linux-arm64`, `bun-linux-x64`, `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`

---

## Spike 5: Modbus TCP

**Tests:** 9/10 pass (1 conditional, resolved)

Two libraries tested: `modbus-serial` (v8.0.23) and `jsmodbus` (v4.0.10).

### Library Comparison
| Criterion | modbus-serial | jsmodbus |
|-----------|:---:|:---:|
| FC01–04 reads | ✅ | ✅ |
| Byte order decoding | ✅ (app-level) | ✅ (app-level) |
| Batch reads (125 regs) | ✅ | ✅ |
| Scale/offset/bit extraction | ✅ (app-level) | ✅ (app-level) |
| Shared connection mode | ✅ `.setID()` | ❌ fixed at construction |
| Error handling | ✅ built-in timeout | ⚠️ needs wrapper |
| Compile to binary | ⚠️ needs `--external` | ✅ pure JS |
| Maintenance | Active | Less active |

### Decision: `modbus-serial`

**Rationale:**
- Shared connection mode (`connection_mode = "shared"`) is a PRD requirement for TCP gateways with multiple Modbus slaves. Only `modbus-serial` supports switching unit IDs on a single TCP connection.
- Better error handling with built-in timeouts and reconnection.
- More actively maintained.
- The compilation issue is fully resolved with `--external=@serialport/bindings-cpp` — the serial addon is excluded from the bundle since CollatrEdge MVP only uses TCP.

### Compilation Fix
```bash
# The serialport native addon breaks bun build --compile, but TCP never uses it
bun build --compile --external=@serialport/bindings-cpp --outfile collatr-edge ./src/main.ts
```
This excludes `@serialport/bindings-cpp` from the bundle. The TCP code path in `modbus-serial` uses Node's built-in `net` module, which Bun implements fully. The serial addon is only loaded if you call `connectRTU()` — which CollatrEdge MVP never does.

### Performance
| Operation | Measurement |
|-----------|-------------|
| Batch read 125 registers | 37–69× faster than individual |
| Connection + read cycle | < 50 ms |
| Error recovery | Clean, no process crashes |

### Byte Order Validation
All four byte orders tested with 6 known float values each:
- ABCD (Big Endian) — Schneider Electric, GE ✅
- CDAB (Big Endian byte swap) — Siemens S7 ✅
- BADC (Little Endian byte swap) — Eurotherm ✅
- DCBA (Little Endian) — rare ✅

Byte order conversion is application-level code using the `Buffer` API, which works identically in Bun.

---

## Production Build Configuration

### x64 Linux
```bash
bun build --compile --minify --sourcemap \
  --external=@serialport/bindings-cpp \
  --outfile collatr-edge \
  ./src/main.ts
```

### ARM64 Linux (Raspberry Pi 4+)
```bash
bun build --compile --minify --sourcemap \
  --target=bun-linux-arm64 \
  --external=@serialport/bindings-cpp \
  --outfile collatr-edge-arm64 \
  ./src/main.ts
```

### Expected Binary Sizes
| Target | Size |
|--------|------|
| x64 (base) | ~98 MB |
| x64 (full stack) | ~105 MB |
| ARM64 (base) | ~96 MB |
| ARM64 (full stack) | ~103 MB |

---

## Dependencies Confirmed

| Package | Version | Type | Notes |
|---------|---------|------|-------|
| `bun:sqlite` | (built-in, SQLite 3.51.2) | Runtime built-in | No external dependency |
| `node-opcua` | latest | Pure JS | v4.x crypto has no native addons |
| `modbus-serial` | 8.0.23 | JS + native (excluded) | TCP path is pure JS |
| `msgpackr` | latest | Pure JS | For MessagePack field encoding |

---

## Risk Register (Post-Spike)

| Risk | Severity | Status | Mitigation |
|------|----------|--------|------------|
| node-opcua native addons | 🔴 High | ✅ Eliminated | v4.x is pure JS |
| ARM64 runtime failures | 🟡 Medium | ⚠️ Low risk | Cross-compile verified, runtime needs real hardware test |
| Modbus serial addon in binary | 🟡 Medium | ✅ Resolved | `--external=@serialport/bindings-cpp` |
| Bun Node.js compat gaps | 🟡 Medium | ✅ Minor | 3 cert inspection utils, non-blocking |
| Binary size (~100 MB) | 🟢 Low | ✅ Accepted | Mostly Bun runtime, acceptable for edge devices |
| Memory usage (~180 MB) | 🟢 Low | ✅ Accepted | Fine for Pi 4 (1–8 GB RAM) |

---

*Spike code and detailed test results: `collatr-edge-spike/spikes/01-05/` in workspace*
