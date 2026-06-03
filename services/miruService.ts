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
export const ROLL_WINDOW_MS = 3_600_000

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
    where: { groupId: gameGroupId, source: 'MANUAL' },
    select: { characterRef: true },
  })
  const ownedIds = new Set(owned.map((o) => o.characterRef))

  const chars = await prisma.character.findMany({
    where: { active: true },
    select: { id: true, rarity: true, name: true, series: true, imageUrl: true, coinValue: true },
  })

  return chars.filter((c) => !ownedIds.has(c.id)) as PoolCharacter[]
}

// ── Drop execution ─────────────────────────────────────────────────────────

const MIRU_DROP_TTL_SEC = 15

const RARITY_EMOJI: Record<CharacterRarity, string> = {
  COMMON: '⚪',
  RARE: '🔵',
  EPIC: '🟣',
  LEGENDARY: '🟡',
}

export async function executeMiruDrop(
  gameGroupId: string,
  rolledBy: string,
  count: number
): Promise<{ dropped: number }> {
  const redis = getRedis()
  const pool = await getDropPool(gameGroupId)

  if (pool.length === 0) {
    await enqueueSendMessage({
      groupId: gameGroupId,
      type: 'text',
      content: 'Todos os personagens já foram capturados neste grupo! Novos personagens em breve.',
    })
    return { dropped: 0 }
  }

  const selectedInBatch = new Set<string>()
  const toDrop = Math.min(count, pool.length)

  for (let i = 0; i < toDrop; i++) {
    const available = pool.filter((c) => !selectedInBatch.has(c.id))
    if (available.length === 0) break

    const characterId = selectByRarity(available)
    const character = available.find((c) => c.id === characterId)!
    selectedInBatch.add(characterId)

    const ownership = await prisma.characterOwnership.create({
      data: { characterRef: characterId, source: 'MANUAL', groupId: gameGroupId, ownerJid: null },
    })

    const expiresAt = Date.now() + MIRU_DROP_TTL_SEC * 1000
    await redis.set(
      `miru:drop:active:${gameGroupId}:${ownership.id}`,
      JSON.stringify({ characterRef: characterId, source: 'MANUAL', rolledBy, expiresAt }),
      'EX',
      MIRU_DROP_TTL_SEC,
    )

    const caption = [
      `✨ *${character.name}*`,
      `📺 _${character.series}_`,
      `${RARITY_EMOJI[character.rarity]} *${character.rarity}* • 🪙 ${character.coinValue} coins`,
      ``,
      `_Reaja para capturar!_`,
    ].join('\n')

    await enqueueSendMessage(
      {
        type: 'miru_drop',
        groupId: gameGroupId,
        content: character.imageUrl,
        caption,
        dropId: ownership.id,
      },
      { delay: i * 3_000, idempotencyKey: `miru:${ownership.id}` },
    )
  }

  return { dropped: toDrop }
}

// ── Album & leaderboard ────────────────────────────────────────────────────

export async function getAlbum(gameGroupId: string, ownerJid: string) {
  const ownerships = await prisma.characterOwnership.findMany({
    where: { groupId: gameGroupId, ownerJid },
    orderBy: { capturedAt: 'desc' },
  })

  const results: Array<{ name: string; series: string; rarity: string; coinValue: number }> = []

  for (const o of ownerships) {
    if (o.source === 'MANUAL') {
      const c = await prisma.character.findUnique({
        where: { id: o.characterRef },
        select: { name: true, series: true, rarity: true, coinValue: true },
      })
      if (c) results.push(c)
    } else {
      const c = await prisma.anilistCharacter.findUnique({
        where: { externalId: parseInt(o.characterRef, 10) },
        select: { name: true, series: true, rarity: true, coinValue: true },
      })
      if (c) results.push(c)
    }
  }

  return results
}

