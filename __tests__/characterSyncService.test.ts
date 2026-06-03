import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    character: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    anilistCharacter: { upsert: vi.fn(), update: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    characterOwnership: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn().mockResolvedValue({}) },
    characterSourceMeta: { findUnique: vi.fn() },
  },
}))

vi.mock('../services/sendQueue.js', () => ({
  enqueueSendMessage: vi.fn(),
}))

const sharedRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  ttl: vi.fn().mockResolvedValue(3600),
  exists: vi.fn(),
  rpush: vi.fn(),
  lpop: vi.fn(),
  expire: vi.fn(),
}

vi.mock('../services/redis.js', () => ({
  getRedis: vi.fn(() => sharedRedis),
}))

vi.mock('../services/anilistService.js', () => ({
  fetchRandomPage: vi.fn(),
}))

vi.mock('../services/characterImageService.js', () => ({
  imageExistsLocally: vi.fn().mockResolvedValue(true),
  downloadAndSaveImage: vi.fn(),
  localImagePath: vi.fn((id: number) => `/characters/images/anilist/${id}.jpg`),
}))

vi.mock('../services/miruService.js', () => ({
  rarityFromScore: vi.fn(() => 'COMMON'),
  coinValueFromScore: vi.fn(() => 10),
  ROLL_ALLOWANCE: 10,
}))

vi.mock('../services/logger.js', () => ({ log: vi.fn() }))

import { prisma } from '../services/db.js'
import { getRedis } from '../services/redis.js'
import { fetchRandomPage } from '../services/anilistService.js'
import { drawRolls, executeRollDrops } from '../services/characterSyncService.js'
import { enqueueSendMessage } from '../services/sendQueue.js'

const mockChar = {
  id: 1,
  name: 'Naruto',
  gender: 'MALE' as const,
  series: 'Naruto',
  sourceImageUrl: 'https://cdn.anilist.co/1.jpg',
  favourites: 50000,
}

beforeEach(() => vi.resetAllMocks())

describe('drawRolls', () => {
  it('uses Redis cache on second call without fetching AniList', async () => {
    const redis = getRedis()
    vi.mocked(redis.exists).mockResolvedValue(1)
    ;(redis.lpop as any)
      .mockResolvedValueOnce(JSON.stringify({ characterRef: '1', source: 'ANILIST' }))
      .mockResolvedValueOnce(null)

    const result = await drawRolls('group@g.us', 'user@s.whatsapp.net', 'anime', 1, 3600)

    expect(fetchRandomPage).not.toHaveBeenCalled()
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ characterRef: '1', source: 'ANILIST' })
  })

  it('fetches AniList and builds pool when cache is empty', async () => {
    const redis = getRedis()
    vi.mocked(redis.exists).mockResolvedValue(0)
    ;(redis.lpop as any)
      .mockResolvedValueOnce(JSON.stringify({ characterRef: '1', source: 'ANILIST' }))
      .mockResolvedValueOnce(JSON.stringify({ characterRef: '2', source: 'ANILIST' }))
      .mockResolvedValueOnce(JSON.stringify({ characterRef: '3', source: 'ANILIST' }))
      .mockResolvedValueOnce(null)
    vi.mocked(prisma.characterSourceMeta.findUnique).mockResolvedValue({
      id: 'meta1', source: 'ANILIST', gender: 'ALL', totalCount: 1000, updatedAt: new Date(),
    })
    vi.mocked(prisma.character.count).mockResolvedValue(0)
    vi.mocked(fetchRandomPage).mockResolvedValue({
      characters: Array.from({ length: 50 }, (_, i) => ({ ...mockChar, id: i + 1 })),
      totalCount: 1000,
    })
    vi.mocked(prisma.characterOwnership.findMany).mockResolvedValue([])
    vi.mocked(prisma.anilistCharacter.upsert).mockResolvedValue({} as any)

    const result = await drawRolls('group@g.us', 'user@s.whatsapp.net', 'anime', 3, 3600)

    expect(fetchRandomPage).toHaveBeenCalledOnce()
    expect(redis.rpush).toHaveBeenCalled()
    expect(redis.expire).toHaveBeenCalled()
    expect(result).toHaveLength(3)
    result.forEach((r) => expect(r.source).toBe('ANILIST'))
  })

  it('excludes already-captured characters from pool', async () => {
    const redis = getRedis()
    vi.mocked(redis.exists).mockResolvedValue(0)
    ;(redis.lpop as any)
      .mockResolvedValueOnce(JSON.stringify({ characterRef: '2', source: 'ANILIST' }))
      .mockResolvedValueOnce(null)
    vi.mocked(prisma.characterSourceMeta.findUnique).mockResolvedValue({
      id: 'meta1', source: 'ANILIST', gender: 'ALL', totalCount: 1000, updatedAt: new Date(),
    })
    vi.mocked(prisma.character.count).mockResolvedValue(0)
    vi.mocked(fetchRandomPage).mockResolvedValue({
      characters: [
        { ...mockChar, id: 1 },
        { ...mockChar, id: 2 },
      ],
      totalCount: 1000,
    })
    vi.mocked(prisma.characterOwnership.findMany).mockResolvedValue([
      { characterRef: '1', source: 'ANILIST', id: 'o1', groupId: 'g', ownerJid: 'user', capturedAt: new Date(), rollMessageId: null },
    ])
    vi.mocked(prisma.anilistCharacter.upsert).mockResolvedValue({} as any)

    const result = await drawRolls('group@g.us', 'user@s.whatsapp.net', 'anime', 1, 3600)

    expect(result[0].characterRef).toBe('2')
  })

  it('includes MANUAL characters in !roll all filter', async () => {
    const redis = getRedis()
    vi.mocked(redis.exists).mockResolvedValue(0)
    ;(redis.lpop as any)
      .mockResolvedValueOnce(JSON.stringify({ characterRef: 'manual-1', source: 'MANUAL' }))
      .mockResolvedValueOnce(null)
    vi.mocked(prisma.character.count).mockResolvedValue(100)
    vi.mocked(prisma.character.findMany).mockResolvedValue([
      { id: 'manual-1', name: 'Manual Char' } as any,
    ])
    vi.mocked(fetchRandomPage).mockResolvedValue({
      characters: [{ ...mockChar, id: 1 }],
      totalCount: 1000,
    })
    vi.mocked(prisma.characterOwnership.findMany).mockResolvedValue([])
    vi.mocked(prisma.anilistCharacter.upsert).mockResolvedValue({} as any)

    const result = await drawRolls('group@g.us', 'user@s.whatsapp.net', 'all', 1, 3600)

    expect(result).toHaveLength(1)
    expect(['MANUAL', 'ANILIST']).toContain(result[0].source)
  })
})

