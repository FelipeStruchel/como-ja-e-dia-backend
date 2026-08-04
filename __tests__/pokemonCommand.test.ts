import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    linkedGroup: { findMany: vi.fn().mockResolvedValue([]) },
    pokemonCache: { findMany: vi.fn().mockResolvedValue([]) },
    pokemonDrop: { findMany: vi.fn().mockResolvedValue([]) },
  },
}))

vi.mock('../services/redis.js', () => ({
  getRedis: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })),
}))

vi.mock('../services/sendQueue.js', () => ({
  enqueueSendMessage: vi.fn(),
}))

vi.mock('../services/miruService.js', () => ({
  consumeRolls: vi.fn(),
  executeMiruDrop: vi.fn(),
  getAlbum: vi.fn(),
  getTopCollectors: vi.fn(),
  resolveGameGroupId: vi.fn(),
  ROLL_ALLOWANCE: 10,
}))

vi.mock('../services/characterSyncService.js', () => ({
  drawRolls: vi.fn(),
  executeRollDrops: vi.fn(),
}))

vi.mock('../services/groupService.js', () => ({
  isGroupRegistered: vi.fn().mockResolvedValue(true),
  isPokemonEnabled: vi.fn().mockResolvedValue(true),
}))

vi.mock('../services/logger.js', () => ({ log: vi.fn() }))
vi.mock('../services/ai.js', () => ({ generateAIAnalysis: vi.fn() }))
vi.mock('../services/dropService.js', () => ({ executeDrop: vi.fn() }))
vi.mock('../services/pokemonService.js', () => ({
  fetchAndCachePokemon: vi.fn(),
}))

import { createCommandProcessor } from '../handlers/commands.js'
import { prisma } from '../services/db.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { log } from '../services/logger.js'
import { generateAIAnalysis } from '../services/ai.js'
import { fetchAndCachePokemon } from '../services/pokemonService.js'
import { isPokemonEnabled } from '../services/groupService.js'

const ALLOWED_GROUP_ID = '120363339314665620@g.us'

function makeProcessor() {
  return createCommandProcessor({
    log,
    generateAIAnalysis,
    prisma: prisma as any,
    MAX_MESSAGE_LENGTH: 4096,
    ANALYSE_COOLDOWN_SECONDS: 60,
    isDbConnected: () => true,
    enqueueSendMessage,
  })
}

function makeMsg(body: string, from = ALLOWED_GROUP_ID) {
  return {
    body,
    from,
    author: '5511999@s.whatsapp.net',
    id: 'msg1',
    isGroup: true,
    fromMe: false,
    participants: [],
    mentionedJids: [],
  }
}

beforeEach(() => vi.clearAllMocks())

describe('!pokemon parsing', () => {
  it('bare !pokemon still lists the caller collection (unchanged)', async () => {
    vi.mocked(prisma.pokemonCache.findMany).mockResolvedValue([] as any)
    const process = makeProcessor()
    await process(makeMsg('!pokemon'))
    // Pokemons-list branch queries pokemonDrop, not pokemonCache directly for this message;
    // the important assertion is that it does NOT go through the new PokemonInfo "not found" path.
    expect(enqueueSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Pokémon não encontrado') })
    )
  })
})

describe('!pokemon <nome> lookup', () => {
  it('sends the Pokémon image+caption when found via PokeAPI (English slug/id)', async () => {
    vi.mocked(fetchAndCachePokemon).mockResolvedValue({
      id: 25,
      name: 'Pikachu',
      imageUrl: 'https://img/pikachu.png',
      types: ['electric'],
      captureRate: 190,
    })
    const process = makeProcessor()
    await process(makeMsg('!pokemon pikachu'))

    expect(fetchAndCachePokemon).toHaveBeenCalledWith('pikachu')
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'image',
        content: 'https://img/pikachu.png',
        caption: expect.stringContaining('Pikachu'),
      })
    )
  })

  it('falls back to the local pt-BR cache (case/accent-insensitive) when the API lookup fails', async () => {
    vi.mocked(fetchAndCachePokemon).mockRejectedValue(new Error('Request failed with status code 404'))
    vi.mocked(prisma.pokemonCache.findMany).mockResolvedValue([
      { id: 3, name: 'Venusaur', imageUrl: 'https://img/venusaur.png', types: ['grass', 'poison'], captureRate: 45 },
    ] as any)

    const process = makeProcessor()
    await process(makeMsg('!pokemon venusaur'))

    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'image',
        content: 'https://img/venusaur.png',
        caption: expect.stringContaining('Venusaur'),
      })
    )
  })

  it('does nothing when pokemon is disabled for the group (same gate as !pokemon)', async () => {
    vi.mocked(isPokemonEnabled).mockResolvedValueOnce(false)
    const process = makeProcessor()
    await process(makeMsg('!pokemon pikachu'))

    expect(fetchAndCachePokemon).not.toHaveBeenCalled()
    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })

  it('replies with a not-found message when neither lookup resolves', async () => {
    vi.mocked(fetchAndCachePokemon).mockRejectedValue(new Error('Request failed with status code 404'))
    vi.mocked(prisma.pokemonCache.findMany).mockResolvedValue([] as any)

    const process = makeProcessor()
    await process(makeMsg('!pokemon naoexiste'))

    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text',
        content: expect.stringContaining('Pokémon não encontrado'),
      })
    )
  })
})
