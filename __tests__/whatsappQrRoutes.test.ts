import { describe, it, expect, vi } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
}))

import { requireAuth, requireRole } from '../middleware/auth.js'
import { registerWhatsAppQrRoutes } from '../routes/whatsappQr.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    post: (path: string, ...handlers: unknown[]) => { routes[`POST ${path}`] = handlers },
    get: (path: string, ...handlers: unknown[]) => { routes[`GET ${path}`] = handlers },
  }
  return { app: app as any, routes }
}

describe('registerWhatsAppQrRoutes auth wiring', () => {
  it('GET /whatsapp-qr requires auth and super_admin role', () => {
    const { app, routes } = makeApp()
    registerWhatsAppQrRoutes(app)
    const handlers = routes['GET /whatsapp-qr']
    expect(handlers).toContain(requireAuth)
    expect(requireRole).toHaveBeenCalledWith('super_admin')
  })

  it('POST /whatsapp-qr is unchanged (no requireAuth, uses ingest token)', () => {
    const { app, routes } = makeApp()
    registerWhatsAppQrRoutes(app)
    const handlers = routes['POST /whatsapp-qr']
    expect(handlers).not.toContain(requireAuth)
  })
})
