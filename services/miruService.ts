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
