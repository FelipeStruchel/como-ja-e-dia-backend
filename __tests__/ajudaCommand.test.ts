import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    linkedGroup: { findMany: vi.fn().mockResolvedValue([]) },
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
  isPokemonEnabled: vi.fn(),
}))

vi.mock('../services/logger.js', () => ({ log: vi.fn() }))
vi.mock('../services/ai.js', () => ({ generateAIAnalysis: vi.fn() }))
vi.mock('../services/dropService.js', () => ({ executeDrop: vi.fn() }))
vi.mock('../services/pokemonService.js', () => ({ fetchAndCachePokemon: vi.fn() }))

import { createCommandProcessor } from '../handlers/commands.js'
import { prisma } from '../services/db.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { log } from '../services/logger.js'
import { generateAIAnalysis } from '../services/ai.js'
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
    body, from, author: '5511999@s.whatsapp.net', id: 'msg1',
    isGroup: true, fromMe: false, participants: [], mentionedJids: [],
  }
}

beforeEach(() => vi.clearAllMocks())

describe('!ajuda', () => {
  it('includes the pokemon sections and !pokemon <nome> when pokemonEnabled is true', async () => {
    vi.mocked(isPokemonEnabled).mockResolvedValue(true)
    const process = makeProcessor()
    await process(makeMsg('!ajuda'))
    const sent = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(sent.content).toContain('!pokemons')
    expect(sent.content).toContain('!give')
    expect(sent.content).toContain('!trade')
    expect(sent.content).toContain('!pokemon <nome>')
    expect(sent.content).not.toContain('desativados neste grupo')
  })

  it('omits the pokemon sections and adds the disabled note when pokemonEnabled is false', async () => {
    vi.mocked(isPokemonEnabled).mockResolvedValue(false)
    const process = makeProcessor()
    await process(makeMsg('!ajuda'))
    const sent = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(sent.content).not.toContain('!pokemons')
    expect(sent.content).not.toContain('!give')
    expect(sent.content).not.toContain('!trade')
    expect(sent.content).not.toContain('!pokemon <nome>')
    expect(sent.content).toContain('desativados neste grupo')
  })

  it('always includes !analise, !all, and the Miru section regardless of pokemonEnabled', async () => {
    vi.mocked(isPokemonEnabled).mockResolvedValue(false)
    const process = makeProcessor()
    await process(makeMsg('!ajuda'))
    const sent = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(sent.content).toContain('!analise')
    expect(sent.content).toContain('!all')
    expect(sent.content).toContain('!miru help')
  })

  it('!help is a synonym and behaves identically', async () => {
    vi.mocked(isPokemonEnabled).mockResolvedValue(true)
    const process = makeProcessor()
    await process(makeMsg('!help'))
    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)
  })
})
