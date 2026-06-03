import { prisma } from './db.js'
import { Prisma } from '@prisma/client'
import { getRedis } from './redis.js'
import { fetchRandomPage, type AnilistCharacterData } from './anilistService.js'
import {
  imageExistsLocally,
  downloadAndSaveImage,
  localImagePath,
} from './characterImageService.js'
import { rarityFromScore, coinValueFromScore, ROLL_ALLOWANCE } from './miruService.js'
import { enqueueSendMessage } from './sendQueue.js'
import { log } from './logger.js'

export type RollFilter = 'all' | 'anime' | 'anime_female' | 'anime_male'

export interface PreRolledChar {
  characterRef: string
  source: 'ANILIST' | 'MANUAL'
}

function prerollKey(gameGroupId: string, jid: string, filter: RollFilter): string {
  return `miru:preroll:${gameGroupId}:${jid}:${filter}`
}

function filterToGender(filter: RollFilter): 'Male' | 'Female' | undefined {
  if (filter === 'anime_female') return 'Female'
  if (filter === 'anime_male') return 'Male'
  return undefined
}

function normalizeFavourites(favourites: number): number {
  return Math.min(100, Math.round((favourites / 100_000) * 100))
}

async function upsertAnilistChars(chars: AnilistCharacterData[]): Promise<void> {
  for (const c of chars) {
    const popularityScore = normalizeFavourites(c.favourites)
    const rarity = rarityFromScore(popularityScore)
    const coinValue = coinValueFromScore(popularityScore, rarity)
    const exists = await imageExistsLocally(c.id)
    const imageUrl = exists ? localImagePath(c.id) : c.sourceImageUrl

    await prisma.anilistCharacter.upsert({
      where: { externalId: c.id },
      create: {
        externalId: c.id,
        name: c.name,
        gender: c.gender,
        series: c.series,
        imageUrl,
        sourceImageUrl: c.sourceImageUrl,
        popularityScore,
        rarity,
        coinValue,
      },
      update: {
        name: c.name,
        gender: c.gender,
        series: c.series,
        sourceImageUrl: c.sourceImageUrl,
        popularityScore,
        rarity,
        coinValue,
      },
    })
  }
}

function downloadImagesAsync(chars: AnilistCharacterData[]): void {
  Promise.all(
    chars.map(async (c) => {
      try {
        if (!(await imageExistsLocally(c.id))) {
          await downloadAndSaveImage(c.id, c.sourceImageUrl)
          await prisma.anilistCharacter.update({
            where: { externalId: c.id },
            data: { imageUrl: localImagePath(c.id) },
          })
        }
      } catch (err) {
        log(`Image download failed for AniList ${c.id}: ${(err as Error).message}`, 'warn')
      }
    }),
  ).catch(() => {})
}

async function buildPool(gameGroupId: string, filter: RollFilter): Promise<PreRolledChar[]> {
  const gender = filterToGender(filter)

  // Manual character filter: all filters except 'all' restrict to ANIME category
  const manualWhere: {
    active: boolean
    category?: 'ANIME' | 'SERIES' | 'MOVIE' | 'STREAMER'
    gender?: 'UNKNOWN' | 'MALE' | 'FEMALE'
  } = { active: true }
  if (filter !== 'all') {
    manualWhere.category = 'ANIME'
    if (filter === 'anime_female') manualWhere.gender = 'FEMALE'
    if (filter === 'anime_male') manualWhere.gender = 'MALE'
  }

  // AniList meta gender for totalCount weighting
  const metaGender = gender === 'Female' ? 'FEMALE' : gender === 'Male' ? 'MALE' : 'ALL'
  const [anilistMeta, manualCount] = await Promise.all([
    prisma.characterSourceMeta.findUnique({
      where: { source_gender: { source: 'ANILIST', gender: metaGender } },
    }),
    prisma.character.count({ where: manualWhere }),
  ])

  const anilistTotal = anilistMeta?.totalCount ?? 1000
  const total = manualCount + anilistTotal
  if (total === 0) return []

  // Fetch AniList page + manual IDs in parallel
  const [{ characters: anilistChars }, manualIds] = await Promise.all([
    fetchRandomPage(gender),
    manualCount > 0
      ? prisma.character
          .findMany({ where: manualWhere, select: { id: true }, orderBy: { id: 'asc' } })
          .then((rows) => rows.map((r) => r.id))
      : Promise.resolve([] as string[]),
  ])

  // Captured refs for this group (avoid re-dropping already-owned chars)
  const capturedRows = await prisma.characterOwnership.findMany({
    where: { groupId: gameGroupId, ownerJid: { not: null } },
    select: { characterRef: true, source: true },
  })
  const capturedRefs = new Set(capturedRows.map((o) => `${o.source}:${o.characterRef}`))
  const capturedAnilist = new Set(
    capturedRows.filter((o) => o.source === 'ANILIST').map((o) => o.characterRef),
  )
  const availableAnilist = anilistChars.filter((c) => !capturedAnilist.has(String(c.id)))

  const pool: PreRolledChar[] = []
  const seen = new Set<string>()

  for (let attempt = 0; pool.length < ROLL_ALLOWANCE && attempt < ROLL_ALLOWANCE * 4; attempt++) {
    const n = Math.floor(Math.random() * total)
    if (n < manualCount && manualIds.length > 0) {
      const ref = manualIds[n % manualIds.length]
      const key = `MANUAL:${ref}`
      if (!seen.has(key) && !capturedRefs.has(key)) {
        pool.push({ characterRef: ref, source: 'MANUAL' })
        seen.add(key)
      }
    } else if (availableAnilist.length > 0) {
      const char = availableAnilist[(n - manualCount) % availableAnilist.length]
      const key = `ANILIST:${char.id}`
      if (!seen.has(key)) {
        pool.push({ characterRef: String(char.id), source: 'ANILIST' })
        seen.add(key)
      }
    }
  }

  const anilistInPool = anilistChars.filter((c) => seen.has(`ANILIST:${c.id}`))
  await upsertAnilistChars(anilistInPool)
  downloadImagesAsync(anilistInPool)
  return pool
}

