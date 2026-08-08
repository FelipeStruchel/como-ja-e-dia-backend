import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../utils/ip.js', () => ({ getRequestIp: vi.fn(() => '1.2.3.4') }))
vi.mock('../services/sendQueue.js', () => ({ enqueueSendMessage: vi.fn() }))
vi.mock('../services/groupService.js', () => ({ getConfessionsEnabledGroupIds: vi.fn() }))
vi.mock('../services/db.js', () => ({
  prisma: { group: { findMany: vi.fn() } },
}))

import { getRequestIp } from '../utils/ip.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { getConfessionsEnabledGroupIds } from '../services/groupService.js'
import { prisma } from '../services/db.js'
import { registerConfessionRoutes } from '../routes/confessions.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
  }
  return { app: app as any, routes }
}

function makeDeps() {
  return { MAX_TEXT_LENGTH: 1000, MAX_MESSAGE_LENGTH: 4096, CONFESSION_COOLDOWN_MINUTES: 5 }
}

function makeReqRes(body: Record<string, unknown>) {
  const req = { body } as any
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any
  return { req, res }
}

beforeEach(() => vi.clearAllMocks())

describe('GET /confessions/groups', () => {
  it('is registered with no auth middleware and returns id+name for confessionsEnabled groups', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    expect(routes['GET /confessions/groups']).toHaveLength(1) // just the handler, no auth middleware
    const handler = routes['GET /confessions/groups'][0] as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.group.findMany).mockResolvedValue([{ id: 'a@g.us', name: 'Grupo A' }] as any)
    const { req, res } = makeReqRes({})
    await handler(req, res)
    expect(prisma.group.findMany).toHaveBeenCalledWith({
      where: { confessionsEnabled: true },
      select: { id: true, name: true },
    })
    expect(res.json).toHaveBeenCalledWith([{ id: 'a@g.us', name: 'Grupo A' }])
  })
})

describe('POST /confessions', () => {
  it('rejects a groupId that is not currently confessionsEnabled', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    const handler = routes['POST /confessions'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getConfessionsEnabledGroupIds).mockResolvedValue(['a@g.us'])
    const { req, res } = makeReqRes({ message: 'oi', groupId: 'b@g.us' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Grupo inválido' })
    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })

  it('sends only to the chosen group when it is eligible', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    const handler = routes['POST /confessions'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getConfessionsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    const { req, res } = makeReqRes({ message: 'oi', groupId: 'a@g.us' })
    await handler(req, res)
    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'a@g.us', type: 'text' })
    )
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  })

  it('cooldown blocks a second request to the same group but allows a different group immediately', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    const handler = routes['POST /confessions'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getConfessionsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])

    const first = makeReqRes({ message: 'oi', groupId: 'a@g.us' })
    await handler(first.req, first.res)
    expect(first.res.status).not.toHaveBeenCalledWith(429)

    const secondSameGroup = makeReqRes({ message: 'de novo', groupId: 'a@g.us' })
    await handler(secondSameGroup.req, secondSameGroup.res)
    expect(secondSameGroup.res.status).toHaveBeenCalledWith(429)

    const differentGroup = makeReqRes({ message: 'outro grupo', groupId: 'b@g.us' })
    await handler(differentGroup.req, differentGroup.res)
    expect(differentGroup.res.status).not.toHaveBeenCalledWith(429)
  })

  it('rejects a missing groupId with 400 before ever calling getConfessionsEnabledGroupIds', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    const handler = routes['POST /confessions'].at(-1) as (req: any, res: any) => Promise<void>
    const { req, res } = makeReqRes({ message: 'oi' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Grupo inválido' })
    expect(getConfessionsEnabledGroupIds).not.toHaveBeenCalled()
  })

  it('re-fetches the eligible group set fresh on every request instead of caching it', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    const handler = routes['POST /confessions'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getConfessionsEnabledGroupIds)
      .mockResolvedValueOnce(['a@g.us'])
      .mockResolvedValueOnce([])

    const first = makeReqRes({ message: 'oi', groupId: 'a@g.us' })
    await handler(first.req, first.res)
    expect(first.res.status).not.toHaveBeenCalledWith(400)
    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)

    const second = makeReqRes({ message: 'de novo', groupId: 'a@g.us' })
    await handler(second.req, second.res)
    expect(second.res.status).toHaveBeenCalledWith(400)
    expect(second.res.json).toHaveBeenCalledWith({ error: 'Grupo inválido' })
    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)
    expect(getConfessionsEnabledGroupIds).toHaveBeenCalledTimes(2)
  })
})
