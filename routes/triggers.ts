import { Express } from "express";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../services/db.js";

function parseTriggerPayload(body: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  safe.name = ((body.name || "") as string).toString().trim();
  safe.phrases = Array.isArray(body.phrases)
    ? (body.phrases as unknown[]).map((p) => ((p || "") as string).toString().trim()).filter((p) => (p as string).length > 0)
    : [];
  safe.matchType = ["exact", "contains", "regex"].includes(body.matchType as string)
    ? body.matchType
    : "exact";
  safe.caseSensitive = !!body.caseSensitive;
  safe.normalizeAccents =
    typeof body.normalizeAccents === "boolean" ? body.normalizeAccents : true;
  safe.wholeWord = !!body.wholeWord;
  safe.responseType = ["text", "image", "video"].includes(body.responseType as string)
    ? body.responseType
    : "text";
  safe.responseText = ((body.responseText || "") as string).toString();
  safe.responseMediaUrl = ((body.responseMediaUrl || "") as string).toString();
  safe.replyMode = ["reply", "new"].includes(body.replyMode as string)
    ? body.replyMode
    : "reply";
  safe.mentionSender = !!body.mentionSender;
  safe.chancePercent = Math.min(
    100,
    Math.max(0, Number.parseFloat((body.chancePercent ?? 100) as string) || 0)
  );
  safe.expiresAt = body.expiresAt ? new Date(body.expiresAt as string) : null;
  safe.maxUses = body.maxUses ? Number.parseInt(body.maxUses as string, 10) || null : null;
  safe.cooldownSeconds = Math.max(0, Number.parseInt((body.cooldownSeconds || 0) as string, 10));
  safe.cooldownPerUserSeconds = Math.max(
    0,
    Number.parseInt((body.cooldownPerUserSeconds || 0) as string, 10)
  );
  safe.active = body.active !== undefined ? !!body.active : true;
  safe.allowedUsers = Array.isArray(body.allowedUsers)
    ? (body.allowedUsers as unknown[]).map((u) => ((u || "") as string).toString().trim()).filter(Boolean)
    : [];
  return safe;
}

function validateTriggerPayload(payload: Record<string, unknown>) {
  if (!payload.phrases || (payload.phrases as unknown[]).length === 0) {
    throw new Error("Pelo menos uma frase/palavra é obrigatória");
  }
  if (payload.responseType === "text" && !(payload.responseText as string).trim()) {
    throw new Error("Resposta de texto é obrigatória para responseType=text");
  }
  if (
    (payload.responseType === "image" || payload.responseType === "video") &&
    !payload.responseMediaUrl
  ) {
    throw new Error("responseMediaUrl é obrigatório para mídia");
  }
  if (payload.expiresAt && isNaN((payload.expiresAt as Date).getTime())) {
    throw new Error("Data de expiração inválida");
  }
  if (payload.expiresAt && (payload.expiresAt as Date).getTime() <= Date.now()) {
    throw new Error("A data de expiração deve ser no futuro");
  }
  if (payload.maxUses !== null && (payload.maxUses as number) < 0) {
    throw new Error("maxUses deve ser >= 0");
  }
}

export function registerTriggerRoutes(app: Express) {
  app.get("/triggers", requireAuth, async (_req, res) => {
    try {
      const list = await prisma.trigger.findMany({ orderBy: { createdAt: "desc" } });
      res.json(list);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar triggers";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/triggers", requireAuth, async (req, res) => {
    try {
      const payload = parseTriggerPayload(req.body || {});
      validateTriggerPayload(payload);
      const created = await prisma.trigger.create({ data: payload as Parameters<typeof prisma.trigger.create>[0]["data"] });
      res.status(201).json(created);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao criar trigger";
      res.status(400).json({ error: msg });
    }
  });

  app.put("/triggers/:id", requireAuth, async (req, res) => {
    try {
      const payload = parseTriggerPayload(req.body || {});
      validateTriggerPayload(payload);
      let updated;
      try {
        updated = await prisma.trigger.update({
          where: { id: req.params.id },
          data: payload as Parameters<typeof prisma.trigger.update>[0]["data"],
        });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "P2025")
          return res.status(404).json({ error: "Trigger não encontrada" });
        throw err;
      }
      res.json(updated);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao atualizar trigger";
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/triggers/:id", requireAuth, async (req, res) => {
    try {
      try {
        await prisma.trigger.delete({ where: { id: req.params.id } });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "P2025")
          return res.status(404).json({ error: "Trigger não encontrada" });
        throw err;
      }
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao remover trigger";
      res.status(500).json({ error: msg });
    }
  });
}
