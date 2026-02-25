// CollatrLineChart — web component wrapping ECharts for time-series line data
// Used in Spike 4 to validate Datastar → web component bridge patterns.

class CollatrLineChart extends HTMLElement {
  static get observedAttributes() {
    return ['latest-point']
  }

  constructor() {
    super()
    this.chart = null
    this.data = []
    this.maxPoints = 200
  }

  connectedCallback() {
    // ECharts needs explicit dimensions
    this.style.display = 'block'
    this.style.width = '100%'
    this.style.height = this.getAttribute('height') || '300px'

    this.chart = echarts.init(this)
    this.chart.setOption({
      animation: false,
      grid: { left: 60, right: 20, top: 30, bottom: 30 },
      xAxis: {
        type: 'time',
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: this.getAttribute('unit') || '',
        min: 'dataMin',
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
    if (!timestamp || !value || isNaN(value) || timestamp < 1000000000000) return

    this.data.push([timestamp, value])
    if (this.data.length > this.maxPoints) {
      this.data.shift()
    }
    this.chart.setOption({
      series: [{ data: this.data }],
    })
  }
}

customElements.define('collatr-line-chart', CollatrLineChart)
