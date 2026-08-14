import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    group: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    groupAdmin: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from '../services/db.js'
import {
  isGroupRegistered,
  isPokemonEnabled,
  isTriggersEnabledForGroup,
  getPokemonEnabledGroupIds,
  isContextSyncEnabled,
  isEventsEnabledForGroup,
  resetGroupCache,
  ensureGroupSeeded,
  isGroupAdminOf,
  getAdminGroupIds,
} from '../services/groupService.js'

beforeEach(() => {
  vi.clearAllMocks()
  resetGroupCache()
})

describe('groupService', () => {
  it('isGroupRegistered returns true when a Group row exists', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue({ id: 'g1@g.us' } as any)
    expect(await isGroupRegistered('g1@g.us')).toBe(true)
  })

  it('isGroupRegistered returns false and caches the miss for 60s', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue(null)
    expect(await isGroupRegistered('unknown@g.us')).toBe(false)
    expect(await isGroupRegistered('unknown@g.us')).toBe(false)
    expect(prisma.group.findUnique).toHaveBeenCalledTimes(1)
  })

  it('isPokemonEnabled reflects the pokemonEnabled flag', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue({ id: 'g1@g.us', pokemonEnabled: true } as any)
    expect(await isPokemonEnabled('g1@g.us')).toBe(true)
  })

  it('isPokemonEnabled is false for an unregistered group', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue(null)
    expect(await isPokemonEnabled('unknown@g.us')).toBe(false)
  })

  it('isTriggersEnabledForGroup reflects the triggersEnabled flag', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue({ id: 'g1@g.us', triggersEnabled: false } as any)
    expect(await isTriggersEnabledForGroup('g1@g.us')).toBe(false)
  })

  it('getPokemonEnabledGroupIds maps rows to ids', async () => {
    vi.mocked(prisma.group.findMany).mockResolvedValue([{ id: 'a@g.us' }, { id: 'b@g.us' }] as any)
    expect(await getPokemonEnabledGroupIds()).toEqual(['a@g.us', 'b@g.us'])
    expect(prisma.group.findMany).toHaveBeenCalledWith({
      where: { pokemonEnabled: true },
      select: { id: true },
    })
  })

  it('isContextSyncEnabled reflects the contextSyncEnabled flag', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue({ id: 'g1@g.us', contextSyncEnabled: true } as any)
    expect(await isContextSyncEnabled('g1@g.us')).toBe(true)
  })

  it('isEventsEnabledForGroup reflects the eventsEnabled flag', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue({ id: 'g1@g.us', eventsEnabled: false } as any)
    expect(await isEventsEnabledForGroup('g1@g.us')).toBe(false)
  })

  it('ensureGroupSeeded upserts with the given id and name, all toggles left untouched on conflict', async () => {
    vi.mocked(prisma.group.upsert).mockResolvedValue({} as any)
    await ensureGroupSeeded('g1@g.us', 'Grupo principal')
    expect(prisma.group.upsert).toHaveBeenCalledWith({
      where: { id: 'g1@g.us' },
      update: {},
      create: {
        id: 'g1@g.us',
        name: 'Grupo principal',
        pokemonEnabled: true,
        confessionsEnabled: true,
        scheduledGreetingsEnabled: true,
        triggersEnabled: true,
        contextSyncEnabled: true,
        eventsEnabled: true,
      },
    })
  })

  it('isGroupAdminOf returns true when a GroupAdmin row exists', async () => {
    vi.mocked(prisma.groupAdmin.count).mockResolvedValue(1)
    expect(await isGroupAdminOf('u1', 'g1@g.us')).toBe(true)
  })

  it('isGroupAdminOf returns false and caches the miss for 60s', async () => {
    vi.mocked(prisma.groupAdmin.count).mockResolvedValue(0)
    expect(await isGroupAdminOf('u1', 'g1@g.us')).toBe(false)
    expect(await isGroupAdminOf('u1', 'g1@g.us')).toBe(false)
    expect(prisma.groupAdmin.count).toHaveBeenCalledTimes(1)
  })

  it('getAdminGroupIds maps rows to groupIds', async () => {
    vi.mocked(prisma.groupAdmin.findMany).mockResolvedValue([
      { groupId: 'a@g.us' },
      { groupId: 'b@g.us' },
    ] as any)
    expect(await getAdminGroupIds('u1')).toEqual(['a@g.us', 'b@g.us'])
    expect(prisma.groupAdmin.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { groupId: true },
    })
  })
})
