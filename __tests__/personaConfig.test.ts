import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: { personaConfig: { findUnique: vi.fn(), upsert: vi.fn() } },
}))
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return {
      models: { generateContent: vi.fn().mockResolvedValue({ text: 'ok' }) },
    }
  }),
}))
vi.mock('../services/logger.js', () => ({ log: vi.fn() }))

import { prisma } from '../services/db.js'
import { getPersonaPrompt, savePersonaPrompt } from '../services/personaConfig.js'
import { AI_PERSONA_DEFAULT, AI_PERSONA_GUARDS } from '../services/personaConstants.js'

beforeEach(() => vi.clearAllMocks())

describe('getPersonaPrompt', () => {
  it('uses the group-specific row when one exists', async () => {
    vi.mocked(prisma.personaConfig.findUnique).mockResolvedValueOnce({ prompt: 'grupo A tone' } as any)
    const result = await getPersonaPrompt('a@g.us')
    expect(prisma.personaConfig.findUnique).toHaveBeenCalledWith({ where: { groupId: 'a@g.us' } })
    expect(result).toBe(`${AI_PERSONA_GUARDS.trim()}\n\ngrupo A tone`)
  })

  it('falls back to the groupId=null row when the group has none of its own', async () => {
    vi.mocked(prisma.personaConfig.findUnique)
      .mockResolvedValueOnce(null) // group-specific lookup
      .mockResolvedValueOnce({ prompt: 'global fallback tone' } as any) // groupId: null lookup
    const result = await getPersonaPrompt('a@g.us')
    expect(prisma.personaConfig.findUnique).toHaveBeenNthCalledWith(1, { where: { groupId: 'a@g.us' } })
    expect(prisma.personaConfig.findUnique).toHaveBeenNthCalledWith(2, { where: { groupId: null } })
    expect(result).toBe(`${AI_PERSONA_GUARDS.trim()}\n\nglobal fallback tone`)
  })

  it('falls back to the hardcoded default when neither row exists', async () => {
    vi.mocked(prisma.personaConfig.findUnique).mockResolvedValue(null)
    const result = await getPersonaPrompt('a@g.us')
    expect(result).toBe(`${AI_PERSONA_GUARDS.trim()}\n\n${AI_PERSONA_DEFAULT.trim()}`)
  })

  it('with no groupId argument, goes straight to the groupId=null row', async () => {
    vi.mocked(prisma.personaConfig.findUnique).mockResolvedValueOnce({ prompt: 'global' } as any)
    await getPersonaPrompt()
    expect(prisma.personaConfig.findUnique).toHaveBeenCalledTimes(1)
    expect(prisma.personaConfig.findUnique).toHaveBeenCalledWith({ where: { groupId: null } })
  })
})

describe('savePersonaPrompt', () => {
  it('upserts keyed by groupId, not by the old fixed id:1', async () => {
    process.env.GEMINI_API_KEY = 'test'
    vi.mocked(prisma.personaConfig.upsert).mockResolvedValue({ prompt: 'new tone' } as any)
    await savePersonaPrompt('a@g.us', 'new tone')
    expect(prisma.personaConfig.upsert).toHaveBeenCalledWith({
      where: { groupId: 'a@g.us' },
      update: { prompt: 'new tone' },
      create: { groupId: 'a@g.us', prompt: 'new tone' },
    })
  })

  it('groupId=null upserts the global fallback row', async () => {
    process.env.GEMINI_API_KEY = 'test'
    vi.mocked(prisma.personaConfig.upsert).mockResolvedValue({ prompt: 'new global' } as any)
    await savePersonaPrompt(null, 'new global')
    expect(prisma.personaConfig.upsert).toHaveBeenCalledWith({
      where: { groupId: null },
      update: { prompt: 'new global' },
      create: { groupId: null, prompt: 'new global' },
    })
  })
})
