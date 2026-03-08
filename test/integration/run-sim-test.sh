#!/usr/bin/env bash
# ===========================================================================
# CollatrEdge Integration Test Runner
#
# Orchestrates: simulator start → Edge start → collect → stop → verify
#
# Usage:
#   ./test/integration/run-sim-test.sh [duration_minutes] [seed]
#
# Arguments:
#   duration_minutes  Test duration in minutes (default: 10)
#   seed              Random seed for simulator (default: 42)
#
# Requires:
#   - Docker + Docker Compose
#   - Bun runtime
#   - Run from the collatr-edge repo root
#   - Simulator repo at ../collatr-factory-simulator/
# ===========================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DURATION_MINUTES="${1:-10}"
SEED="${2:-42}"
DURATION_SECONDS=$((DURATION_MINUTES * 60))

EDGE_CONFIG="configs/factory-sim-packaging.toml"
EDGE_DATA_DIR="./data/factory-sim-packaging"
SIM_DIR="../collatr-factory-simulator"
SIM_OUTPUT_DIR="${SIM_DIR}/output"
SIM_HEALTH_URL="http://localhost:8081/health"
HEALTH_TIMEOUT=60  # seconds to wait for simulator health

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No colour

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)] WARN:${NC} $*"; }
err() { echo -e "${RED}[$(date +%H:%M:%S)] ERROR:${NC} $*"; }
ok() { echo -e "${GREEN}[$(date +%H:%M:%S)] ✅${NC} $*"; }

