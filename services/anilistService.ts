import { prisma } from './db.js'

const ANILIST_API = 'https://graphql.anilist.co'

export interface AnilistCharacterData {
  id: number
  name: string
  gender: 'MALE' | 'FEMALE' | 'UNKNOWN'
  series: string
  sourceImageUrl: string
  favourites: number
}

let _rateLimitRemaining = 90
let _rateLimitResetMs = 0

const MAX_429_RETRIES = 3

async function request(query: string, variables: Record<string, unknown>): Promise<unknown> {
  if (_rateLimitRemaining <= 5 && Date.now() < _rateLimitResetMs) {
    await new Promise((r) => setTimeout(r, _rateLimitResetMs - Date.now() + 200))
  }

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(ANILIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    })

    _rateLimitRemaining = parseInt(res.headers.get('X-RateLimit-Remaining') ?? '90', 10)
    const resetSec = parseInt(res.headers.get('X-RateLimit-Reset') ?? '0', 10)
    _rateLimitResetMs = resetSec * 1000

    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const retryMs = parseInt(res.headers.get('Retry-After') ?? '60', 10) * 1000
      await new Promise((r) => setTimeout(r, retryMs))
      continue
    }

    return res.json()
  }

  throw new Error('AniList: max 429 retries exceeded')
}

function mapGender(raw: string | null | undefined): 'MALE' | 'FEMALE' | 'UNKNOWN' {
  if (raw === 'Male') return 'MALE'
  if (raw === 'Female') return 'FEMALE'
  return 'UNKNOWN'
}

const PAGE_QUERY = `
query ($page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { total lastPage }
    characters(sort: ID) {
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

export async function fetchRandomPage(
  gender?: 'Male' | 'Female',
  pageOverride?: number,
): Promise<{ characters: AnilistCharacterData[]; totalCount: number }> {
  const meta = await prisma.characterSourceMeta.findUnique({
    where: { source_gender: { source: 'ANILIST', gender: 'ALL' } },
  })

  const totalCount = meta?.totalCount || 1000
  const maxPage = Math.max(1, Math.ceil(totalCount / 50))
  const page = pageOverride ?? Math.floor(Math.random() * maxPage) + 1

  const data = (await request(PAGE_QUERY, { page })) as any
  const rawChars: any[] = data?.data?.Page?.characters ?? []
  const actualTotal: number = data?.data?.Page?.pageInfo?.total ?? totalCount

  const characters: AnilistCharacterData[] = rawChars
    .filter((c) => c?.id && c?.name?.full && c?.image?.large)
    .map((c) => ({
      id: c.id as number,
      name: c.name.full as string,
      gender: mapGender(c.gender),
      series: (c.media?.nodes?.[0]?.title?.romaji as string | undefined) ?? 'Desconhecido',
      sourceImageUrl: c.image.large as string,
      favourites: (c.favourites as number) ?? 0,
    }))

  return { characters, totalCount: actualTotal }
}

const META_QUERY = `
{
  Page(page: 1, perPage: 1) {
    pageInfo { total }
    characters(sort: ID) { id }
  }
}`

export async function fetchSourceMeta(): Promise<
  Array<{ gender: 'ALL' | 'MALE' | 'FEMALE'; totalCount: number }>
> {
  const data = (await request(META_QUERY, {})) as any
  const totalCount: number = data?.data?.Page?.pageInfo?.total ?? 0
  return [
    { gender: 'ALL', totalCount },
    { gender: 'MALE', totalCount },
    { gender: 'FEMALE', totalCount },
  ]
}
