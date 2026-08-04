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

vi.mock('../services/groupService.js', () => ({
  isGroupAdminOf: vi.fn(),
}))

import { verifyToken, getUserById } from '../services/authService.js'
import { isGroupAdminOf } from '../services/groupService.js'
import { requireGroupAdmin } from '../middleware/auth.js'

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

const mockRole = { id: 'role-1', name: 'Bom Dia Admin', slug: 'bom_dia_admin', createdAt: new Date() }
const mockUser = {
  id: 'u1', email: 'a@b.com', name: '', passwordHash: '', active: true, createdAt: new Date(),
  roles: [{ id: 'ur-1', userId: 'u1', roleId: 'role-1', role: mockRole }],
}
const superAdminUser = {
  ...mockUser,
  roles: [{ id: 'ur-2', userId: 'u1', roleId: 'role-2', role: { ...mockRole, id: 'role-2', slug: 'super_admin' } }],
}

beforeEach(() => vi.clearAllMocks())

describe('requireGroupAdmin', () => {
  it('returns 401 when not authenticated', async () => {
    const { req, res, next } = makeReqRes()
    await requireGroupAdmin(() => 'g1@g.us')(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('super_admin bypasses without checking isGroupAdminOf', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(superAdminUser as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => 'g1@g.us')(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(isGroupAdminOf).not.toHaveBeenCalled()
  })

  it('returns 400 when getGroupId resolves to null', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => null)(req, res, next)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(next).not.toHaveBeenCalled()
  })

  it('calls next() when the user administers the resolved group', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    vi.mocked(isGroupAdminOf).mockResolvedValue(true)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => 'g1@g.us')(req, res, next)
    expect(isGroupAdminOf).toHaveBeenCalledWith('u1', 'g1@g.us')
    expect(next).toHaveBeenCalled()
  })

  it('returns 403 when the user does not administer the resolved group', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    vi.mocked(isGroupAdminOf).mockResolvedValue(false)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => 'g1@g.us')(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('awaits an async getGroupId function', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    vi.mocked(isGroupAdminOf).mockResolvedValue(true)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(async () => 'g1@g.us')(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('returns 500 and does not hang or call next() when isGroupAdminOf rejects', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    vi.mocked(isGroupAdminOf).mockRejectedValue(new Error('db down'))
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => 'g1@g.us')(req, res, next)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(next).not.toHaveBeenCalled()
  })
})