export async function drawRolls(
  gameGroupId: string,
  jid: string,
  filter: RollFilter,
  count: number,
  windowTtlSec: number,
): Promise<PreRolledChar[]> {
  const redis = getRedis()
  const key = prerollKey(gameGroupId, jid, filter)

  const exists = await redis.exists(key)
  if (!exists) {
    const pool = await buildPool(gameGroupId, filter)
    if (pool.length === 0) return []
    const args: string[] = []
    for (const c of pool) args.push(JSON.stringify(c))
    await redis.rpush(key, ...args)
    await redis.expire(key, windowTtlSec)
  }

  const drawn: PreRolledChar[] = []
  for (let i = 0; i < count; i++) {
    const item = await redis.lpop(key)
    if (item === null) break
    drawn.push(JSON.parse(item) as PreRolledChar)
  }

  return drawn
}

const MIRU_DROP_TTL_SEC = 15

const RARITY_EMOJI: Record<string, string> = {
  COMMON: '⚪', RARE: '🔵', EPIC: '🟣', LEGENDARY: '🟡',
}

export async function executeRollDrops(
  gameGroupId: string,
  rolledBy: string,
  chars: PreRolledChar[],
): Promise<{ dropped: number }> {
  const redis = getRedis()
  let dropped = 0

  for (let i = 0; i < chars.length; i++) {
    const { characterRef, source } = chars[i]

    type CharInfo = { name: string; series: string; rarity: string; coinValue: number; imageUrl: string }
    let charInfo: CharInfo | null = null

    if (source === 'MANUAL') {
      const c = await prisma.character.findUnique({
        where: { id: characterRef },
        select: { name: true, series: true, rarity: true, coinValue: true, imageUrl: true },
      })
      charInfo = c
    } else {
      const externalId = parseInt(characterRef, 10)
      if (Number.isNaN(externalId)) continue
      const c = await prisma.anilistCharacter.findUnique({
        where: { externalId },
        select: { name: true, series: true, rarity: true, coinValue: true, imageUrl: true },
      })
      charInfo = c
    }

    if (!charInfo) continue

    let ownership
    try {
      ownership = await prisma.characterOwnership.create({
        data: { characterRef, source, groupId: gameGroupId, ownerJid: null },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        continue
      }
      throw err
    }

    const expiresAt = Date.now() + MIRU_DROP_TTL_SEC * 1000
    try {
      await redis.set(
        `miru:drop:active:${gameGroupId}:${ownership.id}`,
        JSON.stringify({ characterRef, source, rolledBy, expiresAt }),
        'EX',
        MIRU_DROP_TTL_SEC,
      )
    } catch (redisErr) {
      await prisma.characterOwnership.delete({ where: { id: ownership.id } }).catch(() => {})
      log(`Redis SET failed, ownership rolled back: ${(redisErr as Error).message}`, 'error')
      continue
    }

    const caption = [
      `✨ *${charInfo.name}*`,
      `📺 _${charInfo.series}_`,
      `${RARITY_EMOJI[charInfo.rarity] ?? '⚪'} *${charInfo.rarity}* • 🪙 ${charInfo.coinValue} coins`,
      ``,
      `_Reaja para capturar!_`,
    ].join('\n')

    await enqueueSendMessage(
      {
        type: 'miru_drop',
        groupId: gameGroupId,
        content: charInfo.imageUrl,
        caption,
        dropId: ownership.id,
      },
      { delay: i * 3_000, idempotencyKey: `miru:${ownership.id}` },
    )

    dropped++
  }

  return { dropped }
}
