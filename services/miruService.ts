import { prisma } from './db.js'
import { getRedis } from './redis.js'
import { enqueueSendMessage } from './sendQueue.js'

// ── Types ──────────────────────────────────────────────────────────────────

type CharacterCategory = 'ANIME' | 'SERIES' | 'MOVIE' | 'STREAMER'
type CharacterRarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY'

// ── Rarity & coin formula ──────────────────────────────────────────────────

export function rarityFromScore(
  score: number,
  override?: CharacterRarity
): CharacterRarity {
  if (override) return override
  if (score >= 90) return 'LEGENDARY'
  if (score >= 70) return 'EPIC'
  if (score >= 40) return 'RARE'
  return 'COMMON'
}

const RARITY_MULTIPLIERS: Record<CharacterRarity, number> = {
  COMMON: 1,
  RARE: 2,
  EPIC: 4,
  LEGENDARY: 8,
}

export function coinValueFromScore(score: number, rarity: CharacterRarity): number {
  return Math.floor(score * RARITY_MULTIPLIERS[rarity])
}

// ── Character CRUD ─────────────────────────────────────────────────────────

export async function createCharacter(data: {
  name: string
  series: string
  category: CharacterCategory
  imageUrl: string
  popularityScore: number
  rarityOverride?: CharacterRarity
  active?: boolean
}) {
  const rarity = rarityFromScore(data.popularityScore, data.rarityOverride)
  const coinValue = coinValueFromScore(data.popularityScore, rarity)
  return prisma.character.create({
    data: {
      name: data.name,
      series: data.series,
      category: data.category,
      imageUrl: data.imageUrl,
      popularityScore: data.popularityScore,
      rarity,
      coinValue,
      active: data.active ?? true,
    },
  })
}

export async function updateCharacter(
  id: string,
  data: {
    name?: string
    series?: string
    category?: CharacterCategory
    imageUrl?: string
    popularityScore?: number
    rarityOverride?: CharacterRarity
    active?: boolean
  }
) {
  const existing = await prisma.character.findUniqueOrThrow({ where: { id } })
  const score = data.popularityScore ?? existing.popularityScore
  const rarity = rarityFromScore(score, data.rarityOverride)
  const coinValue = coinValueFromScore(score, rarity)
  const { rarityOverride: _, ...rest } = data
  return prisma.character.update({
    where: { id },
    data: { ...rest, popularityScore: score, rarity, coinValue },
  })
}

export async function listCharacters(filters: {
  category?: CharacterCategory
  rarity?: CharacterRarity
  search?: string
  activeOnly?: boolean
  page?: number
  pageSize?: number
}) {
  const where: Record<string, unknown> = {}
  if (filters.activeOnly) where.active = true
  if (filters.category) where.category = filters.category
  if (filters.rarity) where.rarity = filters.rarity
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { series: { contains: filters.search, mode: 'insensitive' } },
    ]
  }

  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 20

  const [items, total] = await Promise.all([
    prisma.character.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.character.count({ where }),
  ])
  return { items, total }
}

export async function softDeleteCharacter(id: string): Promise<void> {
  await prisma.character.update({ where: { id }, data: { active: false } })
}

// ── Roll allowance ─────────────────────────────────────────────────────────

export const ROLL_ALLOWANCE = 10
const ROLL_WINDOW_MS = 3_600_000

export interface RollState {
  used: number
  windowStart: number
}

export async function getRollState(gameGroupId: string, jid: string): Promise<RollState> {
  const redis = getRedis()
  const raw = await redis.get(`miru:rolls:${gameGroupId}:${jid}`)
  if (!raw) return { used: 0, windowStart: Date.now() }
  return JSON.parse(raw) as RollState
}

export async function consumeRolls(
  gameGroupId: string,
  jid: string,
  count: number
): Promise<{ allowed: number; remaining: number; resetsInSec: number }> {
  const redis = getRedis()
  const key = `miru:rolls:${gameGroupId}:${jid}`
  const now = Date.now()
  const raw = await redis.get(key)

  const state: RollState = raw
    ? (JSON.parse(raw) as RollState)
    : { used: 0, windowStart: now }

  const remaining = ROLL_ALLOWANCE - state.used
  const allowed = Math.min(count, remaining)

  if (allowed <= 0) {
    const resetsInSec = Math.max(
      0,
      Math.ceil((state.windowStart + ROLL_WINDOW_MS - now) / 1000)
    )
    return { allowed: 0, remaining: 0, resetsInSec }
  }

  const newState: RollState = {
    used: state.used + allowed,
    windowStart: state.used === 0 ? now : state.windowStart,
  }

  const ttlSec = Math.max(
    1,
    Math.ceil((newState.windowStart + ROLL_WINDOW_MS - now) / 1000)
  )
  await redis.set(key, JSON.stringify(newState), 'EX', ttlSec)

  const newRemaining = ROLL_ALLOWANCE - newState.used
  const resetsInSec = Math.max(
    0,
    Math.ceil((newState.windowStart + ROLL_WINDOW_MS - now) / 1000)
  )
  return { allowed, remaining: newRemaining, resetsInSec }
}

// ── Drop pool & weighted selection ─────────────────────────────────────────

const RARITY_WEIGHTS: Record<CharacterRarity, number> = {
  LEGENDARY: 5,
  EPIC: 15,
  RARE: 35,
  COMMON: 45,
}

type PoolCharacter = {
  id: string
  rarity: CharacterRarity
  name: string
  series: string
  imageUrl: string
  coinValue: number
}

export function selectByRarity(pool: PoolCharacter[]): string {
  const entries = Object.entries(RARITY_WEIGHTS) as Array<[CharacterRarity, number]>
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let rand = Math.random() * total
  let targetRarity: CharacterRarity = 'COMMON'

  for (const [rarity, weight] of entries) {
    rand -= weight
    if (rand <= 0) {
      targetRarity = rarity
      break
    }
  }

  const bucket = pool.filter((c) => c.rarity === targetRarity)
  const candidates = bucket.length > 0 ? bucket : pool
  return candidates[Math.floor(Math.random() * candidates.length)].id
}

export async function getDropPool(gameGroupId: string): Promise<PoolCharacter[]> {
  await prisma.characterOwnership.deleteMany({
    where: {
      groupId: gameGroupId,
      ownerJid: null,
      capturedAt: { lt: new Date(Date.now() - 30_000) },
    },
  })

  const owned = await prisma.characterOwnership.findMany({
    where: { groupId: gameGroupId },
    select: { characterId: true },
  })
  const ownedIds = new Set(owned.map((o) => o.characterId))

  const chars = await prisma.character.findMany({
    where: { active: true },
    select: { id: true, rarity: true, name: true, series: true, imageUrl: true, coinValue: true },
  })

  return chars.filter((c) => !ownedIds.has(c.id)) as PoolCharacter[]
}
