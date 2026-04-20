import { requireAuth } from "../middleware/auth.js";
import { enqueueGroupContextJob } from "../services/groupContextQueue.js";
import { prisma } from "../services/db.js";

export function registerGroupContextRoutes(app) {
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
                subject: subject || "",
                description: description || "",
                members: Array.isArray(members) ? members : [],
                fetchedAt: new Date(),
            };
            await prisma.groupContext.upsert({
                where: { groupId },
                update: payload,
                create: { groupId, ...payload },
            });
            res.json({ message: "Contexto salvo", groupId });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao salvar contexto" });
        }
    });

    app.get("/context/:groupId", requireAuth, async (req, res) => {
        try {
            const doc = await prisma.groupContext.findUnique({
                where: { groupId: req.params.groupId },
            });
            if (!doc) return res.status(404).json({ error: "Contexto não encontrado" });
            res.json(doc);
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao buscar contexto" });
        }
    });
}
