import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { BarChart, CustomChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import { init, use } from 'echarts/core'
import type { ECharts, EChartsOption } from 'echarts'
import { CanvasRenderer } from 'echarts/renderers'

use([
  BarChart,
  CustomChart,
  LineChart,
  ScatterChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
])

type EChartProps = {
  option: EChartsOption
  height?: number | string
}

export type EChartHandle = {
  exportImage: (type: 'png' | 'jpg', pixelRatio?: number) => string | null
}

export const EChart = forwardRef<EChartHandle, EChartProps>(function EChart(
  { option, height = 360 },
  ref,
) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ECharts | null>(null)

  useImperativeHandle(ref, () => ({
    exportImage: (type: 'png' | 'jpg', pixelRatio = 1) =>
      chartRef.current?.getDataURL({
        type: type === 'jpg' ? 'jpeg' : type,
        pixelRatio,
        backgroundColor: '#ffffff',
        excludeComponents: ['toolbox'],
      }) ?? null,
  }), [])

  useEffect(() => {
    if (!elementRef.current) {
      return undefined
    }

    chartRef.current = init(elementRef.current, undefined, {
      renderer: 'canvas',
    })

    const observer = new ResizeObserver(() => {
      chartRef.current?.resize()
    })
    observer.observe(elementRef.current)

    return () => {
      observer.disconnect()
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option])

  return <div className="echart" ref={elementRef} style={{ height }} />
})
