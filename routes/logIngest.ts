import { Express } from "express";
import { prisma } from "../services/db.js";

export function registerLogIngestRoute(app: Express) {
  app.post("/logs/ingest", async (req, res) => {
    try {
      const token =
        req.headers["x-log-token"] || req.headers["x-log-ingest-token"];
      const expected = process.env.LOG_INGEST_TOKEN;
      if (!expected || !token || token !== expected) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const { source = "external", level = "info", message, meta = null } =
        req.body || {};
      if (!message) return res.status(400).json({ error: "message é obrigatório" });
      const doc = await prisma.logEntry.create({
        data: { source, level, message: String(message), meta: meta ?? undefined },
      });
      return res.status(201).json({ id: doc.id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao salvar log";
      return res.status(500).json({ error: msg });
    }
  });
}
