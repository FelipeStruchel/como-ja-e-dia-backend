import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: { trigger: { findMany: vi.fn(), update: vi.fn() } },
}))
vi.mock('../services/groupService.js', () => ({
  isTriggersEnabledForGroup: vi.fn(),
}))
vi.mock('../services/sendQueue.js', () => ({ enqueueSendMessage: vi.fn() }))

import { prisma } from '../services/db.js'
import { isTriggersEnabledForGroup } from '../services/groupService.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { createTriggerProcessor } from '../handlers/triggers.js'

function baseTrigger(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 't1',
    groupId: 'groupA@g.us',
    active: true,
    phrases: ['oi'],
    caseSensitive: false,
    normalizeAccents: true,
    matchType: 'contains',
    wholeWord: false,
    chancePercent: 100,
    expiresAt: null,
    maxUses: null,
    triggeredCount: 0,
    allowedUsers: [],
    cooldownSeconds: 0,
    cooldownPerUserSeconds: 0,
    responseType: 'text',
    responseText: 'oi pra você',
    responseMediaUrl: '',
    replyMode: 'reply',
    mentionSender: false,
    ...overrides,
  }
}

describe('createTriggerProcessor group scoping', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires a trigger whose groupId matches the incoming message group', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([baseTrigger()] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'oi', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)
  })

  it('does not fire a trigger registered for a different group', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([baseTrigger({ groupId: 'groupB@g.us' })] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'oi', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })

  it('does not fire any trigger when triggersEnabled is false for the group', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([baseTrigger()] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(false)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'oi', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })
})

describe('createTriggerProcessor echo response', () => {
  beforeEach(() => vi.clearAllMocks())

  it('replaces only the matched substring, keeping the rest of the message (contains)', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'contains',
        wholeWord: false,
        phrases: ['bom dia'],
        responseType: 'echo',
        responseText: 'boa noite',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'bom dia galera!!', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.type).toBe('text')
    expect(call.content).toBe('boa noite galera!!')
  })

  it('replaces the full regex match, keeping text on both sides', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'regex',
        phrases: ['bom d[ia]+'],
        responseType: 'echo',
        responseText: 'boa noite',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'eae bom diaaa pessoal', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.content).toBe('eae boa noite pessoal')
  })

  it('replaces only the first occurrence when the phrase appears more than once', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'contains',
        wholeWord: false,
        phrases: ['oi'],
        responseType: 'echo',
        responseText: 'tchau',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'oi galera oi', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.content).toBe('tchau galera oi')
  })

  it('splices into the original (non-normalized) text even when the match was found case/accent-insensitively', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'contains',
        wholeWord: false,
        caseSensitive: false,
        normalizeAccents: true,
        phrases: ['cafe'],
        responseType: 'echo',
        responseText: 'com leite',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'quero café gelado', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.content).toBe('quero com leite gelado')
  })

  it('handles NFD-encoded (decomposed) accented input without corrupting the echo splice', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'contains',
        wholeWord: false,
        phrases: ['cafe'],
        responseType: 'echo',
        responseText: 'chá',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    const nfdBody = 'quero café gelado hoje'.normalize('NFD')
    await processTrigger({ body: nfdBody, from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.content).toBe('quero chá gelado hoje')
  })

  it('replaces the matched substring correctly when wholeWord is true', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'contains',
        wholeWord: true,
        phrases: ['bom dia'],
        responseType: 'echo',
        responseText: 'boa noite',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'eae, bom dia galera', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.content).toBe('eae, boa noite galera')
  })
})
