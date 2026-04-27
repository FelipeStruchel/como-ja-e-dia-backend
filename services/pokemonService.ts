import axios from 'axios'
import { getRedis } from './redis.js'
import { prisma } from './db.js'
import { DROP_CONFIG } from './dropConstants.js'
import { log } from './logger.js'

interface PokeApiPokemon {
  id: number
  name: string
  sprites: {
    other: {
      'official-artwork': { front_default: string }
    }
  }
  types: Array<{ type: { name: string } }>
}

interface PokeApiSpecies {
  capture_rate: number
  names: Array<{ name: string; language: { name: string } }>
}

export interface PokemonData {
  id: number
  name: string
  imageUrl: string
  types: string[]
  captureRate: number
}

export async function fetchAndCachePokemon(id: number): Promise<PokemonData> {
  const redis = getRedis()
  const cacheKey = `pokemon:${id}`

  // L1: Redis
  const cached = await redis.get(cacheKey)
  if (cached) return JSON.parse(cached) as PokemonData

  // L2: DB
  const dbEntry = await prisma.pokemonCache.findUnique({ where: { id } })
  if (dbEntry) {
    const data: PokemonData = {
      id: dbEntry.id,
      name: dbEntry.name,
      imageUrl: dbEntry.imageUrl,
      types: dbEntry.types,
      captureRate: dbEntry.captureRate,
    }
    await redis.set(cacheKey, JSON.stringify(data), 'EX', DROP_CONFIG.POKEMON_CACHE_TTL_SEC)
    return data
  }

  // L3: PokeAPI
  log(`Buscando Pokémon #${id} na PokeAPI`, 'info')
  let pokemonRes: Awaited<ReturnType<typeof axios.get<PokeApiPokemon>>>
  let speciesRes: Awaited<ReturnType<typeof axios.get<PokeApiSpecies>>>
  try {
    ;[pokemonRes, speciesRes] = await Promise.all([
      axios.get<PokeApiPokemon>(`https://pokeapi.co/api/v2/pokemon/${id}`, { timeout: 15_000 }),
      axios.get<PokeApiSpecies>(`https://pokeapi.co/api/v2/pokemon-species/${id}`, { timeout: 15_000 }),
    ])
  } catch (err) {
    log(`Falha ao buscar Pokémon #${id} na PokeAPI: ${(err as Error).message}`, 'error')
    throw err
  }

  const pokemon = pokemonRes.data
  const species = speciesRes.data

  const ptName =
    species.names.find((n) => n.language.name === 'pt-BR')?.name ||
    species.names.find((n) => n.language.name === 'pt')?.name ||
    pokemon.name

  const data: PokemonData = {
    id: pokemon.id,
    name: ptName,
    imageUrl: pokemon.sprites.other['official-artwork'].front_default ?? '',
    types: pokemon.types.map((t) => t.type.name),
    captureRate: species.capture_rate,
  }

  await prisma.pokemonCache.upsert({
    where: { id: data.id },
    create: {
      id: data.id,
      name: data.name,
      imageUrl: data.imageUrl,
      types: data.types,
      captureRate: data.captureRate,
    },
    update: {
      name: data.name,
      imageUrl: data.imageUrl,
      types: data.types,
      captureRate: data.captureRate,
      cachedAt: new Date(),
    },
  })

  await redis.set(cacheKey, JSON.stringify(data), 'EX', DROP_CONFIG.POKEMON_CACHE_TTL_SEC)

  return data
}
