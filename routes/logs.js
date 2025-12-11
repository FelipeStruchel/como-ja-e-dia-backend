import { LogEntry } from "../models/logEntry.js";
import { requireAuth } from "../middleware/auth.js";

export function registerLogRoutes(app) {
    app.get("/logs", requireAuth, async (req, res) => {
        try {
            const limit = Math.min(
                200,
                Math.max(1, parseInt(req.query.limit || "100", 10))
            );
            const source = req.query.source;
            const query = {};
            if (source) query.source = source;
            const logs = await LogEntry.find(query)
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean();
            res.json(logs);
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao buscar logs" });
        }
    });
}
