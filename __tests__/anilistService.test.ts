import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    characterSourceMeta: {
      findUnique: vi.fn(),
    },
  },
}))

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

function makeFetchResponse(data: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    headers: { get: (k: string) => headers[k] ?? null },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('fetchSourceMeta', () => {
  it('returns totalCount for ALL, MALE, FEMALE', async () => {
    mockFetch
      .mockResolvedValueOnce(makeFetchResponse({
        data: { Page: { pageInfo: { total: 10000 }, characters: [{ id: 1 }] } },
      }))
      .mockResolvedValueOnce(makeFetchResponse({
        data: { Page: { pageInfo: { total: 4000 }, characters: [{ id: 2 }] } },
      }))
      .mockResolvedValueOnce(makeFetchResponse({
        data: { Page: { pageInfo: { total: 5000 }, characters: [{ id: 3 }] } },
      }))

    const { fetchSourceMeta } = await import('../services/anilistService.js')
    const result = await fetchSourceMeta()

    expect(result).toEqual([
      { gender: 'ALL', totalCount: 10000 },
      { gender: 'MALE', totalCount: 4000 },
      { gender: 'FEMALE', totalCount: 5000 },
    ])
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })
})

describe('fetchRandomPage', () => {
  it('maps AniList response to AnilistCharacterData', async () => {
    const { prisma } = await import('../services/db.js')
    vi.mocked(prisma.characterSourceMeta.findUnique).mockResolvedValue({
      id: 'meta1', source: 'ANILIST', gender: 'ALL', totalCount: 1000, updatedAt: new Date(),
    })

    mockFetch.mockResolvedValueOnce(makeFetchResponse({
      data: {
        Page: {
          pageInfo: { total: 1000, lastPage: 20 },
          characters: [{
            id: 42,
            name: { full: 'Naruto Uzumaki' },
            gender: 'Male',
            image: { large: 'https://cdn.anilist.co/42.jpg' },
            favourites: 80000,
            media: { nodes: [{ title: { romaji: 'Naruto' } }] },
          }],
        },
      },
    }, { 'X-RateLimit-Remaining': '85' }))

    const { fetchRandomPage } = await import('../services/anilistService.js')
    const result = await fetchRandomPage(undefined, 1)

    expect(result.characters).toHaveLength(1)
    expect(result.characters[0]).toMatchObject({
      id: 42,
      name: 'Naruto Uzumaki',
      gender: 'MALE',
      series: 'Naruto',
      sourceImageUrl: 'https://cdn.anilist.co/42.jpg',
      favourites: 80000,
    })
    expect(result.totalCount).toBe(1000)
  })

  it('passes gender variable to AniList for female filter', async () => {
    const { prisma } = await import('../services/db.js')
    vi.mocked(prisma.characterSourceMeta.findUnique).mockResolvedValue({
      id: 'meta2', source: 'ANILIST', gender: 'FEMALE', totalCount: 400, updatedAt: new Date(),
    })

    mockFetch.mockResolvedValueOnce(makeFetchResponse({
      data: { Page: { pageInfo: { total: 400, lastPage: 8 }, characters: [] } },
    }))

    const { fetchRandomPage } = await import('../services/anilistService.js')
    await fetchRandomPage('Female', 1)

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.variables.gender).toBe('Female')
  })

  it('falls back to totalCount 1000 when meta not found', async () => {
    const { prisma } = await import('../services/db.js')
    vi.mocked(prisma.characterSourceMeta.findUnique).mockResolvedValue(null)

    mockFetch.mockResolvedValueOnce(makeFetchResponse({
      data: { Page: { pageInfo: { total: 500, lastPage: 10 }, characters: [] } },
    }))

    const { fetchRandomPage } = await import('../services/anilistService.js')
    const result = await fetchRandomPage(undefined, 3)

    expect(mockFetch).toHaveBeenCalled()
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.variables.page).toBe(3)
    expect(result.totalCount).toBe(500)
  })
})
