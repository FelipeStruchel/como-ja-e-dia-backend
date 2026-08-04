import { Express } from "express";
import { requireAuth, requireRole, requireWorkerOrRole } from "../middleware/auth.js";
import { prisma } from "../services/db.js";
import { getRedis } from "../services/redis.js";
import { enqueueGroupDiscoveryJob } from "../services/groupDiscoveryQueue.js";
import { resetGroupCache } from "../services/groupService.js";

const DISCOVERY_CACHE_KEY = "groups:discovered";
const DISCOVERY_CACHE_TTL_SEC = 86_400;

const FEATURE_FIELDS = [
  "pokemonEnabled",
  "confessionsEnabled",
  "scheduledGreetingsEnabled",
  "triggersEnabled",
  "contextSyncEnabled",
] as const;

function parseFeatureFlags(body: Record<string, unknown>) {
  const out: Record<string, boolean> = {};
  for (const field of FEATURE_FIELDS) {
    if (typeof body[field] === "boolean") out[field] = body[field] as boolean;
  }
  return out;
}

export function registerGroupRoutes(app: Express) {
  app.get("/groups", requireAuth, requireRole("super_admin"), async (_req, res) => {
    try {
      const groups = await prisma.group.findMany({ orderBy: { createdAt: "asc" } });
      res.json(groups);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar grupos";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/groups", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const id = ((req.body?.id || "") as string).trim();
      const name = ((req.body?.name || "") as string).trim();
      if (!id) return res.status(400).json({ error: "id (JID do grupo) é obrigatório" });
      if (!name) return res.status(400).json({ error: "name é obrigatório" });
      const created = await prisma.group.create({
        data: {
          id,
          name,
          pokemonEnabled: false,
          confessionsEnabled: false,
          scheduledGreetingsEnabled: false,
          triggersEnabled: false,
          contextSyncEnabled: false,
        },
      });
      res.status(201).json(created);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2002") {
        return res.status(409).json({ error: "Grupo já cadastrado" });
      }
      const msg = err instanceof Error ? err.message : "Erro ao criar grupo";
      res.status(400).json({ error: msg });
    }
  });

  app.patch("/groups/:id", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const data: Record<string, unknown> = parseFeatureFlags(req.body || {});
      if (typeof req.body?.name === "string" && req.body.name.trim()) {
        data.name = req.body.name.trim();
      }
      const updated = await prisma.group.update({
        where: { id: req.params.id },
        data,
      });
      resetGroupCache();
      res.json(updated);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2025") {
        return res.status(404).json({ error: "Grupo não encontrado" });
      }
      const msg = err instanceof Error ? err.message : "Erro ao atualizar grupo";
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/groups/:id", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      await prisma.group.delete({ where: { id: req.params.id } });
      resetGroupCache();
      res.json({ success: true });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2025") {
        return res.status(404).json({ error: "Grupo não encontrado" });
      }
      const msg = err instanceof Error ? err.message : "Erro ao remover grupo";
      res.status(500).json({ error: msg });
    }
  });

  app.get("/groups/discover", requireAuth, requireRole("super_admin"), async (_req, res) => {
    try {
      const redis = getRedis();
      const cached = await redis.get(DISCOVERY_CACHE_KEY);
      if (cached) {
        return res.json({ status: "ready", groups: JSON.parse(cached) });
      }
      await enqueueGroupDiscoveryJob();
      res.json({ status: "pending" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao buscar grupos";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/groups/discover/sync", requireAuth, requireRole("super_admin"), async (_req, res) => {
    try {
      const redis = getRedis();
      await redis.del(DISCOVERY_CACHE_KEY);
      await enqueueGroupDiscoveryJob();
      res.json({ status: "pending" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao sincronizar grupos";
      res.status(500).json({ error: msg });
    }
  });

  app.post(
    "/groups/discover/ingest",
    requireWorkerOrRole("super_admin"),
    async (req, res) => {
      try {
        const groups = Array.isArray(req.body?.groups)
          ? req.body.groups.filter(
              (g: unknown) =>
                !!g && typeof g === "object" && typeof (g as { id?: unknown }).id === "string"
            )
          : [];
        const redis = getRedis();
        await redis.set(DISCOVERY_CACHE_KEY, JSON.stringify(groups), "EX", DISCOVERY_CACHE_TTL_SEC);
        res.json({ success: true, count: groups.length });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro ao salvar descoberta de grupos";
        res.status(500).json({ error: msg });
      }
    }
  );
}
