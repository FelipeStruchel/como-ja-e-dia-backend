import { requireAuth } from "../middleware/auth.js";
import { Schedule } from "../models/schedule.js";
import { clearRepeat, registerRepeat, resyncSchedules } from "../services/scheduledJobs.js";

function parseSchedule(body) {
    const safe = {};
    safe.name = (body.name || "").toString().trim() || "Mensagem";
    safe.kind = ["greeting"].includes(body.kind) ? body.kind : "greeting";
    const inferMediaType = (url) => {
        const lower = (url || "").toLowerCase();
        const videoExt = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
        if (videoExt.some((ext) => lower.endsWith(ext))) return "video";
        return "image";
    };
    const rawType = (body.type || "").toString();
    safe.mediaUrl = (body.mediaUrl || "").toString().trim();
    const inferredType =
        rawType === "text"
            ? "text"
            : ["image", "video"].includes(rawType)
            ? rawType
            : inferMediaType(safe.mediaUrl);
    safe.type = inferredType || "text";
    safe.textContent = (body.textContent || "").toString();
    safe.captionMode = ["auto", "custom", "none"].includes(body.captionMode)
        ? body.captionMode
        : "auto";
    safe.customCaption = (body.customCaption || "").toString();
    safe.includeIntro = body.includeIntro !== undefined ? !!body.includeIntro : true;
    safe.includeRandomPool =
        body.includeRandomPool !== undefined ? !!body.includeRandomPool : true;
    safe.announceEvents =
        body.announceEvents !== undefined ? !!body.announceEvents : false;
    safe.personaPrompt = (body.personaPrompt || "").toString();
    safe.useCronOverride = !!body.useCronOverride;
    safe.cron = (body.cron || "").toString().trim();
    safe.time = (body.time || "06:00").toString().trim();
    safe.timezone = "America/Sao_Paulo";
    safe.startDate = body.startDate ? new Date(body.startDate) : null;
    safe.endDate = body.endDate ? new Date(body.endDate) : null;
    safe.daysOfWeek = Array.isArray(body.daysOfWeek)
        ? body.daysOfWeek.map((d) => parseInt(d, 10)).filter((n) => !Number.isNaN(n))
        : [];
    safe.active = body.active !== undefined ? !!body.active : true;

    // Se não usar cron override, monta cron a partir de hora/dias
    if (!safe.useCronOverride) {
        const [hh = "06", mm = "00"] = safe.time.split(":");
        const days =
            Array.isArray(safe.daysOfWeek) && safe.daysOfWeek.length
                ? safe.daysOfWeek.join(",")
                : "*";
        safe.cron = `${mm} ${hh} * * ${days}`;
    }
    return safe;
}

export function registerScheduleRoutes(app) {
    app.get("/schedules", requireAuth, async (_req, res) => {
        try {
            const list = await Schedule.find().sort({ createdAt: -1 }).lean();
            res.json(list);
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao listar schedules" });
        }
    });

    app.post("/schedules", requireAuth, async (req, res) => {
        try {
            const payload = parseSchedule(req.body || {});
            if (!payload.cron) return res.status(400).json({ error: "cron é obrigatório" });
            const created = await Schedule.create(payload);
            await registerRepeat(created);
            res.status(201).json(created);
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao criar schedule" });
        }
    });

    app.put("/schedules/:id", requireAuth, async (req, res) => {
        try {
            const payload = parseSchedule(req.body || {});
            if (!payload.cron) return res.status(400).json({ error: "cron é obrigatório" });
            const existing = await Schedule.findById(req.params.id);
            if (!existing) return res.status(404).json({ error: "Schedule não encontrado" });
            await clearRepeat(existing);
            Object.assign(existing, payload);
            await existing.save();
            await registerRepeat(existing);
            res.json(existing);
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao atualizar schedule" });
        }
    });

    app.delete("/schedules/:id", requireAuth, async (req, res) => {
        try {
            const existing = await Schedule.findById(req.params.id);
            if (!existing) return res.status(404).json({ error: "Schedule não encontrado" });
            await clearRepeat(existing);
            await existing.deleteOne();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao remover schedule" });
        }
    });

    app.post("/schedules/resync", requireAuth, async (_req, res) => {
        try {
            await resyncSchedules();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao resync schedules" });
        }
    });
}
