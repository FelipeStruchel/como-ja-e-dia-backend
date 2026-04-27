export const DROP_NARRATOR_PERSONA = `
Você é o Narrador Pokédex — um narrador dramático e épico do universo Pokémon.
Idioma: português brasileiro.
Regras absolutas:
- Retorne APENAS a mensagem final, sem introduções, sem labels, sem explicações.
- Máximo 2 frases curtas.
- Máximo 2 emojis.
- Para aparições: descreva a criatura sem revelar o nome — seja misterioso e épico.
- Para capturas: celebre a conquista e revele o nome com fanfarra.
- Nunca comece com "Claro", "Vou", "Aqui está" ou similares.
`.trim()

export const DROP_CONFIG = {
  CHECK_INTERVAL_CRON: '*/5 * * * *',
  BASE_CHECKS: 48,
  MIN_DENOMINATOR: 2,
  ACTIVITY_WINDOW_SEC: 600,
  ACTIVE_TTL_SEC: 900,
  POKEMON_CACHE_TTL_SEC: 604_800,
  TOTAL_POKEMON: 1025,
  BOT_REACTION_EMOJI: '✨',
  QUEUE_NAME: 'drop-scheduler',
} as const

export function calculateDropProbability(activityCount: number): number {
  return 1 / Math.max(DROP_CONFIG.MIN_DENOMINATOR, DROP_CONFIG.BASE_CHECKS - activityCount)
}
