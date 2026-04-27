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
    100
  )
  return result ?? '✨ Uma presença misteriosa emerge das sombras...'
}

export async function generateCaptureMessage(
  pokemonName: string,
  capturedByJid: string
): Promise<string> {
  const number = capturedByJid.split('@')[0]
  const result = await callGeminiChat(
    [
      { role: 'system', content: DROP_NARRATOR_PERSONA },
      {
        role: 'user',
        content: `O treinador de número ${number} acabou de capturar ${pokemonName}! Gere uma mensagem de captura épica e celebratória que revela o nome ${pokemonName}.`,
      },
    ],
    30_000,
    100
  )
  return result ?? `🎉 Incrível! *${pokemonName}* foi capturado!`
}

export async function executeDrop(groupId: string): Promise<void> {
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
    aiCaption = await generateDropCaption(pokemon)
    await prisma.pokemonCache.update({
      where: { id: pokemonId },
      data: { aiCaption },
    })
  }

  const drop = await prisma.pokemonDrop.create({
    data: { groupId, pokemonId },
  })

  await redis.set(
    `drop:active:${groupId}`,
    JSON.stringify({ dropId: drop.id, pokemonId }),
    'EX',
    DROP_CONFIG.ACTIVE_TTL_SEC
  )

  await enqueueSendMessage(
    {
      type: 'pokemon_drop' as any,
      groupId,
      content: pokemon.imageUrl,
      caption: aiCaption,
      dropId: drop.id,
    } as any,
    { idempotencyKey: `drop:${drop.id}` }
  )

  log(`Drop enfileirado: Pokémon #${pokemonId} (${pokemon.name}) para ${groupId}`, 'info')
}
