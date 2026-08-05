import { prisma } from './db.js'

type GroupRow = {
  id: string
  pokemonEnabled: boolean
  triggersEnabled: boolean
  contextSyncEnabled: boolean
} | null

const CACHE_TTL_MS = 60_000
let cache = new Map<string, { row: GroupRow; fetchedAt: number }>()
let adminCache = new Map<string, { isAdmin: boolean; fetchedAt: number }>()

export function resetGroupCache(): void {
  cache = new Map()
  adminCache = new Map()
}

async function fetchGroup(groupId: string): Promise<GroupRow> {
  const cached = cache.get(groupId)
  const now = Date.now()
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.row
  const row = await prisma.group.findUnique({ where: { id: groupId } })
  cache.set(groupId, { row: row as GroupRow, fetchedAt: now })
  return row as GroupRow
}

export async function isGroupRegistered(groupId: string): Promise<boolean> {
  return (await fetchGroup(groupId)) !== null
}

export async function isPokemonEnabled(groupId: string): Promise<boolean> {
  const row = await fetchGroup(groupId)
  return !!row?.pokemonEnabled
}

export async function isTriggersEnabledForGroup(groupId: string): Promise<boolean> {
  const row = await fetchGroup(groupId)
  return !!row?.triggersEnabled
}

export async function isContextSyncEnabled(groupId: string): Promise<boolean> {
  const row = await fetchGroup(groupId)
  return !!row?.contextSyncEnabled
}

export async function isGroupAdminOf(userId: string, groupId: string): Promise<boolean> {
  const key = `${userId}:${groupId}`
  const cached = adminCache.get(key)
  const now = Date.now()
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.isAdmin
  const count = await prisma.groupAdmin.count({ where: { userId, groupId } })
  const isAdmin = count > 0
  adminCache.set(key, { isAdmin, fetchedAt: now })
  return isAdmin
}

export async function getAdminGroupIds(userId: string): Promise<string[]> {
  const rows = await prisma.groupAdmin.findMany({ where: { userId }, select: { groupId: true } })
  return rows.map((r) => r.groupId)
}

export async function getPokemonEnabledGroupIds(): Promise<string[]> {
  const rows = await prisma.group.findMany({ where: { pokemonEnabled: true }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function getConfessionsEnabledGroupIds(): Promise<string[]> {
  const rows = await prisma.group.findMany({ where: { confessionsEnabled: true }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function getScheduledGreetingsEnabledGroupIds(): Promise<string[]> {
  const rows = await prisma.group.findMany({ where: { scheduledGreetingsEnabled: true }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function getContextSyncEnabledGroupIds(): Promise<string[]> {
  const rows = await prisma.group.findMany({ where: { contextSyncEnabled: true }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function ensureGroupSeeded(id: string, name: string): Promise<void> {
  await prisma.group.upsert({
    where: { id },
    update: {},
    create: {
      id,
      name,
      pokemonEnabled: true,
      confessionsEnabled: true,
      scheduledGreetingsEnabled: true,
      triggersEnabled: true,
      contextSyncEnabled: true,
      eventsEnabled: true,
    },
  })
}
