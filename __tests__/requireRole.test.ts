import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

vi.mock('../services/db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}))

vi.mock('../services/authService.js', () => ({
  verifyToken: vi.fn(),
  getUserById: vi.fn(),
}))

import { verifyToken, getUserById } from '../services/authService.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

function makeReqRes(token?: string) {
  const req = {
    headers: { authorization: token ? `Bearer ${token}` : '' },
  } as unknown as Request
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response
  const next: NextFunction = vi.fn()
  return { req, res, next }
}

const mockRole = { id: 'role-1', name: 'Super Admin', slug: 'super_admin', createdAt: new Date() }
const mockUserRole = { id: 'ur-1', userId: 'u1', roleId: 'role-1', role: mockRole }
const mockUser = {
  id: 'u1',
  email: 'a@b.com',
  name: '',
  passwordHash: '',
  active: true,
  createdAt: new Date(),
  roles: [mockUserRole],
}

beforeEach(() => vi.clearAllMocks())

describe('requireRole', () => {
  it('returns 403 when user has none of the required roles', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue({
      ...mockUser,
      roles: [{ ...mockUserRole, role: { ...mockRole, slug: 'bom_dia_admin' } }],
    } as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireAuth(req, res, next)

    const next2 = vi.fn()
    await requireRole('super_admin')(req, res, next2)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Sem permissão' })
    expect(next2).not.toHaveBeenCalled()
  })

  it('calls next() when user has the required role', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireAuth(req, res, next)

    const next2 = vi.fn()
    await requireRole('super_admin')(req, res, next2)
    expect(next2).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalledWith(403)
  })

  it('calls next() when user has super_admin regardless of required role', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireAuth(req, res, next)

    const next2 = vi.fn()
    await requireRole('bom_dia_admin')(req, res, next2)
    expect(next2).toHaveBeenCalled()
  })
})