describe('executeRollDrops', () => {
  it('creates ownership and enqueues drop for ANILIST source', async () => {
    const redis = getRedis()
    vi.mocked(prisma.anilistCharacter.findUnique).mockResolvedValue({
      name: 'Naruto', series: 'Naruto', rarity: 'EPIC', coinValue: 30, imageUrl: 'https://img/1.jpg',
    } as any)
    vi.mocked(prisma.characterOwnership.create).mockResolvedValue({ id: 'own1' } as any)

    const result = await executeRollDrops('game@g.us', 'user@s', [
      { characterRef: '1', source: 'ANILIST' },
    ])

    expect(result.dropped).toBe(1)
    expect(prisma.characterOwnership.create).toHaveBeenCalledWith({
      data: { characterRef: '1', source: 'ANILIST', groupId: 'game@g.us', ownerJid: null },
    })
    expect(redis.set).toHaveBeenCalledWith(
      'miru:drop:active:game@g.us:own1',
      expect.any(String),
      'EX',
      15,
    )
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'miru_drop', dropId: 'own1' }),
      expect.any(Object),
    )
  })

  it('skips character with non-numeric ref for ANILIST', async () => {
    const result = await executeRollDrops('game@g.us', 'user@s', [
      { characterRef: 'not-a-number', source: 'ANILIST' },
    ])

    expect(result.dropped).toBe(0)
    expect(prisma.anilistCharacter.findUnique).not.toHaveBeenCalled()
    expect(prisma.characterOwnership.create).not.toHaveBeenCalled()
  })

  it('rolls back ownership if Redis SET fails', async () => {
    const redis = getRedis()
    vi.mocked(prisma.anilistCharacter.findUnique).mockResolvedValue({
      name: 'Naruto', series: 'Naruto', rarity: 'EPIC', coinValue: 30, imageUrl: 'https://img/1.jpg',
    } as any)
    vi.mocked(prisma.characterOwnership.create).mockResolvedValue({ id: 'own1' } as any)
    vi.mocked(prisma.characterOwnership.delete).mockResolvedValue({} as any)
    vi.mocked(redis.set).mockRejectedValue(new Error('redis down'))

    const result = await executeRollDrops('game@g.us', 'user@s', [
      { characterRef: '1', source: 'ANILIST' },
    ])

    expect(result.dropped).toBe(0)
    expect(prisma.characterOwnership.delete).toHaveBeenCalledWith({ where: { id: 'own1' } })
  })

  it('skips already-owned character (P2002 unique violation)', async () => {
    const redis = getRedis()
    vi.mocked(prisma.anilistCharacter.findUnique).mockResolvedValue({
      name: 'Naruto', series: 'Naruto', rarity: 'EPIC', coinValue: 30, imageUrl: 'https://img/1.jpg',
    } as any)

    const { Prisma } = await import('@prisma/client')
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7.7.0' })
    vi.mocked(prisma.characterOwnership.create).mockRejectedValue(p2002)

    const result = await executeRollDrops('game@g.us', 'user@s', [
      { characterRef: '1', source: 'ANILIST' },
    ])

    expect(result.dropped).toBe(0)
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('creates ownership and enqueues drop for MANUAL source', async () => {
    const redis = getRedis()
    vi.mocked(prisma.character.findUnique).mockResolvedValue({
      name: 'Gandalf', series: 'LOTR', rarity: 'LEGENDARY', coinValue: 100, imageUrl: 'https://img/g.jpg',
    } as any)
    vi.mocked(prisma.characterOwnership.create).mockResolvedValue({ id: 'own2' } as any)

    const result = await executeRollDrops('game@g.us', 'user@s', [
      { characterRef: 'manual-id', source: 'MANUAL' },
    ])

    expect(result.dropped).toBe(1)
    expect(redis.set).toHaveBeenCalledWith(
      'miru:drop:active:game@g.us:own2',
      expect.any(String),
      'EX',
      15,
    )
  })
})
