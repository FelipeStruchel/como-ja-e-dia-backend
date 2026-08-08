import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    role: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    userRole: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}))

import bcrypt from 'bcryptjs'
import { prisma } from '../services/db.js'
import {
  authenticateUser,
  getUserById,
  setUserActive,
  assignRole,
  removeRole,
  listRoles,
} from '../services/authService.js'

const mockRole = { id: 'role-1', name: 'Super Admin', slug: 'super_admin', createdAt: new Date() }
const mockUserRole = { id: 'ur-1', userId: 'user-1', roleId: 'role-1', role: mockRole }
const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test',
  passwordHash: 'hashed',
  active: true,
  createdAt: new Date(),
  roles: [mockUserRole],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('authenticateUser', () => {
  it('throws "Conta inativa" when user.active is false', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...mockUser, active: false } as any)
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never)
    await expect(authenticateUser({ email: 'test@example.com', password: 'pass' }))
      .rejects.toThrow('Conta inativa')
  })

  it('throws "Credenciais inválidas" when password is wrong', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never)
    await expect(authenticateUser({ email: 'test@example.com', password: 'wrong' }))
      .rejects.toThrow('Credenciais inválidas')
  })

  it('returns user and token with roles in JWT when credentials are valid', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never)
    const result = await authenticateUser({ email: 'test@example.com', password: 'pass' })
    expect(result.token).toBeTruthy()
    expect(result.user.id).toBe('user-1')
    const { default: jwt } = await import('jsonwebtoken')
    const payload = jwt.decode(result.token) as Record<string, unknown>
    expect(payload.roles).toEqual(['super_admin'])
  })
})

describe('getUserById', () => {
  it('fetches user with roles relation included', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    const user = await getUserById('user-1')
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      include: { roles: { include: { role: true } } },
    })
    expect(user).toEqual(mockUser)
  })
})

describe('setUserActive', () => {
  it('calls prisma.user.update with active flag', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({ ...mockUser, active: false } as any)
    await setUserActive('user-1', false)
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { active: false },
    })
  })

  it('returns null when user not found (P2025)', async () => {
    const err = Object.assign(new Error('not found'), { code: 'P2025' })
    vi.mocked(prisma.user.update).mockRejectedValue(err)
    const result = await setUserActive('missing', true)
    expect(result).toBeNull()
  })
})

describe('assignRole', () => {
  it('creates a UserRole record for the given slug', async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue(mockRole as any)
    vi.mocked(prisma.userRole.create).mockResolvedValue({} as any)
    await assignRole('user-1', 'super_admin')
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', roleId: 'role-1' },
    })
  })

  it('throws when role slug does not exist', async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue(null)
    await expect(assignRole('user-1', 'nonexistent')).rejects.toThrow('Role não encontrada')
  })
})

describe('removeRole', () => {
  it('deletes UserRole record for the given slug', async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue(mockRole as any)
    vi.mocked(prisma.userRole.deleteMany).mockResolvedValue({ count: 1 } as any)
    await removeRole('user-1', 'super_admin')
    expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', roleId: 'role-1' },
    })
  })

  it('does nothing when role slug does not exist', async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue(null)
    await removeRole('user-1', 'nonexistent')
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled()
  })
})

describe('listRoles', () => {
  it('returns all roles ordered by name, excluding the retired bom_dia_admin slug', async () => {
    const roles = [mockRole]
    vi.mocked(prisma.role.findMany).mockResolvedValue(roles as any)
    const result = await listRoles()
    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: { slug: { not: 'bom_dia_admin' } },
      orderBy: { name: 'asc' },
    })
    expect(result).toEqual(roles)
  })
})
