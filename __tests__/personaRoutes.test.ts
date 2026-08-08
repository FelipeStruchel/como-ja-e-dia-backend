import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireGroupAdmin: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/personaConfig.js', () => ({
  getPersonaPrompt: vi.fn(),
  savePersonaPrompt: vi.fn(),
}))

vi.mock('../services/db.js', () => ({
  prisma: { personaConfig: { findFirst: vi.fn() } },
}))

import { requireGroupAdmin } from '../middleware/auth.js'
import { getPersonaPrompt, savePersonaPrompt } from '../services/personaConfig.js'
import { prisma } from '../services/db.js'
import { registerPersonaRoutes } from '../routes/persona.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    put: (path: string, ...h: unknown[]) => { routes[`PUT ${path}`] = h },
  }
  return { app: app as any, routes }
}

function makeReqRes(query: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  const req = { query, body } as any
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any
  return { req, res }
}

beforeEach(() => vi.clearAllMocks())

describe('persona routes wiring', () => {
  it('GET and PUT /persona both use requireGroupAdmin, not requireRole', () => {
    const { app, routes } = makeApp()
    // requireGroupAdmin is a factory: each call returns a distinct middleware
    // function. Capture the exact instances it will hand back (GET is wired
    // first, then PUT) so we can assert those specific instances end up in
    // the route's middleware chain — proving requireGroupAdmin actually gates
    // these routes.
    const getGroupAdminMw = vi.fn((req, res, next) => next())
    const putGroupAdminMw = vi.fn((req, res, next) => next())
    vi.mocked(requireGroupAdmin)
      .mockReturnValueOnce(getGroupAdminMw)
      .mockReturnValueOnce(putGroupAdminMw)

    registerPersonaRoutes(app)

    expect(requireGroupAdmin).toHaveBeenCalledTimes(2)
    expect(routes['GET /persona']).toContain(getGroupAdminMw)
    expect(routes['PUT /persona']).toContain(putGroupAdminMw)
  })
})

describe('GET /persona', () => {
  it('a ?groupId= query string reaches the lookup with that exact value', async () => {
    const { app, routes } = makeApp()
    registerPersonaRoutes(app)
    const handler = routes['GET /persona'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValue(null)
    const { req, res } = makeReqRes({ groupId: 'a@g.us' })
    await handler(req, res)
    expect(prisma.personaConfig.findFirst).toHaveBeenCalledWith({ where: { groupId: 'a@g.us' } })
  })

  it('an omitted groupId resolves to null and still queries the DB (global fallback row)', async () => {
    const { app, routes } = makeApp()
    registerPersonaRoutes(app)
    const handler = routes['GET /persona'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValue(null)
    const { req, res } = makeReqRes({})
    await handler(req, res)
    expect(prisma.personaConfig.findFirst).toHaveBeenCalledWith({ where: { groupId: null } })
  })

  it('returns the RAW prompt when a group-specific row exists, never the guards-wrapped getPersonaPrompt result', async () => {
    const { app, routes } = makeApp()
    registerPersonaRoutes(app)
    const handler = routes['GET /persona'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValue({ prompt: 'raw group tone' } as any)
    vi.mocked(getPersonaPrompt).mockResolvedValue('GUARDS...\n\nraw group tone')
    const { req, res } = makeReqRes({ groupId: 'a@g.us' })
    await handler(req, res)
    expect(res.json).toHaveBeenCalledWith({ prompt: 'raw group tone', default: expect.any(String) })
    expect(getPersonaPrompt).not.toHaveBeenCalled()
  })

  it('returns the RAW prompt for the global row when groupId is omitted, never the guards-wrapped getPersonaPrompt result', async () => {
    const { app, routes } = makeApp()
    registerPersonaRoutes(app)
    const handler = routes['GET /persona'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValue({ prompt: 'raw global tone' } as any)
    vi.mocked(getPersonaPrompt).mockResolvedValue('GUARDS...\n\nraw global tone')
    const { req, res } = makeReqRes({})
    await handler(req, res)
    expect(res.json).toHaveBeenCalledWith({ prompt: 'raw global tone', default: expect.any(String) })
    expect(getPersonaPrompt).not.toHaveBeenCalled()
  })

  it('falls back to the raw hardcoded default (not getPersonaPrompt) when no row exists at all', async () => {
    const { app, routes } = makeApp()
    registerPersonaRoutes(app)
    const handler = routes['GET /persona'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.personaConfig.findFirst).mockResolvedValue(null)
    const { req, res } = makeReqRes({})
    await handler(req, res)
    const call = vi.mocked(res.json).mock.calls[0][0] as any
    expect(call.prompt).toBe(call.default)
    expect(getPersonaPrompt).not.toHaveBeenCalled()
  })
})

describe('PUT /persona', () => {
  it('a ?groupId= query string reaches savePersonaPrompt with that exact value', async () => {
    const { app, routes } = makeApp()
    registerPersonaRoutes(app)
    const handler = routes['PUT /persona'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(savePersonaPrompt).mockResolvedValue('saved prompt')
    const { req, res } = makeReqRes({ groupId: 'a@g.us' }, { prompt: 'new tone' })
    await handler(req, res)
    expect(savePersonaPrompt).toHaveBeenCalledWith('a@g.us', 'new tone')
  })

  it('an omitted groupId resolves to null, saving the global fallback row', async () => {
    const { app, routes } = makeApp()
    registerPersonaRoutes(app)
    const handler = routes['PUT /persona'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(savePersonaPrompt).mockResolvedValue('saved global')
    const { req, res } = makeReqRes({}, { prompt: 'new global tone' })
    await handler(req, res)
    expect(savePersonaPrompt).toHaveBeenCalledWith(null, 'new global tone')
  })
})
