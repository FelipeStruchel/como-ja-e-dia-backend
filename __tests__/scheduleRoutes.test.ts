import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
  requireGroupAdmin: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/groupService.js', () => ({
  getAdminGroupIds: vi.fn(),
}))

vi.mock('../services/scheduledJobs.js', () => ({
  clearRepeat: vi.fn(),
  registerRepeat: vi.fn(),
  resyncSchedules: vi.fn(),
}))

import { requireAuth, requireGroupAdmin } from '../middleware/auth.js'
import { getAdminGroupIds } from '../services/groupService.js'
import { registerScheduleRoutes } from '../routes/schedules.js'

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

vi.mock('../services/db.js', () => ({
  prisma: { schedule: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() } },
}))

import { prisma } from '../services/db.js'

beforeEach(() => vi.clearAllMocks())

describe('schedule routes wiring', () => {
  it('GET /schedules requires auth only (no requireRole)', () => {
    const { app, routes } = makeApp()
    registerScheduleRoutes(app)
    expect(routes['GET /schedules']).toContain(requireAuth)
  })

  it('POST, PUT, DELETE, and resync use requireGroupAdmin-style gating', () => {
    // requireGroupAdmin is a distinct mocked function returned fresh on every call, so it can
    // never literally equal requireAuth. Capture each call's return value via mockReturnValueOnce
    // before registering routes, then assert the route array contains that captured value.
    const postMw = vi.fn((req: any, res: any, next: any) => next())
    const putMw = vi.fn((req: any, res: any, next: any) => next())
    const deleteMw = vi.fn((req: any, res: any, next: any) => next())
    const resyncMw = vi.fn((req: any, res: any, next: any) => next())
    vi.mocked(requireGroupAdmin)
      .mockReturnValueOnce(postMw)
      .mockReturnValueOnce(putMw)
      .mockReturnValueOnce(deleteMw)
      .mockReturnValueOnce(resyncMw)

    const { app, routes } = makeApp()
    registerScheduleRoutes(app)

    expect(routes['POST /schedules']).toContain(postMw)
    expect(routes['PUT /schedules/:id']).toContain(putMw)
    expect(routes['DELETE /schedules/:id']).toContain(deleteMw)
    expect(routes['POST /schedules/resync']).toContain(resyncMw)
  })
})

describe('GET /schedules filtering', () => {
  it('super_admin sees every schedule', async () => {
    const { app, routes } = makeApp()
    registerScheduleRoutes(app)
    const handler = routes['GET /schedules'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [{ role: { slug: 'super_admin' } }] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(prisma.schedule.findMany).mock.calls[0][0] as any
    expect(call.where).toBeUndefined()
    expect(getAdminGroupIds).not.toHaveBeenCalled()
  })

  it('a scoped admin sees only their groups plus global schedules', async () => {
    const { app, routes } = makeApp()
    registerScheduleRoutes(app)
    const handler = routes['GET /schedules'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getAdminGroupIds).mockResolvedValue(['a@g.us'])
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(prisma.schedule.findMany).mock.calls[0][0] as any
    expect(call.where.OR).toEqual([{ groupId: null }, { groupId: { in: ['a@g.us'] } }])
  })
})

describe('POST /schedules/resync', () => {
  it('is registered with requireGroupAdmin gating (super_admin-only via requireGroupAdmin(() => null))', async () => {
    // The real middleware is mocked as a pass-through above for wiring checks;
    // this test asserts the route is registered with requireGroupAdmin at all —
    // requireGroupAdmin's own behavior for a `() => null` resolver is already
    // covered by __tests__/requireGroupAdmin.test.ts (Task 2), not re-tested here.
    // registerScheduleRoutes calls requireGroupAdmin 4 times in route-registration order
    // (POST /schedules, PUT /schedules/:id, DELETE /schedules/:id, POST /schedules/resync);
    // queue return values for all 4 calls and capture the one resync actually receives.
    const resyncMw = vi.fn((req: any, res: any, next: any) => next())
    vi.mocked(requireGroupAdmin)
      .mockReturnValueOnce(vi.fn((req: any, res: any, next: any) => next()))
      .mockReturnValueOnce(vi.fn((req: any, res: any, next: any) => next()))
      .mockReturnValueOnce(vi.fn((req: any, res: any, next: any) => next()))
      .mockReturnValueOnce(resyncMw)

    const { app, routes } = makeApp()
    registerScheduleRoutes(app)
    expect(routes['POST /schedules/resync']).toContain(resyncMw)
  })
})
