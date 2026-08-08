import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    schedule: { findUnique: vi.fn() },
    event: { findMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('../services/ai.js', () => ({ generateAICaption: vi.fn().mockResolvedValue('caption') }))
vi.mock('../services/sendQueue.js', () => ({ enqueueSendMessage: vi.fn() }))
vi.mock('../services/logger.js', () => ({ log: vi.fn() }))
vi.mock('../mediaManager.js', () => ({ getRandomMedia: vi.fn().mockResolvedValue(null) }))
vi.mock('../services/groupService.js', () => ({
  getScheduledGreetingsEnabledGroupIds: vi.fn(),
  isTriggersEnabledForGroup: vi.fn(),
  // Default to enabled so existing pinned-groupId tests don't have to opt in;
  // the "kill switch" test below overrides this once via mockResolvedValueOnce.
  isScheduledGreetingsEnabledForGroup: vi.fn().mockResolvedValue(true),
}))
vi.mock('../services/personaConfig.js', () => ({ getPersonaPrompt: vi.fn() }))
// mockImplementation must use a plain function (not an arrow function) here because
// services/scheduledJobs.ts invokes these with `new` at module load time — arrow
// functions can never be used as constructors, so `new Queue(...)` would throw
// "is not a constructor" if the mock implementation were an arrow function.
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function () { return { add: vi.fn() } }),
  Worker: vi.fn().mockImplementation(function () { return { on: vi.fn() } }),
}))

import { prisma } from '../services/db.js'
import { generateAICaption } from '../services/ai.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { getPersonaPrompt } from '../services/personaConfig.js'
import {
  getScheduledGreetingsEnabledGroupIds,
  isScheduledGreetingsEnabledForGroup,
} from '../services/groupService.js'

// processScheduleJob is not exported today — export it from services/scheduledJobs.ts
// as part of this task (add `export` to its existing declaration; no behavior change).
import { processScheduleJob } from '../services/scheduledJobs.js'

beforeEach(() => vi.clearAllMocks())

function baseSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', active: true, groupId: 'a@g.us', timezone: 'America/Sao_Paulo',
    type: 'text', textContent: 'oi', captionMode: 'none', announceEvents: false,
    personaPrompt: '', includeRandomPool: false, includeIntro: false,
    startDate: null, endDate: null, daysOfWeek: [],
    ...overrides,
  }
}

describe('processScheduleJob target resolution', () => {
  it('a schedule with a specific groupId targets only that group', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(baseSchedule() as any)
    await processScheduleJob('s1')
    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)
    expect(enqueueSendMessage).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'a@g.us' }))
    expect(getScheduledGreetingsEnabledGroupIds).not.toHaveBeenCalled()
  })

  it('a schedule with groupId=null falls back to every scheduledGreetingsEnabled group', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(baseSchedule({ groupId: null }) as any)
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    await processScheduleJob('s1')
    expect(enqueueSendMessage).toHaveBeenCalledTimes(2)
  })

  it('a schedule pinned to a group with scheduledGreetingsEnabled off targets zero groups', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(baseSchedule() as any)
    vi.mocked(isScheduledGreetingsEnabledForGroup).mockResolvedValueOnce(false)
    await processScheduleJob('s1')
    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })
})

describe('processScheduleJob AI caption fan-out', () => {
  it('calls generateAICaption once per group when announceEvents is true', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: true, captionMode: 'auto', type: 'image', mediaUrl: 'x' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    vi.mocked(prisma.event.findMany).mockResolvedValue([])
    await processScheduleJob('s1')
    expect(generateAICaption).toHaveBeenCalledTimes(2)
  })

  it('calls generateAICaption once and reuses it for groups sharing the same resolved persona when announceEvents is false', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: false, captionMode: 'auto', type: 'image', mediaUrl: 'x' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    vi.mocked(getPersonaPrompt).mockResolvedValue('same persona for both')
    await processScheduleJob('s1')
    expect(generateAICaption).toHaveBeenCalledTimes(1)
    expect(enqueueSendMessage).toHaveBeenCalledTimes(2)
  })

  it('calls generateAICaption once per distinct persona bucket when groups resolve to different personas', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: false, captionMode: 'auto', type: 'image', mediaUrl: 'x' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    vi.mocked(getPersonaPrompt).mockImplementation(async (groupId?: string | null) =>
      groupId === 'a@g.us' ? 'persona A' : 'persona B'
    )
    await processScheduleJob('s1')
    expect(generateAICaption).toHaveBeenCalledTimes(2)
  })

  it('a transient getPersonaPrompt failure for one group does not abort the fan-out for the others', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: false, captionMode: 'auto', type: 'image', mediaUrl: 'x' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    vi.mocked(getPersonaPrompt).mockImplementation(async (groupId?: string | null) => {
      if (groupId === 'a@g.us') throw new Error('transient DB error')
      return 'persona B'
    })
    await expect(processScheduleJob('s1')).resolves.toBeUndefined()
    // The failing group still gets a payload — just without an AI caption.
    expect(enqueueSendMessage).toHaveBeenCalledTimes(2)
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'a@g.us', caption: undefined })
    )
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'b@g.us', caption: 'caption' })
    )
    expect(generateAICaption).toHaveBeenCalledTimes(1)
  })

  it('a schedule-level personaPrompt override puts every group in the same bucket without calling getPersonaPrompt', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: false, captionMode: 'auto', type: 'image', mediaUrl: 'x', personaPrompt: 'override' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    await processScheduleJob('s1')
    expect(generateAICaption).toHaveBeenCalledTimes(1)
    expect(getPersonaPrompt).not.toHaveBeenCalled()
  })

  it('never calls generateAICaption for a text-type schedule, even with announceEvents true', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: true, captionMode: 'auto', type: 'text' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    await processScheduleJob('s1')
    expect(generateAICaption).not.toHaveBeenCalled()
    expect(enqueueSendMessage).toHaveBeenCalledTimes(2)
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'a@g.us', type: 'text', content: 'oi' })
    )
  })

  it('never calls generateAICaption for a text-type schedule with announceEvents false (persona-bucket path)', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: false, captionMode: 'auto', type: 'text' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    await processScheduleJob('s1')
    expect(generateAICaption).not.toHaveBeenCalled()
    expect(getPersonaPrompt).not.toHaveBeenCalled()
    expect(enqueueSendMessage).toHaveBeenCalledTimes(2)
  })
})
