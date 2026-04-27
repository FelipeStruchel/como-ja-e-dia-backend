import { describe, it, expect } from 'vitest'
import { weightedRandom } from '../services/dropService.js'

const weights = [
  { id: 1, captureRate: 45 },
  { id: 2, captureRate: 255 },
  { id: 3, captureRate: 3 },
  { id: 4, captureRate: 100 },
]

describe('weightedRandom', () => {
  it('never returns an excluded ID', () => {
    const exclude = new Set([1, 3])
    for (let i = 0; i < 200; i++) {
      const result = weightedRandom(weights, exclude)
      expect(exclude.has(result)).toBe(false)
    }
  })

  it('throws when all IDs are excluded', () => {
    const exclude = new Set([1, 2, 3, 4])
    expect(() => weightedRandom(weights, exclude)).toThrow('Nenhum Pokémon disponível')
  })

  it('always returns an ID that exists in the weights array', () => {
    const validIds = new Set(weights.map((w) => w.id))
    const exclude = new Set<number>()
    for (let i = 0; i < 200; i++) {
      expect(validIds.has(weightedRandom(weights, exclude))).toBe(true)
    }
  })

  it('statistically favors higher captureRate (id=2 should win most)', () => {
    const exclude = new Set<number>()
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
    const RUNS = 10_000
    for (let i = 0; i < RUNS; i++) {
      counts[weightedRandom(weights, exclude)]++
    }
    // id=2 has captureRate 255 out of total 403 ≈ 63% — should win most
    expect(counts[2]).toBeGreaterThan(counts[1])
    expect(counts[2]).toBeGreaterThan(counts[3])
    expect(counts[2]).toBeGreaterThan(counts[4])
    // id=3 has captureRate 3 — should be rare
    expect(counts[3]).toBeLessThan(counts[1])
  })

  it('works with only one item in pool', () => {
    const singleWeight = [{ id: 99, captureRate: 10 }]
    expect(weightedRandom(singleWeight, new Set())).toBe(99)
  })
})
