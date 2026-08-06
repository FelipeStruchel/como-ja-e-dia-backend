import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
  requireGroupAdmin: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/groupService.js', () => ({
  getAdminGroupIds: vi.fn(),
}))

import { requireAuth, requireGroupAdmin } from '../middleware/auth.js'
import { getAdminGroupIds } from '../services/groupService.js'
import { registerEventRoutes } from '../routes/events.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
    delete: (path: string, ...h: unknown[]) => { routes[`DELETE ${path}`] = h },
  }
  return { app: app as any, routes }
}

function makeDeps() {
  return {
    prisma: {
      event: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
    } as any,
    isDbConnected: () => true,
    tz: (d: any) => ({ isValid: () => true, isBefore: () => false, toDate: () => new Date(d) }) as any,
    moment: Object.assign((d: any) => ({ isValid: () => true, toDate: () => new Date(d) }), {}) as any,
  } as any
}

beforeEach(() => vi.clearAllMocks())

describe('event routes wiring', () => {
  it('GET /events requires auth (no longer public)', () => {
    const { app, routes } = makeApp()
    registerEventRoutes(app, makeDeps())
    expect(routes['GET /events']).toContain(requireAuth)
  })

  it('POST and DELETE use requireGroupAdmin, not requireRole', () => {
    const { app, routes } = makeApp()
    // requireGroupAdmin is a factory: each call returns a distinct middleware
    // function. Capture the exact instances it will hand back (POST is wired
    // first, then DELETE) so we can assert those specific instances end up in
    // the route's middleware chain — proving requireGroupAdmin actually gates
    // these routes, rather than asserting on requireAuth (which requireGroupAdmin's
    // mock never returns).
    const postGroupAdminMw = vi.fn((req, res, next) => next())
    const deleteGroupAdminMw = vi.fn((req, res, next) => next())
    vi.mocked(requireGroupAdmin)
      .mockReturnValueOnce(postGroupAdminMw)
      .mockReturnValueOnce(deleteGroupAdminMw)

    registerEventRoutes(app, makeDeps())

    expect(requireGroupAdmin).toHaveBeenCalledTimes(2)
    expect(routes['POST /events']).toContain(postGroupAdminMw)
    expect(routes['DELETE /events/:id']).toContain(deleteGroupAdminMw)
  })
})

describe('GET /events filtering', () => {
  it('super_admin sees every event', async () => {
    const { app, routes } = makeApp()
    const deps = makeDeps()
    registerEventRoutes(app, deps)
    const handler = routes['GET /events'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(deps.prisma.event.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [{ role: { slug: 'super_admin' } }] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(deps.prisma.event.findMany).mock.calls[0][0] as any
    expect(call.where.groupId).toBeUndefined()
    expect(getAdminGroupIds).not.toHaveBeenCalled()
  })

  it('a scoped admin sees only their groups plus global events', async () => {
    const { app, routes } = makeApp()
    const deps = makeDeps()
    registerEventRoutes(app, deps)
    const handler = routes['GET /events'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getAdminGroupIds).mockResolvedValue(['a@g.us'])
    vi.mocked(deps.prisma.event.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(deps.prisma.event.findMany).mock.calls[0][0] as any
    expect(call.where.OR).toEqual([{ groupId: null }, { groupId: { in: ['a@g.us'] } }])
  })
})
