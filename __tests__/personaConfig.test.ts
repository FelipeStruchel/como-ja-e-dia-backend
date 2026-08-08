import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    personaConfig: { findUnique: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
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
    vi.mocked(prisma.personaConfig.findUnique).mockResolvedValueOnce(null) // group-specific lookup
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValueOnce({ prompt: 'global fallback tone' } as any) // groupId: null lookup
    const result = await getPersonaPrompt('a@g.us')
    expect(prisma.personaConfig.findUnique).toHaveBeenCalledWith({ where: { groupId: 'a@g.us' } })
    expect(prisma.personaConfig.findFirst).toHaveBeenCalledWith({ where: { groupId: null } })
    expect(result).toBe(`${AI_PERSONA_GUARDS.trim()}\n\nglobal fallback tone`)
  })

  it('falls back to the hardcoded default when neither row exists', async () => {
    vi.mocked(prisma.personaConfig.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValue(null)
    const result = await getPersonaPrompt('a@g.us')
    expect(result).toBe(`${AI_PERSONA_GUARDS.trim()}\n\n${AI_PERSONA_DEFAULT.trim()}`)
  })

  it('with no groupId argument, goes straight to the groupId=null row via findFirst', async () => {
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValueOnce({ prompt: 'global' } as any)
    await getPersonaPrompt()
    expect(prisma.personaConfig.findUnique).not.toHaveBeenCalled()
    expect(prisma.personaConfig.findFirst).toHaveBeenCalledTimes(1)
    expect(prisma.personaConfig.findFirst).toHaveBeenCalledWith({ where: { groupId: null } })
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

  it('groupId=null updates the existing global fallback row when one exists', async () => {
    process.env.GEMINI_API_KEY = 'test'
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValue({ id: 7, prompt: 'old global' } as any)
    vi.mocked(prisma.personaConfig.update).mockResolvedValue({ prompt: 'new global' } as any)
    await savePersonaPrompt(null, 'new global')
    expect(prisma.personaConfig.findFirst).toHaveBeenCalledWith({ where: { groupId: null } })
    expect(prisma.personaConfig.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { prompt: 'new global' },
    })
    expect(prisma.personaConfig.create).not.toHaveBeenCalled()
    expect(prisma.personaConfig.upsert).not.toHaveBeenCalled()
  })

  it('groupId=null creates the global fallback row when none exists yet', async () => {
    process.env.GEMINI_API_KEY = 'test'
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.personaConfig.create).mockResolvedValue({ prompt: 'new global' } as any)
    await savePersonaPrompt(null, 'new global')
    expect(prisma.personaConfig.findFirst).toHaveBeenCalledWith({ where: { groupId: null } })
    expect(prisma.personaConfig.create).toHaveBeenCalledWith({
      data: { groupId: null, prompt: 'new global' },
    })
    expect(prisma.personaConfig.update).not.toHaveBeenCalled()
    expect(prisma.personaConfig.upsert).not.toHaveBeenCalled()
  })
})
