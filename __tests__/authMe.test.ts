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

import { verifyToken, getUserById } from '../services/authService.js'
import { getAdminGroupIds } from '../services/groupService.js'
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

describe('GET /auth/me', () => {
  it('includes adminGroupIds alongside the serialized user', async () => {
    const { app, routes } = makeApp()
    registerAuthRoutes(app)
    const handler = routes['GET /auth/me'].at(-1) as (req: any, res: any) => Promise<void>

    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue({
      id: 'u1', email: 'a@b.com', name: 'A', active: true, createdAt: new Date('2026-01-01'), roles: [],
    } as any)
    vi.mocked(getAdminGroupIds).mockResolvedValue(['g1@g.us', 'g2@g.us'])

    const req = { headers: { authorization: 'Bearer valid-token' } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)

    expect(getAdminGroupIds).toHaveBeenCalledWith('u1')
    expect(res.json).toHaveBeenCalledWith({
      user: { id: 'u1', email: 'a@b.com', name: 'A', active: true, createdAt: new Date('2026-01-01'), roles: [] },
      adminGroupIds: ['g1@g.us', 'g2@g.us'],
    })
  })
})
