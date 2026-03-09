// CollatrEdge — Metric picker + time range controller for the Trends page
// Phase 12 Task 12.3: client-side metric add/remove and time range selection
//
// Vanilla JS module (no framework). Handles:
// 1. "Add metric" dropdown — appends a new chart card when a metric is selected
// 2. Remove button — removes a dynamically added chart and re-adds the metric to the dropdown
// 3. Time range buttons — re-fetches all chart history with updated from/to parameters

// ---------------------------------------------------------------------------
// Chart colour palette (matches server-side palette in trends.tsx)
// ---------------------------------------------------------------------------

const CHART_COLOURS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
]
let colourIndex = CHART_COLOURS.length // start after server-assigned colours

function nextColour() {
  return CHART_COLOURS[colourIndex++ % CHART_COLOURS.length]
}

// ---------------------------------------------------------------------------
// Metric picker: add metric
// ---------------------------------------------------------------------------

function setupMetricPickers() {
  const selects = document.querySelectorAll('[data-picker-select]')

  for (const select of selects) {
    select.addEventListener('change', (e) => {
      const metricName = e.target.value
      if (!metricName) return

      const groupId = e.target.getAttribute('data-picker-select')
      const selectedOption = e.target.selectedOptions[0]
      const unit = selectedOption.getAttribute('data-unit') || ''
      const displayName = selectedOption.getAttribute('data-display-name') || metricName

      // Remove from dropdown
      selectedOption.remove()
      e.target.value = ''

      // Create chart card
      const chartsContainer = document.querySelector(`[data-charts-for="${groupId}"]`)
      if (!chartsContainer) return

      const colour = nextColour()
      const title = unit ? `${displayName} (${unit})` : displayName

      const card = document.createElement('div')
      card.className = 'chart-card chart-card-added'
      card.setAttribute('data-metric', metricName)
      card.innerHTML = `
        <div class="chart-card-header">
          <span class="chart-card-title">${escapeHtml(title)}</span>
          <button class="chart-remove-btn" data-remove-metric="${escapeHtml(metricName)}" title="Remove chart">&times;</button>
        </div>
      `

      const chart = document.createElement('collatr-line-chart')
      chart.setAttribute('metric', metricName)
      chart.setAttribute('color', colour)
      chart.setAttribute('unit', unit)
      chart.setAttribute('height', '200px')

      // Apply current time range
      const activeRange = document.querySelector('.time-range-btn.time-range-active')
      if (activeRange) {
        const hours = parseInt(activeRange.getAttribute('data-time-range'), 10)
        if (hours > 0) {
          chart.setAttribute('data-range-hours', String(hours))
        }
      }

      card.appendChild(chart)
      chartsContainer.appendChild(card)

      // Trigger history load with current time range
      loadChartHistory(chart)
    })
  }
}

// ---------------------------------------------------------------------------
// Remove chart: click handler delegation
// ---------------------------------------------------------------------------

function setupRemoveHandlers() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-metric]')
    if (!btn) return

    const metricName = btn.getAttribute('data-remove-metric')
    const card = btn.closest('.chart-card')
    if (!card) return

    // Find the equipment section
    const section = card.closest('[data-equipment]')
    if (!section) {
      card.remove()
      return
    }

    const groupId = section.getAttribute('data-equipment')

    // Re-add metric to the picker dropdown
    const select = section.querySelector(`[data-picker-select="${groupId}"]`)
    if (select) {
      const chart = card.querySelector('collatr-line-chart')
      const unit = chart ? chart.getAttribute('unit') || '' : ''
      const displayName = btn.closest('.chart-card-header')
        ?.querySelector('.chart-card-title')?.textContent?.replace(/ \(.*\)$/, '') || metricName

      const option = document.createElement('option')
      option.value = metricName
      option.setAttribute('data-unit', unit)
      option.setAttribute('data-display-name', displayName)
      option.textContent = unit ? `${displayName} (${unit})` : displayName
      select.appendChild(option)
    }

    card.remove()
  })
}

// ---------------------------------------------------------------------------
// Time range selector
// ---------------------------------------------------------------------------

function setupTimeRangeButtons() {
  const buttons = document.querySelectorAll('.time-range-btn')

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      // Update active state
      for (const b of buttons) {
        b.classList.remove('time-range-active')
      }
      btn.classList.add('time-range-active')

      // Re-fetch all charts with new time range
      const hours = parseInt(btn.getAttribute('data-time-range'), 10)
      reloadAllCharts(hours)
    })
  }
}

function reloadAllCharts(hours) {
  const charts = document.querySelectorAll('collatr-line-chart')
  for (const chart of charts) {
    chart.setAttribute('data-range-hours', String(hours))
    loadChartHistory(chart, hours)
  }
}

function loadChartHistory(chart, hours) {
  const metric = chart.getAttribute('metric')
  if (!metric) return

  if (!hours) {
    const activeBtn = document.querySelector('.time-range-btn.time-range-active')
    hours = activeBtn ? parseInt(activeBtn.getAttribute('data-time-range'), 10) : 1
  }

  const now = Date.now()
  const from = new Date(now - hours * 3600000).toISOString()
  const to = new Date(now).toISOString()

  fetch(`/api/chart/history?metric=${encodeURIComponent(metric)}&from=${from}&to=${to}`)
    .then(res => res.ok ? res.json() : [])
    .then(points => {
      if (!Array.isArray(points)) return
      // Reset chart data and load new points
      chart.data = points.map(p => [p.timestamp, p.value])
      if (chart.data.length > chart.maxPoints) {
        chart.data = chart.data.slice(chart.data.length - chart.maxPoints)
      }
      chart._historyLoaded = true
      if (chart.chart) {
        chart.chart.setOption({ series: [{ data: chart.data }] })
      }
    })
    .catch(err => console.warn('Failed to load chart history for', metric, err))
}

// ---------------------------------------------------------------------------
// HTML escaping for dynamic content
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// ---------------------------------------------------------------------------
// Initialise on DOM ready
// ---------------------------------------------------------------------------

function init() {
  setupMetricPickers()
  setupRemoveHandlers()
  setupTimeRangeButtons()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
