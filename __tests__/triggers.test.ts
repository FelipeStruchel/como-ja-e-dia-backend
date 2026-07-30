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
