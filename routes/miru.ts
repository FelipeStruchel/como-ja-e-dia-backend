import type { Express } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import {
  createCharacter,
  updateCharacter,
  listCharacters,
  softDeleteCharacter,
  handleMiruCapture,
  getLinkedGroup,
  createLinkedGroup,
} from '../services/miruService.js'
import { log } from '../services/logger.js'

export function registerMiruRoutes(app: Express): void {
  // Public: list characters
  app.get('/miru/characters', async (req, res) => {
    try {
      const { category, rarity, search, page, pageSize } = req.query
      const result = await listCharacters({
        category: category as any,
        rarity: rarity as any,
        search: search as string | undefined,
        activeOnly: true,
        page: page ? parseInt(page as string, 10) : 1,
        pageSize: pageSize ? parseInt(pageSize as string, 10) : 20,
      })
      res.json(result)
    } catch (err) {
      log(`GET /miru/characters error: ${(err as Error).message}`, 'error')
      res.status(500).json({ error: 'Erro interno' })
    }
  })

  // Admin: create
  app.post('/miru/characters', requireAuth, requireRole('miru_cadastro'), async (req, res) => {
    try {
      const { name, series, category, imageUrl, popularityScore, rarityOverride, active } = req.body
      if (!name || !series || !category || !imageUrl || popularityScore == null) {
        res.status(400).json({ error: 'name, series, category, imageUrl, popularityScore são obrigatórios' })
        return
      }
      const character = await createCharacter({ name, series, category, imageUrl, popularityScore, rarityOverride, active })
      res.status(201).json(character)
    } catch (err) {
      log(`POST /miru/characters error: ${(err as Error).message}`, 'error')
      res.status(500).json({ error: 'Erro interno' })
    }
  })

  // Admin: update
  app.patch('/miru/characters/:id', requireAuth, requireRole('miru_cadastro'), async (req, res) => {
    try {
      const character = await updateCharacter(req.params.id, req.body)
      res.json(character)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Admin: soft-delete
  app.delete('/miru/characters/:id', requireAuth, requireRole('miru_cadastro'), async (req, res) => {
    try {
      await softDeleteCharacter(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Internal: capture (called by worker with x-drop-token)
  app.post('/miru/capture', async (req, res) => {
    const token = req.headers['x-drop-token']
    if (!process.env.DROP_CAPTURE_TOKEN || token !== process.env.DROP_CAPTURE_TOKEN) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    const { ownershipId, capturedBy, gameGroupId, rollMessageId } = req.body as {
      ownershipId?: string
      capturedBy?: string
      gameGroupId?: string
      rollMessageId?: string
    }

    if (!ownershipId || !capturedBy || !gameGroupId) {
      res.status(400).json({ error: 'ownershipId, capturedBy, gameGroupId são obrigatórios' })
      return
    }

    try {
      await handleMiruCapture(gameGroupId, ownershipId, capturedBy, rollMessageId)
      res.json({ ok: true })
    } catch (err) {
      if ((err as Error).message === 'already_captured') {
        res.status(409).json({ error: 'já capturado' })
      } else {
        log(`POST /miru/capture error: ${(err as Error).message}`, 'error')
        res.status(500).json({ error: 'Erro interno' })
      }
    }
  })

  // Internal: get linked group by mainGroupId (called by worker)
  app.get('/miru/linked-groups/:mainGroupId', async (req, res) => {
    const linked = await getLinkedGroup(req.params.mainGroupId)
    if (!linked) { res.status(404).json({ error: 'not found' }); return }
    res.json(linked)
  })

  // Internal: create linked group (called by worker after groupCreate)
  app.post('/miru/linked-groups', async (req, res) => {
    const { mainGroupId, gameGroupId } = req.body as {
      mainGroupId?: string
      gameGroupId?: string
    }
    if (!mainGroupId || !gameGroupId) {
      res.status(400).json({ error: 'mainGroupId e gameGroupId são obrigatórios' })
      return
    }
    try {
      const linked = await createLinkedGroup(mainGroupId, gameGroupId)
      res.status(201).json(linked)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })
}
