import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/authService.js', () => ({
  registerUser: vi.fn(),
  authenticateUser: vi.fn(),
  getUserById: vi.fn(),
  listUsers: vi.fn(),
  setUserActive: vi.fn(),
  assignRole: vi.fn(),
  removeRole: vi.fn(),
  listRoles: vi.fn(),
  verifyToken: vi.fn(),
}))

vi.mock('../services/groupService.js', () => ({
  getAdminGroupIds: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/db.js', () => ({
  prisma: { groupAdmin: { findMany: vi.fn() } },
}))

import { listUsers } from '../services/authService.js'
import { prisma } from '../services/db.js'
import { registerAuthRoutes } from '../routes/auth.js'

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

beforeEach(() => vi.clearAllMocks())

describe('GET /auth/users', () => {
  it('attaches each user\'s adminGroupIds alongside the serialized fields', async () => {
    const { app, routes } = makeApp()
    registerAuthRoutes(app)
    const handler = routes['GET /auth/users'].at(-1) as (req: any, res: any) => Promise<void>

    vi.mocked(listUsers).mockResolvedValue([
      { id: 'u1', email: 'a@b.com', name: 'A', active: true, createdAt: new Date('2026-01-01'), roles: [] },
      { id: 'u2', email: 'c@d.com', name: 'C', active: true, createdAt: new Date('2026-01-02'), roles: [] },
    ] as any)
    vi.mocked(prisma.groupAdmin.findMany).mockResolvedValue([
      { userId: 'u1', groupId: 'g1@g.us' },
      { userId: 'u1', groupId: 'g2@g.us' },
    ] as any)

    const req = {} as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'u1', adminGroupIds: ['g1@g.us', 'g2@g.us'] }),
      expect.objectContaining({ id: 'u2', adminGroupIds: [] }),
    ])
  })
})
