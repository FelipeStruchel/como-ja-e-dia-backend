import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/comojaedia',
})
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

const TEST_GROUP = 'e2e-test-group@g.us'
const TEST_USER = 'e2e-test-user@s.whatsapp.net'
const TEST_CHAR_REF = `e2e-char-${Date.now()}`

let createdOwnershipId: string | null = null
let createdCharacterId: string | null = null

beforeAll(async () => {
  await prisma.character.deleteMany({ where: { id: TEST_CHAR_REF } })
})

afterAll(async () => {
  if (createdOwnershipId) {
    await prisma.characterOwnership.deleteMany({ where: { id: createdOwnershipId } })
  }
  if (createdCharacterId) {
    await prisma.character.deleteMany({ where: { id: createdCharacterId } })
  }
  await prisma.$disconnect()
  await pool.end()
})

describe('anime roll system e2e', () => {
  it('persists MANUAL character and ownership end-to-end', async () => {
    const character = await prisma.character.create({
      data: {
        id: TEST_CHAR_REF,
        name: 'E2E Test Character',
        series: 'E2E Series',
        category: 'ANIME',
        gender: 'MALE',
        coinValue: 42,
        rarity: 'RARE',
        popularityScore: 100,
        imageUrl: 'https://example.com/test.jpg',
      },
    })
    createdCharacterId = character.id

    expect(character.coinValue).toBe(42)

    const ownership = await prisma.characterOwnership.create({
      data: {
        characterRef: TEST_CHAR_REF,
        source: 'MANUAL',
        groupId: TEST_GROUP,
        ownerJid: TEST_USER,
      },
    })
    createdOwnershipId = ownership.id

    expect(ownership.source).toBe('MANUAL')
    expect(ownership.ownerJid).toBe(TEST_USER)
  })

  it('enforces unique ownership via (characterRef, source, groupId) constraint', async () => {
    await expect(
      prisma.characterOwnership.create({
        data: {
          characterRef: TEST_CHAR_REF,
          source: 'MANUAL',
          groupId: TEST_GROUP,
          ownerJid: 'other-user@s.whatsapp.net',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('allows same character in different groups', async () => {
    const otherGroup = 'e2e-other-group@g.us'
    const ownership = await prisma.characterOwnership.create({
      data: {
        characterRef: TEST_CHAR_REF,
        source: 'MANUAL',
        groupId: otherGroup,
        ownerJid: TEST_USER,
      },
    })

    expect(ownership.groupId).toBe(otherGroup)
    expect(ownership.ownerJid).toBe(TEST_USER)

    await prisma.characterOwnership.delete({ where: { id: ownership.id } })
  })

  it('handles ANILIST source with numeric characterRef', async () => {
    const ref = 99999
    await prisma.anilistCharacter.upsert({
      where: { externalId: ref },
      create: {
        externalId: ref,
        name: 'E2E AniList Char',
        series: 'E2E AniList',
        gender: 'FEMALE',
        coinValue: 75,
        rarity: 'EPIC',
        imageUrl: 'https://example.com/al.jpg',
        sourceImageUrl: 'https://example.com/al-src.jpg',
        popularityScore: 1000,
      },
      update: {},
    })

    const ownership = await prisma.characterOwnership.create({
      data: {
        characterRef: String(ref),
        source: 'ANILIST',
        groupId: TEST_GROUP,
        ownerJid: TEST_USER,
      },
    })

    expect(ownership.source).toBe('ANILIST')

    const char = await prisma.anilistCharacter.findUnique({ where: { externalId: ref } })
    expect(char?.coinValue).toBe(75)

    await prisma.characterOwnership.delete({ where: { id: ownership.id } })
    await prisma.anilistCharacter.delete({ where: { externalId: ref } })
  })

  it('stores CharacterSourceMeta for AniList gender counts', async () => {
    await prisma.characterSourceMeta.upsert({
      where: { source_gender: { source: 'ANILIST', gender: 'MALE' } },
      create: { source: 'ANILIST', gender: 'MALE', totalCount: 12345 },
      update: { totalCount: 12345 },
    })

    const meta = await prisma.characterSourceMeta.findUnique({
      where: { source_gender: { source: 'ANILIST', gender: 'MALE' } },
    })

    expect(meta?.totalCount).toBe(12345)
  })
})
