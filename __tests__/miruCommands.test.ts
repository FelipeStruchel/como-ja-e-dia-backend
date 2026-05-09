import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    linkedGroup: { findFirst: vi.fn() },
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

vi.mock('../services/logger.js', () => ({ log: vi.fn() }))
vi.mock('../services/ai.js', () => ({ generateAIAnalysis: vi.fn() }))
vi.mock('../services/dropService.js', () => ({ executeDrop: vi.fn() }))

import { createCommandProcessor } from '../handlers/commands.js'
import { prisma } from '../services/db.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import {
  consumeRolls, executeMiruDrop, getAlbum, getTopCollectors, resolveGameGroupId,
} from '../services/miruService.js'
import { log } from '../services/logger.js'
import { generateAIAnalysis } from '../services/ai.js'

const GAME_GROUP_ID = 'game-group@g.us'
const MAIN_GROUP_ID = 'main-group@g.us'

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

function makeMsg(body: string, from = GAME_GROUP_ID, mentionedJids: string[] = []) {
  return {
    body,
    from,
    author: '5511999@s.whatsapp.net',
    id: 'msg1',
    isGroup: true,
    fromMe: false,
    participants: [],
    mentionedJids,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('!miru command', () => {
  it('redirects when called in non-game group', async () => {
    vi.mocked(prisma.linkedGroup.findFirst)
      .mockResolvedValueOnce(null)   // not a game group
      .mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)  // is a main group

    const process = makeProcessor()
    await process(makeMsg('!miru', MAIN_GROUP_ID))

    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('!jogo') })
    )
    expect(consumeRolls).not.toHaveBeenCalled()
  })

  it('reports no rolls when consumeRolls returns allowed=0', async () => {
    vi.mocked(prisma.linkedGroup.findFirst).mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)
    vi.mocked(consumeRolls).mockResolvedValue({ allowed: 0, remaining: 0, resetsInSec: 1800 })

    const process = makeProcessor()
    await process(makeMsg('!miru'))

    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('30 minuto') })
    )
    expect(executeMiruDrop).not.toHaveBeenCalled()
  })

  it('executes drop and sends summary on success', async () => {
    vi.mocked(prisma.linkedGroup.findFirst).mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)
    vi.mocked(consumeRolls).mockResolvedValue({ allowed: 2, remaining: 8, resetsInSec: 3600 })
    vi.mocked(executeMiruDrop).mockResolvedValue({ dropped: 2 })

    const process = makeProcessor()
    await process(makeMsg('!miru 2'))

    expect(executeMiruDrop).toHaveBeenCalledWith(GAME_GROUP_ID, '5511999@s.whatsapp.net', 2)
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('2 drops') }),
      expect.objectContaining({ delay: 6000 }),
    )
  })

  it('silently returns when called in a random group with no link', async () => {
    vi.mocked(prisma.linkedGroup.findFirst)
      .mockResolvedValueOnce(null)  // not a game group
      .mockResolvedValueOnce(null)  // not a main group either

    const process = makeProcessor()
    await process(makeMsg('!miru', 'random-group@g.us'))

    expect(enqueueSendMessage).not.toHaveBeenCalled()
    expect(consumeRolls).not.toHaveBeenCalled()
  })

  it('does not send summary when executeMiruDrop returns dropped=0', async () => {
    vi.mocked(prisma.linkedGroup.findFirst).mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)
    vi.mocked(consumeRolls).mockResolvedValue({ allowed: 1, remaining: 9, resetsInSec: 3600 })
    vi.mocked(executeMiruDrop).mockResolvedValue({ dropped: 0 })

    const process = makeProcessor()
    await process(makeMsg('!miru'))

    expect(executeMiruDrop).toHaveBeenCalled()
    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })
})

describe('!album command', () => {
  it('reports no linked group', async () => {
    vi.mocked(resolveGameGroupId).mockResolvedValue(null)

    const process = makeProcessor()
    await process(makeMsg('!album'))

    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('!jogo') })
    )
  })

  it('shows empty album message when no captures', async () => {
    vi.mocked(resolveGameGroupId).mockResolvedValue(GAME_GROUP_ID)
    vi.mocked(getAlbum).mockResolvedValue([])

    const process = makeProcessor()
    await process(makeMsg('!album'))

    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('!miru') })
    )
  })
})

describe('!top command', () => {
  it('reports empty when no collectors', async () => {
    vi.mocked(resolveGameGroupId).mockResolvedValue(GAME_GROUP_ID)
    vi.mocked(getTopCollectors).mockResolvedValue([])

    const process = makeProcessor()
    await process(makeMsg('!top'))

    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('Ninguém') })
    )
  })
})
