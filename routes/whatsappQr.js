let currentQr = null
let qrExpiry = 0

export function registerWhatsAppQrRoutes(app) {
  app.post('/whatsapp-qr', (req, res) => {
    const token =
      req.headers['x-ingest-token'] ?? req.headers['x-log-token'] ?? ''
    if (!token || token !== process.env.LOG_INGEST_TOKEN) {
      return res.sendStatus(403)
    }
    const { qr } = req.body ?? {}
    if (!qr || typeof qr !== 'string') return res.sendStatus(400)

    currentQr = qr
    qrExpiry = Date.now() + 60_000
    return res.sendStatus(200)
  })

  app.get('/whatsapp-qr', (_req, res) => {
    if (!currentQr || Date.now() > qrExpiry) return res.sendStatus(404)
    return res.json({ qr: currentQr })
  })
}
