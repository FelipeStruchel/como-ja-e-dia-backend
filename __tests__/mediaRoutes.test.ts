import { describe, it, expect, vi } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
  requireWorkerOrRole: vi.fn(() => vi.fn((req, res, next) => next())),
}))

import { requireAuth, requireRole, requireWorkerOrRole } from '../middleware/auth.js'
import { registerMediaRoutes } from '../routes/media.js'
import { MEDIA_TYPES } from '../mediaManager.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    post: (path: string, ...handlers: unknown[]) => { routes[`POST ${path}`] = handlers },
    get: (path: string, ...handlers: unknown[]) => { routes[`GET ${path}`] = handlers },
    delete: (path: string, ...handlers: unknown[]) => { routes[`DELETE ${path}`] = handlers },
  }
  return { app: app as any, routes }
}

describe('registerMediaRoutes auth wiring', () => {
  it('POST /media does not require auth', () => {
    const { app, routes } = makeApp()
    registerMediaRoutes(app, {
      MEDIA_TYPES,
      saveMedia: vi.fn() as any,
      listAllMedia: vi.fn() as any,
    })
    const handlers = routes['POST /media']
    expect(handlers).not.toContain(requireAuth)
    expect(requireRole).not.toHaveBeenCalledWith('bom_dia_admin')
  })

  it('DELETE /media/:type/:filename requires super_admin, not the retired bom_dia_admin role', () => {
    const { app, routes } = makeApp()
    registerMediaRoutes(app, {
      MEDIA_TYPES,
      saveMedia: vi.fn() as any,
      listAllMedia: vi.fn() as any,
    })
    expect(requireWorkerOrRole).toHaveBeenCalledWith('super_admin')
    expect(requireWorkerOrRole).not.toHaveBeenCalledWith('bom_dia_admin')
    expect(routes['DELETE /media/:type/:filename']).toBeDefined()
  })
})
