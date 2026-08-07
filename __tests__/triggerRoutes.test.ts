import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
  requireGroupAdmin: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/groupService.js', () => ({
  getAdminGroupIds: vi.fn(),
}))

vi.mock('../services/db.js', () => ({
  prisma: { trigger: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() } },
}))

import { requireAuth, requireGroupAdmin } from '../middleware/auth.js'
import { getAdminGroupIds } from '../services/groupService.js'
import { prisma } from '../services/db.js'
import { registerTriggerRoutes } from '../routes/triggers.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
    put: (path: string, ...h: unknown[]) => { routes[`PUT ${path}`] = h },
    delete: (path: string, ...h: unknown[]) => { routes[`DELETE ${path}`] = h },
  }
  return { app: app as any, routes }
}

beforeEach(() => vi.clearAllMocks())

describe('trigger routes wiring', () => {
  it('GET /triggers requires auth only (no requireRole)', () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    expect(routes['GET /triggers']).toContain(requireAuth)
  })

  it('POST, PUT, and DELETE are gated (contain requireAuth via requireGroupAdmin)', () => {
    // requireGroupAdmin is a distinct mocked function returned fresh on every call, so it can
    // never literally equal requireAuth. Capture each call's return value via mockReturnValueOnce
    // before registering routes, then assert the route array contains that captured value.
    const postMw = vi.fn((req: any, res: any, next: any) => next())
    const putMw = vi.fn((req: any, res: any, next: any) => next())
    const deleteMw = vi.fn((req: any, res: any, next: any) => next())
    vi.mocked(requireGroupAdmin)
      .mockReturnValueOnce(postMw)
      .mockReturnValueOnce(putMw)
      .mockReturnValueOnce(deleteMw)

    const { app, routes } = makeApp()
    registerTriggerRoutes(app)

    expect(routes['POST /triggers']).toContain(postMw)
    expect(routes['PUT /triggers/:id']).toContain(putMw)
    expect(routes['DELETE /triggers/:id']).toContain(deleteMw)
  })
})

describe('GET /triggers filtering', () => {
  it('super_admin sees every trigger', async () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    const handler = routes['GET /triggers'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [{ role: { slug: 'super_admin' } }] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(prisma.trigger.findMany).mock.calls[0][0] as any
    expect(call.where).toBeUndefined()
    expect(getAdminGroupIds).not.toHaveBeenCalled()
  })

  it('a scoped admin sees only their groups (plus the always-empty-in-practice global branch)', async () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    const handler = routes['GET /triggers'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getAdminGroupIds).mockResolvedValue(['a@g.us'])
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(prisma.trigger.findMany).mock.calls[0][0] as any
    expect(call.where.OR).toEqual([{ groupId: null }, { groupId: { in: ['a@g.us'] } }])
  })
})
