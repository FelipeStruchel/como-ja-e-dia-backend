import { Express } from "express";
import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import { requireAuth, requireGroupAdmin } from "../middleware/auth.js";
import { getAdminGroupIds } from "../services/groupService.js";

export function registerEventRoutes(
  app: Express,
  {
    prisma,
    isDbConnected,
    tz,
    moment: momentLib,
  }: {
    prisma: PrismaClient;
    isDbConnected: () => boolean;
    tz: typeof moment.tz;
    moment: typeof moment;
  }
) {
  app.get("/events", requireAuth, async (req, res) => {
    if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
    try {
      const userSlugs = req.user?.roles?.map((ur) => ur.role.slug) ?? [];
      const isSuperAdmin = userSlugs.includes("super_admin");
      const now = new Date();
      const scopeWhere = isSuperAdmin
        ? {}
        : { OR: [{ groupId: null }, { groupId: { in: await getAdminGroupIds(req.user!.id) } }] };
      const events = await prisma.event.findMany({
        where: { ...scopeWhere, announced: false, claimedBy: null, date: { gt: now } },
        orderBy: { date: "asc" },
      });
      res.json(events);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro";
      res.status(500).json({ error: msg });
    }
  });

  app.post(
    "/events",
    requireGroupAdmin((req) => ((req.body?.groupId as string) || "").trim() || null),
    async (req, res) => {
      if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
      try {
        const { name, date, groupId } = req.body;
        if (!name || !date)
          return res.status(400).json({ error: "name and date are required" });

        const resolvedGroupId = ((groupId as string) || "").trim() || null;

        let m = tz(date, "America/Sao_Paulo");
        if (!m.isValid()) {
          m = momentLib(date);
          if (!m.isValid())
            return res.status(400).json({ error: "Invalid date format" });
        }

        const nowSP = tz("America/Sao_Paulo");
        if (m.isBefore(nowSP)) {
          return res.status(400).json({ error: "Cannot create event in the past" });
        }

        const ev = await prisma.event.create({
          data: { name, date: m.toDate(), groupId: resolvedGroupId },
        });
        res.status(201).json(ev);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro";
        res.status(500).json({ error: msg });
      }
    }
  );

  app.delete(
    "/events/:id",
    requireGroupAdmin(async (req) => {
      const existing = await prisma.event.findUnique({ where: { id: req.params.id } });
      return existing?.groupId ?? null;
    }),
    async (req, res) => {
      if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
      try {
        await prisma.event.delete({ where: { id: req.params.id } });
        res.json({ success: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro";
        res.status(500).json({ error: msg });
      }
    }
  );
}
