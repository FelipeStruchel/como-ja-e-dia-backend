import { LogEntry } from "../models/logEntry.js";

export function registerLogIngestRoute(app) {
    app.post("/logs/ingest", async (req, res) => {
        try {
            const token = req.headers["x-log-token"] || req.headers["x-log-ingest-token"];
            const expected = process.env.LOG_INGEST_TOKEN;
            if (!expected || !token || token !== expected) {
                return res.status(401).json({ error: "Unauthorized" });
            }
            const { source = "external", level = "info", message, meta = null } =
                req.body || {};
            if (!message) {
                return res.status(400).json({ error: "message é obrigatório" });
            }
            const doc = await LogEntry.create({
                source,
                level,
                message: String(message),
                meta,
            });
            return res.status(201).json({ id: doc._id });
        } catch (err) {
            return res.status(500).json({ error: err.message || "Erro ao salvar log" });
        }
    });
}
