import { Express } from "express";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../services/db.js";

export function registerLogRoutes(app: Express) {
  app.get("/logs", requireAuth, async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || "100", 10)));
      const source = req.query.source as string | undefined;
      const logs = await prisma.logEntry.findMany({
        where: source ? { source } : {},
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      res.json(logs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao buscar logs";
      res.status(500).json({ error: msg });
    }
  });
}
