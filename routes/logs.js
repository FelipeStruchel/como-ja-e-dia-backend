import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../services/db.js";

export function registerLogRoutes(app) {
    app.get("/logs", requireAuth, async (req, res) => {
        try {
            const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "100", 10)));
            const source = req.query.source;
            const logs = await prisma.logEntry.findMany({
                where: source ? { source } : {},
                orderBy: { createdAt: "desc" },
                take: limit,
            });
            res.json(logs);
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao buscar logs" });
        }
    });
}
