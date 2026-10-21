/** Sparkline geometry keeps the newest point and stays inside the view box. */
import { expect, it } from 'vitest'
import { formatValue, geometry, sample, VIEW_HEIGHT, VIEW_WIDTH } from '../src/client/chart.ts'

const line = (count: number) => Array.from({ length: count }, (_, step) => ({ step, value: step * 2 }))

it('samples evenly and always keeps the first and last points', () => {
  expect(sample(line(3), 5)).toEqual(line(3))
  const kept = sample(line(101), 5)
  expect(kept.map(point => point.step)).toEqual([0, 25, 50, 75, 100])
})

it('scales a series into the view box with lower values drawn lower', () => {
  expect(geometry([])).toBeUndefined()
  expect(geometry([{ step: 0, value: 1 }, { step: 10, value: 3 }, { step: 20, value: 2 }])).toEqual({
    points: `0,${VIEW_HEIGHT} 50,0 ${VIEW_WIDTH},20`, minValue: 1, maxValue: 3, firstStep: 0, lastStep: 20, lastValue: 2,
  })
  expect(geometry([{ step: 7, value: 0.5 }])).toEqual({
    points: `${VIEW_WIDTH / 2},${VIEW_HEIGHT / 2}`, minValue: 0.5, maxValue: 0.5, firstStep: 7, lastStep: 7, lastValue: 0.5,
  })
  expect(geometry(line(1000), 10)!.points.split(' ')).toHaveLength(10)
})

it('formats values with four significant digits and exponents at the extremes', () => {
  expect(formatValue(0)).toBe('0')
  expect(formatValue(0.123456)).toBe('0.1235')
  expect(formatValue(-1234.5)).toBe('-1235')
  expect(formatValue(1.5e7)).toBe('1.50e+7')
  expect(formatValue(2e-5)).toBe('2.00e-5')
})