cleanup() {
  log "Cleaning up..."
  # Stop Edge if still running
  if [[ -n "${EDGE_PID:-}" ]] && kill -0 "$EDGE_PID" 2>/dev/null; then
    log "Stopping Edge (PID $EDGE_PID)..."
    kill -TERM "$EDGE_PID" 2>/dev/null || true
    wait "$EDGE_PID" 2>/dev/null || true
  fi
  # Stop simulator
  if [[ -d "$SIM_DIR" ]]; then
    log "Stopping simulator..."
    (cd "$SIM_DIR" && docker compose down --timeout 10 2>/dev/null) || true
  fi
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

log "CollatrEdge Integration Test"
log "Duration: ${DURATION_MINUTES} minutes, Seed: ${SEED}"
echo ""

# Check we're in the Edge repo root
if [[ ! -f "src/cli.ts" ]]; then
  err "Must run from the collatr-edge repo root (src/cli.ts not found)"
  exit 1
fi

# Check Edge config exists
if [[ ! -f "$EDGE_CONFIG" ]]; then
  err "Edge config not found: $EDGE_CONFIG"
  exit 1
fi

# Check simulator directory
if [[ ! -d "$SIM_DIR" ]]; then
  err "Simulator directory not found: $SIM_DIR"
  exit 1
fi

# Check Docker
if ! command -v docker &>/dev/null; then
  err "Docker not found"
  exit 1
fi

if ! docker info &>/dev/null; then
  err "Docker daemon not running"
  exit 1
fi

# Check Bun
if ! command -v bun &>/dev/null; then
  err "Bun runtime not found"
  exit 1
fi

ok "Preflight checks passed"

# ---------------------------------------------------------------------------
# Step 1: Clean previous output
# ---------------------------------------------------------------------------

log "Cleaning previous test output..."

if [[ -d "$EDGE_DATA_DIR" ]]; then
  rm -rf "$EDGE_DATA_DIR"
  log "  Removed $EDGE_DATA_DIR"
fi

# Clean simulator output (but keep .gitkeep)
if [[ -d "$SIM_OUTPUT_DIR" ]]; then
  find "$SIM_OUTPUT_DIR" -type f ! -name '.gitkeep' -delete 2>/dev/null || true
  log "  Cleaned $SIM_OUTPUT_DIR"
fi

# ---------------------------------------------------------------------------
# Step 2: Generate batch CSV reference (same seed, same duration)
# ---------------------------------------------------------------------------

log "Generating batch CSV reference data (seed=$SEED, duration=${DURATION_MINUTES}m)..."

(cd "$SIM_DIR" && docker compose run --rm \
  -e SIM_RANDOM_SEED="$SEED" \
  factory-simulator \
  --batch-output /app/output \
  --batch-duration "${DURATION_MINUTES}m" \
  --batch-format csv \
  --seed "$SEED" \
  2>&1 | tail -5)

if [[ -f "${SIM_OUTPUT_DIR}/signals.csv" ]]; then
  BATCH_LINES=$(wc -l < "${SIM_OUTPUT_DIR}/signals.csv")
  ok "Batch CSV generated: ${BATCH_LINES} lines"
else
  warn "Batch CSV not generated — accuracy checks will be skipped"
fi

# ---------------------------------------------------------------------------
# Step 3: Start simulator (live mode)
# ---------------------------------------------------------------------------

log "Starting simulator (live mode, seed=$SEED)..."

(cd "$SIM_DIR" && SIM_RANDOM_SEED="$SEED" docker compose up -d)

# Wait for health endpoint
log "Waiting for simulator health (timeout ${HEALTH_TIMEOUT}s)..."
HEALTH_START=$SECONDS
while true; do
  if curl -sf "$SIM_HEALTH_URL" >/dev/null 2>&1; then
    ok "Simulator healthy ($(( SECONDS - HEALTH_START ))s)"
    break
  fi
  if (( SECONDS - HEALTH_START > HEALTH_TIMEOUT )); then
    err "Simulator health timeout after ${HEALTH_TIMEOUT}s"
    err "Check: cd $SIM_DIR && docker compose logs"
    exit 1
  fi
  sleep 1
done

# Quick health info
HEALTH_JSON=$(curl -sf "$SIM_HEALTH_URL" 2>/dev/null || echo '{}')
log "  Health: $HEALTH_JSON"

# ---------------------------------------------------------------------------
# Step 4: Start Edge
# ---------------------------------------------------------------------------

log "Starting CollatrEdge..."

bun run src/cli.ts run --config "$EDGE_CONFIG" &
EDGE_PID=$!

# Give Edge a few seconds to connect
sleep 5

if ! kill -0 "$EDGE_PID" 2>/dev/null; then
  err "Edge process died during startup"
  exit 1
fi

ok "Edge running (PID $EDGE_PID)"

# ---------------------------------------------------------------------------
# Step 5: Wait for test duration
# ---------------------------------------------------------------------------

log "Collecting data for ${DURATION_MINUTES} minutes..."

COLLECT_END=$(( SECONDS + DURATION_SECONDS ))
while (( SECONDS < COLLECT_END )); do
  REMAINING=$(( COLLECT_END - SECONDS ))
  REMAINING_MIN=$(( REMAINING / 60 ))
  REMAINING_SEC=$(( REMAINING % 60 ))
  printf "\r  %02d:%02d remaining..." "$REMAINING_MIN" "$REMAINING_SEC"
  sleep 10
done
echo ""

ok "Collection complete"

# ---------------------------------------------------------------------------
# Step 6: Stop Edge
# ---------------------------------------------------------------------------

log "Stopping Edge (SIGTERM)..."
kill -TERM "$EDGE_PID" 2>/dev/null || true

# Wait up to 10s for graceful shutdown
STOP_START=$SECONDS
while kill -0 "$EDGE_PID" 2>/dev/null; do
  if (( SECONDS - STOP_START > 10 )); then
    warn "Edge didn't stop gracefully, sending SIGKILL"
    kill -9 "$EDGE_PID" 2>/dev/null || true
    break
  fi
  sleep 1
done
wait "$EDGE_PID" 2>/dev/null || true
unset EDGE_PID

ok "Edge stopped"

# ---------------------------------------------------------------------------
# Step 7: Stop simulator
# ---------------------------------------------------------------------------

log "Stopping simulator..."
(cd "$SIM_DIR" && docker compose down --timeout 10)
ok "Simulator stopped"

# ---------------------------------------------------------------------------
# Step 8: Verify
# ---------------------------------------------------------------------------

log "Running verification..."
echo ""

VERIFY_ARGS=(
  --edge-jsonl "${EDGE_DATA_DIR}/metrics.jsonl"
  --duration "$DURATION_SECONDS"
)

# Add batch CSV if available
if [[ -f "${SIM_OUTPUT_DIR}/signals.csv" ]]; then
  VERIFY_ARGS+=(--batch-csv "${SIM_OUTPUT_DIR}/signals.csv")
fi

# Add ground truth if available
if [[ -f "${SIM_OUTPUT_DIR}/ground_truth.jsonl" ]]; then
  VERIFY_ARGS+=(--ground-truth "${SIM_OUTPUT_DIR}/ground_truth.jsonl")
fi

bun run test/integration/verify-edge-data.ts "${VERIFY_ARGS[@]}"
