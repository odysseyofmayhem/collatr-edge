// CollatrLineChart — web component wrapping ECharts for time-series line data
// Phase 9 Task 9.4: historical data load + live append via SSE
//
// Spike findings applied:
// - Bridge A (data-effect → addPoint) is the recommended pattern
// - animation: false required for 1Hz+ updates (spike 4)
// - yAxis min/max = dataMin/dataMax prevents anchoring at 0
// - Guard timestamp < 1e12 to skip initial signal value of 0
// - ResizeObserver for responsive resize

class CollatrLineChart extends HTMLElement {
  static get observedAttributes() {
    return ['latest-point']
  }

  constructor() {
    super()
    this.chart = null
    this.data = []
    this.maxPoints = 1000 // keep last 1000 live points in memory
    this._historyLoaded = false
  }

  connectedCallback() {
    // ECharts needs explicit dimensions
    this.style.display = 'block'
    this.style.width = '100%'
    this.style.height = this.getAttribute('height') || '300px'

    this.chart = echarts.init(this)
    this.chart.setOption({
      animation: false, // required for high-frequency updates (spike 4)
      grid: { left: 60, right: 20, top: 30, bottom: 30 },
      xAxis: {
        type: 'time',
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: this.getAttribute('unit') || '',
        min: 'dataMin', // auto-scale to data range (spike 4)
        max: 'dataMax',
        splitLine: { lineStyle: { type: 'dashed', color: '#eee' } },
      },
      series: [{
        type: 'line',
        data: [],
        showSymbol: false,
        lineStyle: { width: 2, color: this.getAttribute('color') || '#3b82f6' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: (this.getAttribute('color') || '#3b82f6') + '40' },
              { offset: 1, color: (this.getAttribute('color') || '#3b82f6') + '05' },
            ],
          },
        },
      }],
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const p = params[0]
          const date = new Date(p.value[0])
          return `${date.toLocaleTimeString()}<br/>${p.value[1].toFixed(1)} ${this.getAttribute('unit') || ''}`
        },
      },
    })

    // Observe resize
    this._resizeObserver = new ResizeObserver(() => this.chart?.resize())
    this._resizeObserver.observe(this)

    // Load historical data from local store
    this._loadHistory()
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect()
    this.chart?.dispose()
    this.chart = null
  }

  // Bridge B: attributeChangedCallback — triggered by Datastar data-attr:latest-point
  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'latest-point' && newValue && this.chart) {
      try {
        const point = JSON.parse(newValue)
        this._addPoint(point.timestamp, point.value)
      } catch (e) {
        console.warn('CollatrLineChart: invalid latest-point JSON', e)
      }
    }
  }

  // Bridge A: direct method call — triggered by Datastar data-effect
  addPoint(timestamp, value) {
    if (!this.chart) return
    this._addPoint(timestamp, value)
  }

  _addPoint(timestamp, value) {
    // Guard: skip invalid data (e.g., initial signal value of 0)
    // Spike 4: check timestamp > 1e12 to filter epoch-zero
    if (!timestamp || isNaN(value) || timestamp < 1000000000000) return

    this.data.push([timestamp, value])
    if (this.data.length > this.maxPoints) {
      this.data.shift()
    }
    this.chart.setOption({
      series: [{ data: this.data }],
    })
  }

  // Fetch historical data from the /api/chart/history endpoint
  async _loadHistory() {
    const metric = this.getAttribute('metric')
    if (!metric) return

    try {
      const res = await fetch(`/api/chart/history?metric=${encodeURIComponent(metric)}`)
      if (!res.ok) return

      const points = await res.json()
      if (!Array.isArray(points) || points.length === 0) return

      // Replace data with historical points
      this.data = points.map(p => [p.timestamp, p.value])

      // Trim to maxPoints (keep newest)
      if (this.data.length > this.maxPoints) {
        this.data = this.data.slice(this.data.length - this.maxPoints)
      }

      this._historyLoaded = true
      if (this.chart) {
        this.chart.setOption({
          series: [{ data: this.data }],
        })
      }
    } catch (e) {
      console.warn('CollatrLineChart: failed to load history for', metric, e)
    }
  }
}

customElements.define('collatr-line-chart', CollatrLineChart)
