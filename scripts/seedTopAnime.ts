import 'dotenv/config'
import { prisma } from '../services/db.js'
import {
  imageExistsLocally,
  downloadAndSaveImage,
  localImagePath,
} from '../services/characterImageService.js'
import { rarityFromScore, coinValueFromScore } from '../services/miruService.js'

const ANILIST_API = 'https://graphql.anilist.co'
const SEED_TOTAL = 1000
const PER_PAGE = 50
const DELAY_BETWEEN_REQUESTS_MS = 800

const SEED_QUERY = `
query ($page: Int) {
  Page(page: $page, perPage: ${PER_PAGE}) {
    characters(sort: FAVOURITES_DESC) {
      id
      name { full }
      gender
      image { large }
      favourites
      media(sort: POPULARITY_DESC, perPage: 1, type: ANIME) {
        nodes { title { romaji } }
      }
    }
  }
}`

function mapGender(raw: string | null | undefined): 'UNKNOWN' | 'MALE' | 'FEMALE' {
  if (raw === 'Male') return 'MALE'
  if (raw === 'Female') return 'FEMALE'
  return 'UNKNOWN'
}

function normalizeFavourites(f: number): number {
  return Math.min(100, Math.round((f / 100_000) * 100))
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  console.log(`Seeding top ${SEED_TOTAL} anime characters from AniList...`)
  const pages = Math.ceil(SEED_TOTAL / PER_PAGE)
  let processed = 0
  let skipped = 0

  for (let page = 1; page <= pages; page++) {
    const res = await fetch(ANILIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: SEED_QUERY, variables: { page } }),
    })

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10)
      console.log(`  Rate limited. Waiting ${retryAfter}s...`)
      await sleep(retryAfter * 1000)
      page--
      continue
    }

    const data = (await res.json()) as any
    const chars: any[] = data?.data?.Page?.characters ?? []

    for (const c of chars) {
      if (!c?.id || !c?.name?.full || !c?.image?.large) { skipped++; continue }

      const popularityScore = normalizeFavourites(c.favourites ?? 0)
      const rarity = rarityFromScore(popularityScore)
      const coinValue = coinValueFromScore(popularityScore, rarity)
      const exists = await imageExistsLocally(c.id)

      await prisma.anilistCharacter.upsert({
        where: { externalId: c.id },
        create: {
          externalId: c.id,
          name: c.name.full,
          gender: mapGender(c.gender),
          series: c.media?.nodes?.[0]?.title?.romaji ?? 'Desconhecido',
          imageUrl: exists ? localImagePath(c.id) : c.image.large,
          sourceImageUrl: c.image.large,
          popularityScore,
          rarity,
          coinValue,
        },
        update: {
          name: c.name.full,
          gender: mapGender(c.gender),
          series: c.media?.nodes?.[0]?.title?.romaji ?? 'Desconhecido',
          sourceImageUrl: c.image.large,
          popularityScore,
          rarity,
          coinValue,
        },
      })

      if (!exists) {
        try {
          await downloadAndSaveImage(c.id, c.image.large)
          await prisma.anilistCharacter.update({
            where: { externalId: c.id },
            data: { imageUrl: localImagePath(c.id) },
          })
        } catch {}
      }

      processed++
    }

    console.log(`  Page ${page}/${pages} — ${processed} processed, ${skipped} skipped`)
    if (page < pages) await sleep(DELAY_BETWEEN_REQUESTS_MS)
  }

  console.log(`\nSeed complete: ${processed} characters upserted.`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