export async function getTopCollectors(
  gameGroupId: string,
  limit = 10
): Promise<Array<{ ownerJid: string; count: number; totalCoins: number }>> {
  const raw = await prisma.characterOwnership.groupBy({
    by: ['ownerJid'],
    where: { groupId: gameGroupId, ownerJid: { not: null } },
    _count: { characterRef: true },
    orderBy: [{ _count: { characterRef: 'desc' } }],
    take: limit,
  })

  const all = await prisma.characterOwnership.findMany({
    where: { groupId: gameGroupId, ownerJid: { not: null } },
    select: { ownerJid: true, characterRef: true, source: true },
  })

  const manualRefs = all.filter((o) => o.source === 'MANUAL').map((o) => o.characterRef)
  const anilistIds = all
    .filter((o) => o.source === 'ANILIST')
    .map((o) => parseInt(o.characterRef, 10))
    .filter((id) => !Number.isNaN(id))

  const [manualChars, anilistChars] = await Promise.all([
    manualRefs.length > 0
      ? prisma.character.findMany({ where: { id: { in: manualRefs } }, select: { id: true, coinValue: true } })
      : Promise.resolve([]),
    anilistIds.length > 0
      ? prisma.anilistCharacter.findMany({ where: { externalId: { in: anilistIds } }, select: { externalId: true, coinValue: true } })
      : Promise.resolve([]),
  ])

  const manualCoinMap = new Map(manualChars.map((c) => [c.id, c.coinValue]))
  const anilistCoinMap = new Map(anilistChars.map((c) => [c.externalId, c.coinValue]))

  const coinMap = new Map<string, number>()
  for (const o of all) {
    if (!o.ownerJid) continue
    let coinValue = 0
    if (o.source === 'MANUAL') {
      coinValue = manualCoinMap.get(o.characterRef) ?? 0
    } else {
      const id = parseInt(o.characterRef, 10)
      coinValue = Number.isNaN(id) ? 0 : (anilistCoinMap.get(id) ?? 0)
    }
    coinMap.set(o.ownerJid, (coinMap.get(o.ownerJid) ?? 0) + coinValue)
  }

  const result = raw.map((r) => ({
    ownerJid: r.ownerJid!,
    count: r._count.characterRef,
    totalCoins: coinMap.get(r.ownerJid!) ?? 0,
  }))

  result.sort((a, b) => b.count - a.count || b.totalCoins - a.totalCoins)
  return result.slice(0, limit)
}

// ── Linked group helpers ───────────────────────────────────────────────────

export async function getLinkedGroup(mainGroupId: string) {
  return prisma.linkedGroup.findUnique({ where: { mainGroupId } })
}

export async function getLinkedGroupByGameId(gameGroupId: string) {
  return prisma.linkedGroup.findUnique({ where: { gameGroupId } })
}

export async function createLinkedGroup(mainGroupId: string, gameGroupId: string) {
  return prisma.linkedGroup.create({ data: { mainGroupId, gameGroupId } })
}

export async function resolveGameGroupId(groupId: string): Promise<string | null> {
  const asMain = await prisma.linkedGroup.findUnique({ where: { mainGroupId: groupId } })
  if (asMain) return asMain.gameGroupId
  const asGame = await prisma.linkedGroup.findUnique({ where: { gameGroupId: groupId } })
  if (asGame) return asGame.gameGroupId
  return null
}

// ── Capture ────────────────────────────────────────────────────────────────

export async function handleMiruCapture(
  gameGroupId: string,
  ownershipId: string,
  capturedBy: string,
  rollMessageId?: string
): Promise<void> {
  const result = await prisma.characterOwnership.updateMany({
    where: { id: ownershipId, ownerJid: null },
    data: { ownerJid: capturedBy, capturedAt: new Date(), rollMessageId },
  })

  if (result.count === 0) {
    throw new Error('already_captured')
  }

  const ownership = await prisma.characterOwnership.findUnique({
    where: { id: ownershipId },
  })
  if (!ownership) return

  type CharData = { name: string; rarity: string; series: string; coinValue: number }
  let character: CharData | null = null

  if (ownership.source === 'MANUAL') {
    character = await prisma.character.findUnique({
      where: { id: ownership.characterRef },
      select: { name: true, rarity: true, series: true, coinValue: true },
    })
  } else {
    const externalId = parseInt(ownership.characterRef, 10)
    if (Number.isNaN(externalId)) return
    const ac = await prisma.anilistCharacter.findUnique({
      where: { externalId },
      select: { name: true, rarity: true, series: true, coinValue: true },
    })
    character = ac
  }
  if (!character) return
  const number = capturedBy.split('@')[0]

  await enqueueSendMessage({
    groupId: gameGroupId,
    type: 'text',
    content: `🎉 @${number} capturou *${character.name}*! ${RARITY_EMOJI[character.rarity as CharacterRarity]} _${character.series}_ • 🪙 ${character.coinValue} coins`,
    mentions: [capturedBy],
  })
}
