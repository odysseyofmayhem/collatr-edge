// CollatrEdge — Per-signal staleness detection for dashboard live values
// Phase 12 Task 12.4: visual feedback when signals stop updating
//
// Tracks when each signal value last changed and applies CSS classes:
// - .signal-fresh  (< 30s since last change) — default appearance
// - .signal-stale  (30-60s) — amber
// - .signal-dead   (> 60s) — red
//
// Works by observing DOM changes on data-text-bound elements via MutationObserver.
// A periodic check (every 5s) re-evaluates staleness for all tracked signals.

// ---------------------------------------------------------------------------
// Thresholds (milliseconds)
// ---------------------------------------------------------------------------

const STALE_MS = 30_000
const DEAD_MS = 60_000
const CHECK_INTERVAL_MS = 5_000

// ---------------------------------------------------------------------------
// State: signal name → last-changed timestamp
// ---------------------------------------------------------------------------

/** @type {Map<string, number>} */
const lastChanged = new Map()

// ---------------------------------------------------------------------------
// Staleness classification
// ---------------------------------------------------------------------------

/**
 * Determine the staleness state of a signal.
 * @param {number} lastUpdate - Timestamp (ms) when value last changed
 * @param {number} now - Current timestamp (ms)
 * @returns {'fresh' | 'stale' | 'dead'}
 */
export function classifyStaleness(lastUpdate, now) {
  const elapsed = now - lastUpdate
  if (elapsed >= DEAD_MS) return 'dead'
  if (elapsed >= STALE_MS) return 'stale'
  return 'fresh'
}

// ---------------------------------------------------------------------------
// DOM: apply staleness classes to signal-value elements
// ---------------------------------------------------------------------------

const STALENESS_CLASSES = ['signal-fresh', 'signal-stale', 'signal-dead']

function applyStalenessClass(element, state) {
  for (const cls of STALENESS_CLASSES) {
    element.classList.remove(cls)
  }
  element.classList.add(`signal-${state}`)
}

function updateAllStaleness() {
  const now = Date.now()
  const elements = document.querySelectorAll('[data-staleness-signal]')

  for (const el of elements) {
    const signalName = el.getAttribute('data-staleness-signal')
    if (!signalName) continue

    const last = lastChanged.get(signalName)
    if (last === undefined) {
      // Never received a value — treat as dead if initial dash is still showing
      applyStalenessClass(el, 'dead')
      continue
    }

    const state = classifyStaleness(last, now)
    applyStalenessClass(el, state)
  }
}

// ---------------------------------------------------------------------------
// Observe Datastar signal value changes via MutationObserver
// ---------------------------------------------------------------------------

function setupObserver() {
  const observer = new MutationObserver((mutations) => {
    const now = Date.now()

    for (const mutation of mutations) {
      if (mutation.type !== 'characterData' && mutation.type !== 'childList') continue

      // Walk up from the changed text node to find the signal-value container
      const target = mutation.type === 'characterData'
        ? mutation.target.parentElement
        : mutation.target

      if (!target) continue

      // Find the closest element with data-staleness-signal
      const signalEl = target.closest
        ? target.closest('[data-staleness-signal]')
        : null

      if (signalEl) {
        const signalName = signalEl.getAttribute('data-staleness-signal')
        if (signalName) {
          lastChanged.set(signalName, now)
          applyStalenessClass(signalEl, 'fresh')
        }
      }
    }
  })

  // Observe the entire container that holds signals
  const container = document.querySelector('[data-signals]')
  if (container) {
    observer.observe(container, {
      characterData: true,
      childList: true,
      subtree: true,
    })
  }
}

// ---------------------------------------------------------------------------
// Periodic staleness check
// ---------------------------------------------------------------------------

let intervalId = null

function startPeriodicCheck() {
  if (intervalId !== null) return
  intervalId = setInterval(updateAllStaleness, CHECK_INTERVAL_MS)
}

function stopPeriodicCheck() {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

function init() {
  setupObserver()
  startPeriodicCheck()
  // Initial check after a short delay to let Datastar initialise
  setTimeout(updateAllStaleness, 2000)
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
}

// Export for testing (CJS fallback — used by require() in tests since
// server.ts imports this file with { type: "file" } which conflicts
// with ESM module resolution in Bun's test runner)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyStaleness, STALE_MS, DEAD_MS }
}
