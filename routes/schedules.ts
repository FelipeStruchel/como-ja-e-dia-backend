import { Express } from "express";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../services/db.js";
import {
  clearRepeat,
  registerRepeat,
  resyncSchedules,
} from "../services/scheduledJobs.js";

function parseSchedule(body: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  safe.name = ((body.name || "") as string).toString().trim() || "Mensagem";
  safe.kind = ["greeting"].includes(body.kind as string) ? body.kind : "greeting";

  const inferMediaType = (url: string) => {
    const lower = (url || "").toLowerCase();
    const videoExt = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
    if (videoExt.some((ext) => lower.endsWith(ext))) return "video";
    return "image";
  };

  const rawType = ((body.type || "") as string).toString();
  safe.mediaUrl = ((body.mediaUrl || "") as string).toString().trim();
  const inferredType =
    rawType === "text"
      ? "text"
      : ["image", "video"].includes(rawType)
        ? rawType
        : inferMediaType(safe.mediaUrl as string);
  safe.type = inferredType || "text";
  safe.textContent = ((body.textContent || "") as string).toString();
  safe.captionMode = ["auto", "custom", "none"].includes(body.captionMode as string)
    ? body.captionMode
    : "auto";
  safe.customCaption = ((body.customCaption || "") as string).toString();
  safe.includeIntro = body.includeIntro !== undefined ? !!body.includeIntro : true;
  safe.includeRandomPool =
    body.includeRandomPool !== undefined ? !!body.includeRandomPool : true;
  safe.announceEvents = body.announceEvents !== undefined ? !!body.announceEvents : false;
  safe.personaPrompt = ((body.personaPrompt || "") as string).toString();
  safe.useCronOverride = !!body.useCronOverride;
  safe.cron = ((body.cron || "") as string).toString().trim();
  safe.time = ((body.time || "06:00") as string).toString().trim();
  safe.timezone = "America/Sao_Paulo";
  safe.startDate = body.startDate ? new Date(body.startDate as string) : null;
  safe.endDate = body.endDate ? new Date(body.endDate as string) : null;
  safe.daysOfWeek = Array.isArray(body.daysOfWeek)
    ? (body.daysOfWeek as unknown[]).map((d) => parseInt(d as string, 10)).filter((n) => !Number.isNaN(n))
    : [];
  safe.active = body.active !== undefined ? !!body.active : true;

  if (!safe.useCronOverride) {
    const [hh = "06", mm = "00"] = (safe.time as string).split(":");
    const days =
      Array.isArray(safe.daysOfWeek) && (safe.daysOfWeek as number[]).length
        ? (safe.daysOfWeek as number[]).join(",")
        : "*";
    safe.cron = `${mm} ${hh} * * ${days}`;
  }
  return safe;
}

export function registerScheduleRoutes(app: Express) {
  app.get("/schedules", requireAuth, async (_req, res) => {
    try {
      const list = await prisma.schedule.findMany({ orderBy: { createdAt: "desc" } });
      res.json(list);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar schedules";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/schedules", requireAuth, async (req, res) => {
    try {
      const payload = parseSchedule(req.body || {});
      if (!payload.cron) return res.status(400).json({ error: "cron é obrigatório" });
      const created = await prisma.schedule.create({ data: payload as Parameters<typeof prisma.schedule.create>[0]["data"] });
      await registerRepeat(created);
      res.status(201).json(created);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao criar schedule";
      res.status(400).json({ error: msg });
    }
  });

  app.put("/schedules/:id", requireAuth, async (req, res) => {
    try {
      const payload = parseSchedule(req.body || {});
      if (!payload.cron) return res.status(400).json({ error: "cron é obrigatório" });
      const existing = await prisma.schedule.findUnique({ where: { id: req.params.id } });
      if (!existing) return res.status(404).json({ error: "Schedule não encontrado" });
      await clearRepeat(existing);
      const updated = await prisma.schedule.update({
        where: { id: req.params.id },
        data: payload as Parameters<typeof prisma.schedule.update>[0]["data"],
      });
      await registerRepeat(updated);
      res.json(updated);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao atualizar schedule";
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/schedules/:id", requireAuth, async (req, res) => {
    try {
      const existing = await prisma.schedule.findUnique({ where: { id: req.params.id } });
      if (!existing) return res.status(404).json({ error: "Schedule não encontrado" });
      await clearRepeat(existing);
      await prisma.schedule.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao remover schedule";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/schedules/resync", requireAuth, async (_req, res) => {
    try {
      await resyncSchedules();
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao resync schedules";
      res.status(500).json({ error: msg });
    }
  });
}
