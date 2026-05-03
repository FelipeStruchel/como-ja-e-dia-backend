// como-ja-e-dia-backend/routes/drops.ts
import type { Express } from 'express'
import { prisma } from '../services/db.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { generateCaptureMessage } from '../services/dropService.js'
import { log } from '../services/logger.js'

export function registerDropRoutes(app: Express): void {
  app.post('/drops/capture', async (req, res) => {
    const token = req.headers['x-drop-token']
    if (!process.env.DROP_CAPTURE_TOKEN || token !== process.env.DROP_CAPTURE_TOKEN) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    const { dropId, capturedBy, groupId } = req.body as {
      dropId?: string
      capturedBy?: string
      groupId?: string
    }

    if (!dropId || !capturedBy || !groupId) {
      res.status(400).json({ error: 'dropId, capturedBy e groupId são obrigatórios' })
      return
    }

    // Dupla defesa: UPDATE só executa se capturedBy ainda for null
    const result = await prisma.pokemonDrop.updateMany({
      where: { id: dropId, capturedBy: null },
      data: { capturedBy, capturedAt: new Date() },
    })

    if (result.count === 0) {
      res.status(409).json({ error: 'já capturado' })
      return
    }

    // Responde 200 imediatamente — não bloqueia na chamada Gemini
    res.json({ ok: true })

    // Async: gera mensagem e enfileira
    setImmediate(async () => {
      try {
        const drop = await prisma.pokemonDrop.findUnique({ where: { id: dropId } })
        const pokemon = drop
          ? await prisma.pokemonCache.findUnique({ where: { id: drop.pokemonId } })
          : null
        const pokemonName = pokemon?.name ?? `Pokémon desconhecido`

        const number = capturedBy.split('@')[0]
        const raw = await generateCaptureMessage(pokemonName)
        const message = raw.replace('{{mention}}', `@${number}`)

        await enqueueSendMessage({
          type: 'text',
          groupId,
          content: message,
          mentions: [capturedBy],
        })

        log(`Captura registrada: ${capturedBy} → ${pokemonName}`, 'info')
      } catch (err) {
        // Fallback sem IA
        const number = capturedBy.split('@')[0]
        await enqueueSendMessage({
          type: 'text',
          groupId,
          content: `🎉 @${number} capturou um Pokémon misterioso!`,
          mentions: [capturedBy],
        }).catch((qErr: Error) => log(`Fallback enqueue failed: ${qErr.message}`, 'error'))
        log(`Erro na mensagem de captura: ${(err as Error).message}`, 'error')
      }
    })
  })

  app.post('/drops/spawner-blocked', async (req, res) => {
    const token = req.headers['x-drop-token']
    if (!process.env.DROP_CAPTURE_TOKEN || token !== process.env.DROP_CAPTURE_TOKEN) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    const { groupId, reactorJid, unlocksAt } = req.body as {
      groupId?: string
      reactorJid?: string
      unlocksAt?: number
    }

    if (!groupId || !reactorJid || !unlocksAt) {
      res.status(400).json({ error: 'groupId, reactorJid e unlocksAt são obrigatórios' })
      return
    }

    res.json({ ok: true })

    const secsLeft = Math.max(60, Math.ceil((unlocksAt - Date.now()) / 1000))
    const minsLeft = Math.ceil(secsLeft / 60)
    const number = reactorJid.split('@')[0]
    await enqueueSendMessage({
      type: 'text',
      groupId,
      content: `⏳ @${number}, você convocou este Pokémon! Aguarda ${minsLeft} minuto${minsLeft !== 1 ? 's' : ''} antes de poder capturá-lo.`,
      mentions: [reactorJid],
    })
  })
}
