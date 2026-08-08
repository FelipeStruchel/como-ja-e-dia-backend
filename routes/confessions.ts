import { Express } from "express";
import { getRequestIp } from "../utils/ip.js";
import { enqueueSendMessage } from "../services/sendQueue.js";
import { getConfessionsEnabledGroupIds } from "../services/groupService.js";
import { prisma } from "../services/db.js";

export function registerConfessionRoutes(
  app: Express,
  {
    MAX_TEXT_LENGTH,
    MAX_MESSAGE_LENGTH,
    CONFESSION_COOLDOWN_MINUTES,
  }: {
    MAX_TEXT_LENGTH: number;
    MAX_MESSAGE_LENGTH: number;
    CONFESSION_COOLDOWN_MINUTES: number;
  }
) {
  const lastConfessionByIpAndGroup = new Map<string, number>();

  app.get("/confessions/groups", async (_req, res) => {
    try {
      const groups = await prisma.group.findMany({
        where: { confessionsEnabled: true },
        select: { id: true, name: true },
      });
      res.json(groups);
    } catch (error) {
      console.error("Erro ao listar grupos de confissão:", error);
      res.status(500).json({ error: "Erro ao listar grupos" });
    }
  });

  app.post("/confessions", async (req, res) => {
    try {
      const rawMessage =
        (typeof req.body?.message === "string" && req.body.message) ||
        (typeof req.body?.text === "string" && req.body.text) ||
        "";
      const message = rawMessage.trim();
      const confessionLimit = Math.min(MAX_TEXT_LENGTH, MAX_MESSAGE_LENGTH);

      if (!message) return res.status(400).json({ error: "Mensagem da confissão é obrigatória" });
      if (message.length > confessionLimit) {
        return res.status(400).json({
          error: `A confissão deve ter no máximo ${confessionLimit} caracteres`,
          maxLength: confessionLimit,
        });
      }

      const groupId = typeof req.body?.groupId === "string" ? req.body.groupId.trim() : "";
      if (!groupId) return res.status(400).json({ error: "Grupo inválido" });

      const eligibleGroupIds = await getConfessionsEnabledGroupIds();
      if (!eligibleGroupIds.includes(groupId)) {
        return res.status(400).json({ error: "Grupo inválido" });
      }

      const ip = getRequestIp(req);
      const cooldownKey = `${ip}:${groupId}`;
      const now = Date.now();
      const cooldownMs = CONFESSION_COOLDOWN_MINUTES * 60 * 1000;
      const lastUse = lastConfessionByIpAndGroup.get(cooldownKey) || 0;

      if (cooldownMs > 0 && now - lastUse < cooldownMs) {
        const waitSeconds = Math.ceil((cooldownMs - (now - lastUse)) / 1000);
        res.setHeader("Retry-After", waitSeconds);
        return res.status(429).json({
          error: `Aguarde ${Math.ceil(waitSeconds / 60)} minuto(s) antes de enviar outra confissão para este grupo.`,
          waitSeconds,
        });
      }

      const finalMessage = `Confissão anônima: ${message}`.slice(0, MAX_MESSAGE_LENGTH);
      await enqueueSendMessage({ groupId, type: "text", content: finalMessage });
      lastConfessionByIpAndGroup.set(cooldownKey, now);

      return res.json({ success: true, cooldownMinutes: CONFESSION_COOLDOWN_MINUTES });
    } catch (error) {
      console.error("Erro ao processar confissão:", error);
      return res.status(500).json({ error: "Erro ao enviar confissão" });
    }
  });
}
