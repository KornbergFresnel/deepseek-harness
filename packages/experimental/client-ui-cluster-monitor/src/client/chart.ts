/** Pure geometry for the training-curve sparkline charts. */

import type { ClusterMetricPoint } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'

/** Plotted line and the value range that frames it. */
export interface ChartGeometry {
  /** SVG `points` attribute in a 0–100 × 0–40 view box, y growing downward. */
  readonly points: string
  readonly minValue: number
  readonly maxValue: number
  readonly firstStep: number
  readonly lastStep: number
  readonly lastValue: number
}

/** View box width the geometry is computed for. */
export const VIEW_WIDTH = 100
/** View box height the geometry is computed for. */
export const VIEW_HEIGHT = 40

/**
 * Keep at most `limit` points, evenly spaced by index, always including the last point.
 * @param points - ascending by step.
 * @param limit - retained point count, at least 2.
 * @returns the retained points.
 */
export function sample(points: readonly ClusterMetricPoint[], limit: number): ClusterMetricPoint[] {
  if (points.length <= limit) return [...points]
  const stride = (points.length - 1) / (limit - 1)
  const kept = new Set(Array.from({ length: limit }, (_, index) => Math.round(index * stride)))
  return points.filter((_, index) => kept.has(index))
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/**
 * Scale a series into the view box; a flat series sits on the vertical center.
 * @param points - ascending by step.
 * @param limit - plotted point count.
 * @returns the geometry, or undefined for an empty series.
 */
export function geometry(points: readonly ClusterMetricPoint[], limit = 400): ChartGeometry | undefined {
  const shown = sample(points, limit)
  const first = shown[0]
  const last = shown.at(-1)
  if (first === undefined || last === undefined) return undefined
  const values = shown.map(point => point.value)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const stepSpan = last.step - first.step
  const valueSpan = maxValue - minValue
  const xy = shown.map((point) => {
    const x = stepSpan === 0 ? VIEW_WIDTH / 2 : ((point.step - first.step) / stepSpan) * VIEW_WIDTH
    const y = valueSpan === 0 ? VIEW_HEIGHT / 2 : VIEW_HEIGHT - ((point.value - minValue) / valueSpan) * VIEW_HEIGHT
    return `${round(x)},${round(y)}`
  })
  return { points: xy.join(' '), minValue, maxValue, firstStep: first.step, lastStep: last.step, lastValue: last.value }
}

/**
 * Format a metric value compactly: four significant digits, exponent form for very large or small magnitudes.
 * @param value - finite number.
 * @returns display text.
 */
export function formatValue(value: number): string {
  const magnitude = Math.abs(value)
  if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-3)) return value.toExponential(2)
  return String(Number(value.toPrecision(4)))
}
