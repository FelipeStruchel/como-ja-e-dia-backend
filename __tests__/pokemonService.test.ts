import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

vi.mock('../services/redis.js', () => ({
  getRedis: vi.fn(() => ({ get: vi.fn().mockResolvedValue(null), set: vi.fn() })),
}))

vi.mock('../services/db.js', () => ({
  prisma: {
    pokemonCache: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
  },
}))

vi.mock('../services/logger.js', () => ({ log: vi.fn() }))

import { fetchAndCachePokemon } from '../services/pokemonService.js'
import { prisma } from '../services/db.js'

const mockedAxios = vi.mocked(axios)

beforeEach(() => vi.clearAllMocks())

function mockPokeApiResponses(id: number, englishName: string) {
  mockedAxios.get.mockImplementation((url: string) => {
    if (url.includes('/pokemon-species/')) {
      return Promise.resolve({
        data: {
          capture_rate: 45,
          names: [{ name: 'Pikachu', language: { name: 'pt-BR' } }],
        },
      }) as any
    }
    return Promise.resolve({
      data: {
        id,
        name: englishName,
        sprites: { other: { 'official-artwork': { front_default: 'https://img/pikachu.png' } } },
        types: [{ type: { name: 'electric' } }],
      },
    }) as any
  })
}

describe('fetchAndCachePokemon with a numeric id (existing behavior)', () => {
  it('fetches by numeric id and upserts the cache under that id', async () => {
    mockPokeApiResponses(25, 'pikachu')
    const result = await fetchAndCachePokemon(25)
    expect(result.id).toBe(25)
    expect(result.name).toBe('Pikachu')
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/pokemon/25'),
      expect.anything()
    )
    expect(prisma.pokemonCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 25 } })
    )
  })
})

describe('fetchAndCachePokemon with a name (new behavior)', () => {
  it('fetches by English slug and resolves the numeric id from the API response', async () => {
    mockPokeApiResponses(25, 'pikachu')
    const result = await fetchAndCachePokemon('pikachu')
    expect(result.id).toBe(25)
    expect(result.name).toBe('Pikachu')
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/pokemon/pikachu'),
      expect.anything()
    )
    expect(prisma.pokemonCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 25 } })
    )
  })

  it('skips the DB lookup by id when given a name (since the id is unknown up front)', async () => {
    mockPokeApiResponses(25, 'pikachu')
    await fetchAndCachePokemon('pikachu')
    expect(prisma.pokemonCache.findUnique).not.toHaveBeenCalled()
  })

  it('does not retry on a 404 (misspelled name) and calls each endpoint only once', async () => {
    const notFoundErr = {
      isAxiosError: true,
      response: { status: 404 },
      message: 'Request failed with status code 404',
    }
    mockedAxios.get.mockRejectedValue(notFoundErr)
    mockedAxios.isAxiosError.mockReturnValue(true)

    await expect(fetchAndCachePokemon('pikachuu')).rejects.toBe(notFoundErr)
    expect(mockedAxios.get).toHaveBeenCalledTimes(2)
  })

  it('encodes the identifier when building the PokeAPI URLs', async () => {
    mockPokeApiResponses(25, 'pikachu')
    await fetchAndCachePokemon('pika chu')
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/pokemon/pika%20chu'),
      expect.anything()
    )
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/pokemon-species/pika%20chu'),
      expect.anything()
    )
  })
})
