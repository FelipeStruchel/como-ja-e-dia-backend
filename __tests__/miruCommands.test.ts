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
  getRollState: vi.fn(),
  ROLL_ALLOWANCE: 10,
  ROLL_WINDOW_MS: 3_600_000,
}))

vi.mock('../services/characterSyncService.js', () => ({
  drawRolls: vi.fn(),
  executeRollDrops: vi.fn(),
}))

vi.mock('../services/logger.js', () => ({ log: vi.fn() }))
vi.mock('../services/ai.js', () => ({ generateAIAnalysis: vi.fn() }))
vi.mock('../services/dropService.js', () => ({ executeDrop: vi.fn() }))

import { createCommandProcessor } from '../handlers/commands.js'
import { prisma } from '../services/db.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import {
  consumeRolls, executeMiruDrop, getAlbum, getTopCollectors, resolveGameGroupId, getRollState,
} from '../services/miruService.js'
import { drawRolls, executeRollDrops } from '../services/characterSyncService.js'
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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getRollState).mockResolvedValue({ used: 0, windowStart: Date.now() })
})

describe('!miru command', () => {
  it('redirects when called in non-game group', async () => {
    vi.mocked(prisma.linkedGroup.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)

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
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

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

describe('!rolla command (anime)', () => {
  it('parses !rolla 3 as filter=anime, count=3', async () => {
    vi.mocked(prisma.linkedGroup.findFirst).mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)
    vi.mocked(consumeRolls).mockResolvedValue({ allowed: 3, remaining: 7, resetsInSec: 3600 })
    vi.mocked(drawRolls).mockResolvedValue([
      { characterRef: '1', source: 'ANILIST' },
      { characterRef: '2', source: 'ANILIST' },
      { characterRef: '3', source: 'ANILIST' },
    ])
    vi.mocked(executeRollDrops).mockResolvedValue({ dropped: 3 })

    const process = makeProcessor()
    await process(makeMsg('!rolla 3'))

    expect(drawRolls).toHaveBeenCalledWith(
      GAME_GROUP_ID,
      '5511999@s.whatsapp.net',
      'anime',
      3,
      expect.any(Number),
    )
    expect(executeRollDrops).toHaveBeenCalledWith(
      GAME_GROUP_ID,
      '5511999@s.whatsapp.net',
      expect.arrayContaining([expect.objectContaining({ source: 'ANILIST' })]),
    )
  })

  it('defaults count to 1 for !rolla', async () => {
    vi.mocked(prisma.linkedGroup.findFirst).mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)
    vi.mocked(consumeRolls).mockResolvedValue({ allowed: 1, remaining: 9, resetsInSec: 3600 })
    vi.mocked(drawRolls).mockResolvedValue([])
    vi.mocked(executeRollDrops).mockResolvedValue({ dropped: 0 })

    const process = makeProcessor()
    await process(makeMsg('!rolla'))

    expect(drawRolls).toHaveBeenCalledWith(
      GAME_GROUP_ID,
      '5511999@s.whatsapp.net',
      'anime',
      1,
      expect.any(Number),
    )
  })

  it('silently ignores !rolla in unlinked random group', async () => {
    vi.mocked(prisma.linkedGroup.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    const process = makeProcessor()
    await process(makeMsg('!rolla 3', 'random-group@g.us'))

    expect(consumeRolls).not.toHaveBeenCalled()
    expect(drawRolls).not.toHaveBeenCalled()
    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })

  it('reports no rolls and skips pre-roll', async () => {
    vi.mocked(prisma.linkedGroup.findFirst).mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)
    vi.mocked(getRollState).mockResolvedValue({ used: 10, windowStart: Date.now() })
    vi.mocked(consumeRolls).mockResolvedValue({ allowed: 0, remaining: 0, resetsInSec: 1800 })

    const process = makeProcessor()
    await process(makeMsg('!rolla'))

    expect(drawRolls).not.toHaveBeenCalled()
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('Sem rolls') })
    )
  })
})

describe('!rollam (anime female)', () => {
  it('passes filter=anime_female to drawRolls', async () => {
    vi.mocked(prisma.linkedGroup.findFirst).mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)
    vi.mocked(consumeRolls).mockResolvedValue({ allowed: 1, remaining: 9, resetsInSec: 3600 })
    vi.mocked(drawRolls).mockResolvedValue([])
    vi.mocked(executeRollDrops).mockResolvedValue({ dropped: 0 })

    const process = makeProcessor()
    await process(makeMsg('!rollam'))

    expect(drawRolls).toHaveBeenCalledWith(
      GAME_GROUP_ID,
      '5511999@s.whatsapp.net',
      'anime_female',
      1,
      expect.any(Number),
    )
  })
})

describe('!rollah (anime male)', () => {
  it('passes filter=anime_male to drawRolls', async () => {
    vi.mocked(prisma.linkedGroup.findFirst).mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)
    vi.mocked(consumeRolls).mockResolvedValue({ allowed: 1, remaining: 9, resetsInSec: 3600 })
    vi.mocked(drawRolls).mockResolvedValue([])
    vi.mocked(executeRollDrops).mockResolvedValue({ dropped: 0 })

    const process = makeProcessor()
    await process(makeMsg('!rollah'))

    expect(drawRolls).toHaveBeenCalledWith(
      GAME_GROUP_ID,
      '5511999@s.whatsapp.net',
      'anime_male',
      1,
      expect.any(Number),
    )
  })
})

describe('!roll (all sources)', () => {
  it('passes filter=all to drawRolls', async () => {
    vi.mocked(prisma.linkedGroup.findFirst).mockResolvedValueOnce({ gameGroupId: GAME_GROUP_ID } as any)
    vi.mocked(consumeRolls).mockResolvedValue({ allowed: 5, remaining: 5, resetsInSec: 3600 })
    vi.mocked(drawRolls).mockResolvedValue([])
    vi.mocked(executeRollDrops).mockResolvedValue({ dropped: 0 })

    const process = makeProcessor()
    await process(makeMsg('!roll 5'))

    expect(drawRolls).toHaveBeenCalledWith(
      GAME_GROUP_ID,
      '5511999@s.whatsapp.net',
      'all',
      5,
      expect.any(Number),
    )
  })
})

describe('!miru help command', () => {
  it('sends help text mentioning all roll commands', async () => {
    const process = makeProcessor()
    await process(makeMsg('!miru help'))

    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text',
        content: expect.stringMatching(/!roll/),
      })
    )
    const content = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(content.content).toContain('!rollam')
    expect(content.content).toContain('!rollah')
    expect(content.content).toContain('!rolla')
  })
})
