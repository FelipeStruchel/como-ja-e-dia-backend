import { describe, it, expect } from 'vitest'
import { calculateDropProbability, DROP_CONFIG } from '../services/dropConstants.js'

describe('calculateDropProbability', () => {
  it('returns 1/48 with zero activity (average 4h)', () => {
    expect(calculateDropProbability(0)).toBeCloseTo(1 / 48)
  })

  it('returns 1/24 with 24 messages (average 2h)', () => {
    expect(calculateDropProbability(24)).toBeCloseTo(1 / 24)
  })

  it('returns 1/8 with 40 messages (average 40min)', () => {
    expect(calculateDropProbability(40)).toBeCloseTo(1 / 8)
  })

  it('caps at 0.5 when activity is very high (>=46)', () => {
    expect(calculateDropProbability(46)).toBeCloseTo(0.5)
    expect(calculateDropProbability(100)).toBeCloseTo(0.5)
  })

  it('never exceeds 0.5', () => {
    for (let i = 0; i <= 200; i++) {
      expect(calculateDropProbability(i)).toBeLessThanOrEqual(0.5)
    }
  })

  it('always returns positive probability', () => {
    expect(calculateDropProbability(0)).toBeGreaterThan(0)
  })

  it('probability increases monotonically with activity up to cap', () => {
    const p0 = calculateDropProbability(0)
    const p24 = calculateDropProbability(24)
    const p40 = calculateDropProbability(40)
    expect(p24).toBeGreaterThan(p0)
    expect(p40).toBeGreaterThan(p24)
  })
})
