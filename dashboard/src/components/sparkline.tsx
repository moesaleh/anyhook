"use client";

import { cn } from "@/lib/utils";

interface SparklineProps {
  /** Numeric series; line is drawn from min(series) to max(series). */
  data: number[];
  /** Tailwind text-color classes for the line (defaults to indigo). */
  className?: string;
  /** Width / height in CSS pixels. The path is drawn in a 100×30 viewBox. */
  width?: number;
  height?: number;
}

/**
 * Tiny inline-SVG sparkline. No external dep.
 *
 * Renders a smooth path from a numeric series scaled into the viewBox.
 * If every value is 0 (or the series is degenerate) we draw a flat
 * baseline instead of NaN-filled points.
 */
export function Sparkline({
  data,
  className,
  width = 80,
  height = 24,
}: SparklineProps) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min;
  // 100x30 viewBox — preserveAspectRatio:none stretches to fit width/height.
  const W = 100;
  const H = 30;

  const xStep = data.length === 1 ? 0 : W / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * xStep;
    // Invert Y: SVG origin is top-left; high values should plot up.
    const y = range === 0 ? H / 2 : H - ((v - min) / range) * H;
    return [x, y] as const;
  });

  const path = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");

  // Filled area under the line for a softer look.
  const areaPath =
    `${path} L${(W).toFixed(2)},${H} L0,${H} Z`;

  return (
    <svg
      role="img"
      aria-label={`Trend: ${data.length} data points`}
      width={width}
      height={height}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("text-indigo-500 dark:text-indigo-400", className)}
    >
      <path d={areaPath} fill="currentColor" fillOpacity={0.12} />
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
