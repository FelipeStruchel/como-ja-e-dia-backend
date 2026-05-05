import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    character: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    characterOwnership: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      groupBy: vi.fn(),
    },
    linkedGroup: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}))

vi.mock('../services/redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    getdel: vi.fn(),
    del: vi.fn(),
    ttl: vi.fn(),
  })),
}))

vi.mock('../services/sendQueue.js', () => ({
  enqueueSendMessage: vi.fn(),
}))

import {
  rarityFromScore,
  coinValueFromScore,
  createCharacter,
  listCharacters,
  softDeleteCharacter,
} from '../services/miruService.js'
import { prisma } from '../services/db.js'

beforeEach(() => vi.clearAllMocks())

describe('rarityFromScore', () => {
  it('returns LEGENDARY for score >= 90', () => {
    expect(rarityFromScore(90)).toBe('LEGENDARY')
    expect(rarityFromScore(100)).toBe('LEGENDARY')
  })

  it('returns EPIC for score >= 70 and < 90', () => {
    expect(rarityFromScore(70)).toBe('EPIC')
    expect(rarityFromScore(89)).toBe('EPIC')
  })

  it('returns RARE for score >= 40 and < 70', () => {
    expect(rarityFromScore(40)).toBe('RARE')
    expect(rarityFromScore(69)).toBe('RARE')
  })

  it('returns COMMON for score < 40', () => {
    expect(rarityFromScore(39)).toBe('COMMON')
    expect(rarityFromScore(0)).toBe('COMMON')
  })

  it('uses override when provided', () => {
    expect(rarityFromScore(95, 'COMMON')).toBe('COMMON')
    expect(rarityFromScore(10, 'LEGENDARY')).toBe('LEGENDARY')
  })
})

describe('coinValueFromScore', () => {
  it('COMMON = floor(score * 1)', () => {
    expect(coinValueFromScore(39, 'COMMON')).toBe(39)
    expect(coinValueFromScore(35.7, 'COMMON')).toBe(35)
  })

  it('RARE = floor(score * 2)', () => {
    expect(coinValueFromScore(50, 'RARE')).toBe(100)
    expect(coinValueFromScore(50.9, 'RARE')).toBe(101)
  })

  it('EPIC = floor(score * 4)', () => {
    expect(coinValueFromScore(75, 'EPIC')).toBe(300)
  })

  it('LEGENDARY = floor(score * 8)', () => {
    expect(coinValueFromScore(90, 'LEGENDARY')).toBe(720)
  })
})

describe('createCharacter', () => {
  it('computes rarity and coinValue from popularityScore', async () => {
    vi.mocked(prisma.character.create).mockResolvedValue({
      id: 'c1', name: 'Naruto', series: 'Naruto', category: 'ANIME',
      imageUrl: 'https://img.com/naruto.jpg', rarity: 'EPIC',
      popularityScore: 75, coinValue: 300, active: true,
      createdAt: new Date(), updatedAt: new Date(),
    } as any)

    await createCharacter({
      name: 'Naruto', series: 'Naruto', category: 'ANIME',
      imageUrl: 'https://img.com/naruto.jpg', popularityScore: 75,
    })

    expect(prisma.character.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ rarity: 'EPIC', coinValue: 300 }),
    })
  })

  it('uses rarityOverride when provided', async () => {
    vi.mocked(prisma.character.create).mockResolvedValue({} as any)
    await createCharacter({
      name: 'Test', series: 'Test', category: 'ANIME',
      imageUrl: 'url', popularityScore: 95, rarityOverride: 'COMMON',
    })
    expect(prisma.character.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ rarity: 'COMMON', coinValue: 95 }),
    })
  })
})

describe('listCharacters', () => {
  it('returns items and total with active filter', async () => {
    vi.mocked(prisma.character.findMany).mockResolvedValue([])
    vi.mocked(prisma.character.count).mockResolvedValue(0)

    const result = await listCharacters({ activeOnly: true })

    expect(prisma.character.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ active: true }) })
    )
    expect(result).toEqual({ items: [], total: 0 })
  })
})

describe('softDeleteCharacter', () => {
  it('sets active = false', async () => {
    vi.mocked(prisma.character.update).mockResolvedValue({} as any)
    await softDeleteCharacter('c1')
    expect(prisma.character.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { active: false },
    })
  })
})
