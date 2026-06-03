import 'dotenv/config'
import { prisma } from '../services/db.js'
import { fetchSourceMeta } from '../services/anilistService.js'

async function main() {
  console.log('Fetching AniList source metadata...')
  const results = await fetchSourceMeta()

  for (const { gender, totalCount } of results) {
    await prisma.characterSourceMeta.upsert({
      where: { source_gender: { source: 'ANILIST', gender } },
      create: { source: 'ANILIST', gender, totalCount },
      update: { totalCount },
    })
    console.log(`  ANILIST ${gender}: ${totalCount} characters`)
  }

  console.log('Done.')
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
