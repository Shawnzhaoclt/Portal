import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { Metrics } from "./types";

type Props = {
  metrics: Metrics;
};

export function MetricsChart({ metrics }: Props) {
  const chartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }
    const chart = echarts.init(chartRef.current, undefined, { renderer: "canvas" });
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(chartRef.current);
    return () => {
      resizeObserver.disconnect();
      chart.dispose();
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }
    const chart = echarts.getInstanceByDom(chartRef.current);
    chart?.setOption({
      backgroundColor: "transparent",
      grid: { left: 6, right: 6, top: 6, bottom: 16, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(6,17,29,0.96)",
        borderColor: "#2876a5",
        textStyle: { color: "#eef7ff", fontSize: 11, fontWeight: 700 },
      },
      xAxis: {
        type: "category",
        data: ["Active", "Labels", "Rendered"],
        axisLabel: { color: "#92b8d2", fontSize: 9, fontWeight: 700 },
        axisLine: { lineStyle: { color: "#1c4564" } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "rgba(28,69,100,0.55)" } },
        axisLabel: { color: "#92b8d2", fontSize: 9, fontWeight: 700 },
      },
      series: [
        {
          type: "bar",
          data: [metrics.activeLayers, metrics.visibleLabels, metrics.renderedFeatures],
          barMaxWidth: 22,
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
            color: (params: { dataIndex: number }) => ["#63d7ff", "#8c6bc8", "#37c26b"][params.dataIndex],
          },
        },
      ],
    });
  }, [metrics]);

  return <div ref={chartRef} className="h-28 w-full" aria-label="Map metrics chart" />;
}
