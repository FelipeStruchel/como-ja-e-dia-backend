import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
  requireWorkerOrRole: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/db.js', () => ({
  prisma: {
    group: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    groupAdmin: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}))

vi.mock('../services/redis.js', () => ({ getRedis: vi.fn() }))
vi.mock('../services/groupDiscoveryQueue.js', () => ({ enqueueGroupDiscoveryJob: vi.fn() }))
vi.mock('../services/groupService.js', () => ({ resetGroupCache: vi.fn() }))

import { requireAuth, requireRole } from '../middleware/auth.js'
import { prisma } from '../services/db.js'
import { resetGroupCache } from '../services/groupService.js'
import { registerGroupRoutes } from '../routes/groups.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
    patch: (path: string, ...h: unknown[]) => { routes[`PATCH ${path}`] = h },
    delete: (path: string, ...h: unknown[]) => { routes[`DELETE ${path}`] = h },
  }
  return { app: app as any, routes }
}

function makeReqRes(body: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  const req = { body, params, query: {} } as any
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any
  return { req, res }
}

beforeEach(() => vi.clearAllMocks())

describe('group admin routes wiring', () => {
  it('all three admin routes require auth', () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    expect(routes['GET /groups/:groupId/admins']).toContain(requireAuth)
    expect(routes['POST /groups/:groupId/admins']).toContain(requireAuth)
    expect(routes['DELETE /groups/:groupId/admins/:userId']).toContain(requireAuth)
  })

  it('all three admin routes are gated with requireRole("super_admin") specifically', () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)

    const calls = vi.mocked(requireRole).mock.calls
    const results = vi.mocked(requireRole).mock.results

    const adminRoutePaths = [
      'GET /groups/:groupId/admins',
      'POST /groups/:groupId/admins',
      'DELETE /groups/:groupId/admins/:userId',
    ]

    for (const path of adminRoutePaths) {
      const handlers = routes[path]
      // Identify which requireRole(...) invocation's returned middleware was
      // actually wired into this route, then assert the args of that exact
      // invocation. This fails if the route were changed to gate on any
      // role other than "super_admin".
      const resultIndex = results.findIndex((r) => handlers.includes(r.value))
      expect(resultIndex).toBeGreaterThanOrEqual(0)
      expect(calls[resultIndex]).toEqual(['super_admin'])
    }
  })
})

describe('GET /groups/:groupId/admins', () => {
  it('lists admins with user info', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['GET /groups/:groupId/admins'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.groupAdmin.findMany).mockResolvedValue([
      { userId: 'u1', groupId: 'g1', createdAt: new Date('2026-01-01'), user: { id: 'u1', email: 'a@b.com', name: 'A' } },
    ] as any)
    const { req, res } = makeReqRes({}, { groupId: 'g1' })
    await handler(req, res)
    expect(prisma.groupAdmin.findMany).toHaveBeenCalledWith({
      where: { groupId: 'g1' },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    })
    expect(res.json).toHaveBeenCalledWith([
      { userId: 'u1', email: 'a@b.com', name: 'A', createdAt: new Date('2026-01-01') },
    ])
  })
})

describe('POST /groups/:groupId/admins', () => {
  it('adds the user found by email as a group admin', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['POST /groups/:groupId/admins'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A' } as any)
    vi.mocked(prisma.groupAdmin.create).mockResolvedValue({ createdAt: new Date('2026-01-01') } as any)
    const { req, res } = makeReqRes({ email: 'A@B.com' }, { groupId: 'g1' })
    await handler(req, res)
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'a@b.com' } })
    expect(prisma.groupAdmin.create).toHaveBeenCalledWith({ data: { userId: 'u1', groupId: 'g1' } })
    expect(resetGroupCache).toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
  })

  it('returns 404 when no user matches the email', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['POST /groups/:groupId/admins'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const { req, res } = makeReqRes({ email: 'nobody@b.com' }, { groupId: 'g1' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(404)
  })

  it('returns 409 when the user is already an admin of that group', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['POST /groups/:groupId/admins'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A' } as any)
    vi.mocked(prisma.groupAdmin.create).mockRejectedValue({ code: 'P2002' })
    const { req, res } = makeReqRes({ email: 'a@b.com' }, { groupId: 'g1' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(409)
  })
})

describe('DELETE /groups/:groupId/admins/:userId', () => {
  it('removes the admin', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['DELETE /groups/:groupId/admins/:userId'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.groupAdmin.delete).mockResolvedValue({} as any)
    const { req, res } = makeReqRes({}, { groupId: 'g1', userId: 'u1' })
    await handler(req, res)
    expect(prisma.groupAdmin.delete).toHaveBeenCalledWith({ where: { userId_groupId: { userId: 'u1', groupId: 'g1' } } })
    expect(resetGroupCache).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true })
  })

  it('returns 404 when the admin does not exist', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['DELETE /groups/:groupId/admins/:userId'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.groupAdmin.delete).mockRejectedValue({ code: 'P2025' })
    const { req, res } = makeReqRes({}, { groupId: 'g1', userId: 'u1' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(404)
  })
})
