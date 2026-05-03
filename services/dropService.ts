import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import path from 'path'
import { prisma } from './db.js'
import { getRedis } from './redis.js'
import { fetchAndCachePokemon } from './pokemonService.js'
import { enqueueSendMessage } from './sendQueue.js'
import { callGeminiChat } from './ai.js'
import { DROP_CONFIG, DROP_NARRATOR_PERSONA } from './dropConstants.js'
import { log } from './logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface PokemonWeight { id: number; captureRate: number }

let _weights: PokemonWeight[] | null = null

async function loadWeights(): Promise<PokemonWeight[]> {
  if (_weights) return _weights
  const raw = await readFile(
    path.join(__dirname, '../data/pokemon-weights.json'),
    'utf-8'
  )
  _weights = JSON.parse(raw) as PokemonWeight[]
  return _weights
}

export function weightedRandom(
  weights: PokemonWeight[],
  excludeIds: Set<number>
): number {
  const pool = weights.filter((w) => !excludeIds.has(w.id))
  if (pool.length === 0) throw new Error('Nenhum Pokémon disponível para dropar')
  const total = pool.reduce((sum, w) => sum + w.captureRate, 0)
  let rand = Math.random() * total
  for (const w of pool) {
    rand -= w.captureRate
    if (rand <= 0) return w.id
  }
  return pool[pool.length - 1].id
}

async function generateDropCaption(pokemon: {
  name: string
  types: string[]
}): Promise<string> {
  const typeStr = pokemon.types.join(', ')
  const result = await callGeminiChat(
    [
      { role: 'system', content: DROP_NARRATOR_PERSONA },
      {
        role: 'user',
        content: `Uma criatura misteriosa do tipo "${typeStr}" apareceu no grupo! Gere uma mensagem de aparição dramática e épica SEM revelar o nome da criatura.`,
      },
    ],
    30_000,
    null
  )
  return result ?? '✨ Uma presença misteriosa emerge das sombras...'
}

export async function generateCaptureMessage(pokemonName: string): Promise<string> {
  const result = await callGeminiChat(
    [
      { role: 'system', content: DROP_NARRATOR_PERSONA },
      {
        role: 'user',
        content: `Um treinador acabou de capturar ${pokemonName}! Gere uma mensagem de captura épica e celebratória que revela o nome ${pokemonName}. Use o token {{mention}} exatamente onde deve aparecer a menção ao treinador.`,
      },
    ],
    30_000,
    null
  )
  return result ?? `🎉 {{mention}} capturou *${pokemonName}*!`
}

export async function executeDrop(
  groupId: string,
  options?: { spawnedBy?: string; spawnerUnlocksAt?: number }
): Promise<void> {
  const redis = getRedis()

  const existing = await redis.get(`drop:active:${groupId}`)
  if (existing) {
    log('Drop ignorado: já existe drop ativo no grupo', 'info')
    return
  }

  const captured = await prisma.pokemonDrop.findMany({
    where: { capturedBy: { not: null } },
    select: { pokemonId: true },
  })
  const excludeIds = new Set(captured.map((c) => c.pokemonId))

  const weights = await loadWeights()

  let pokemonId: number
  try {
    pokemonId = weightedRandom(weights, excludeIds)
  } catch {
    log('Todos os Pokémons já foram capturados!', 'warn')
    return
  }

  const pokemon = await fetchAndCachePokemon(pokemonId)

  const dbEntry = await prisma.pokemonCache.findUnique({ where: { id: pokemonId } })
  let aiCaption: string
  if (dbEntry?.aiCaption) {
    aiCaption = dbEntry.aiCaption
  } else {
    try {
      aiCaption = await generateDropCaption(pokemon)
      await prisma.pokemonCache.update({
        where: { id: pokemonId },
        data: { aiCaption },
      })
    } catch (err) {
      log(`Gemini caption failed for #${pokemonId}: ${(err as Error).message}`, 'warn')
      aiCaption = '✨ Uma presença misteriosa emerge das sombras...'
    }
  }

  const drop = await prisma.pokemonDrop.create({
    data: { groupId, pokemonId },
  })

  const expiresAt = Date.now() + DROP_CONFIG.ACTIVE_TTL_SEC * 1000

  await redis.set(
    `drop:active:${groupId}`,
    JSON.stringify({
      dropId: drop.id,
      pokemonId,
      expiresAt,
      ...(options?.spawnedBy
        ? { spawnedBy: options.spawnedBy, spawnerUnlocksAt: options.spawnerUnlocksAt }
        : {}),
    }),
    'EX',
    DROP_CONFIG.ACTIVE_TTL_SEC
  )

  await enqueueSendMessage(
    {
      type: 'pokemon_drop',
      groupId,
      content: pokemon.imageUrl,
      caption: aiCaption,
      dropId: drop.id,
    },
    { idempotencyKey: `drop:${drop.id}` }
  )

  log(`Drop enfileirado: Pokémon #${pokemonId} (${pokemon.name}) para ${groupId}`, 'info')
}
