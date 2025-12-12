import { requireAuth } from "../middleware/auth.js";
import { enqueueGroupContextJob } from "../services/groupContextQueue.js";
import { GroupContext } from "../models/groupContext.js";

export function registerGroupContextRoutes(app) {
    // Admin: enfileira refresh de contexto para um groupId
    app.post("/context/refresh", requireAuth, async (req, res) => {
        try {
            const groupId =
                req.body?.groupId ||
                process.env.GROUP_ID ||
                process.env.ALLOWED_PING_GROUP;
            if (!groupId) {
                return res.status(400).json({ error: "groupId é obrigatório" });
            }
            await enqueueGroupContextJob(groupId);
            res.json({ message: "Job de contexto enfileirado", groupId });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao enfileirar" });
        }
    });

    // Ingest: chamado pelo worker para salvar contexto
    app.post("/context/ingest", async (req, res) => {
        try {
            const token = req.headers["x-context-token"] || req.query.token;
            const expected = process.env.CONTEXT_INGEST_TOKEN || process.env.LOG_INGEST_TOKEN;
            if (!expected || token !== expected) {
                return res.status(401).json({ error: "Token inválido" });
            }
            const { groupId, subject, description, members } = req.body || {};
            if (!groupId) return res.status(400).json({ error: "groupId é obrigatório" });

            const payload = {
                groupId,
                subject: subject || "",
                description: description || "",
                members: Array.isArray(members) ? members : [],
                fetchedAt: new Date(),
            };
            await GroupContext.findOneAndUpdate({ groupId }, payload, {
                upsert: true,
            });
            res.json({ message: "Contexto salvo", groupId });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao salvar contexto" });
        }
    });

    // Consulta (opcional)
    app.get("/context/:groupId", requireAuth, async (req, res) => {
        const doc = await GroupContext.findOne({ groupId: req.params.groupId }).lean();
        if (!doc) return res.status(404).json({ error: "Contexto não encontrado" });
        res.json(doc);
    });
}
