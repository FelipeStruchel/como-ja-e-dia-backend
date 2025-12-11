import { Trigger } from "../models/trigger.js";
import { requireAuth } from "../middleware/auth.js";

function parseTriggerPayload(body) {
    const safe = {};
    safe.name = (body.name || "").toString().trim();
    safe.phrases = Array.isArray(body.phrases)
        ? body.phrases
              .map((p) => (p || "").toString().trim())
              .filter((p) => p.length > 0)
        : [];
    safe.matchType = ["exact", "contains", "regex"].includes(body.matchType)
        ? body.matchType
        : "exact";
    safe.caseSensitive = !!body.caseSensitive;
    safe.normalizeAccents =
        typeof body.normalizeAccents === "boolean" ? body.normalizeAccents : true;
    safe.wholeWord = !!body.wholeWord;
    safe.responseType = ["text", "image", "video"].includes(body.responseType)
        ? body.responseType
        : "text";
    safe.responseText = (body.responseText || "").toString();
    safe.responseMediaUrl = (body.responseMediaUrl || "").toString();
    safe.replyMode = ["reply", "new"].includes(body.replyMode)
        ? body.replyMode
        : "reply";
    safe.mentionSender = !!body.mentionSender;
    safe.chancePercent = Math.min(
        100,
        Math.max(0, Number.parseFloat(body.chancePercent ?? 100) || 0)
    );
    safe.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    safe.maxUses = body.maxUses ? Number.parseInt(body.maxUses, 10) || null : null;
    safe.cooldownSeconds = Math.max(
        0,
        Number.parseInt(body.cooldownSeconds || 0, 10)
    );
    safe.cooldownPerUserSeconds = Math.max(
        0,
        Number.parseInt(body.cooldownPerUserSeconds || 0, 10)
    );
    safe.active = body.active !== undefined ? !!body.active : true;
    return safe;
}

function validateTriggerPayload(payload) {
    if (!payload.phrases || payload.phrases.length === 0) {
        throw new Error("Pelo menos uma frase/palavra é obrigatória");
    }
    if (payload.responseType === "text" && !payload.responseText.trim()) {
        throw new Error("Resposta de texto é obrigatória para responseType=text");
    }
    if (
        (payload.responseType === "image" || payload.responseType === "video") &&
        !payload.responseMediaUrl
    ) {
        throw new Error("responseMediaUrl é obrigatório para mídia");
    }
    if (payload.expiresAt && isNaN(payload.expiresAt.getTime())) {
        throw new Error("Data de expiração inválida");
    }
    if (payload.maxUses !== null && payload.maxUses < 0) {
        throw new Error("maxUses deve ser >= 0");
    }
}

export function registerTriggerRoutes(app) {
    app.get("/triggers", requireAuth, async (req, res) => {
        try {
            const list = await Trigger.find().sort({ createdAt: -1 }).lean();
            res.json(list);
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao listar triggers" });
        }
    });

    app.post("/triggers", requireAuth, async (req, res) => {
        try {
            const payload = parseTriggerPayload(req.body || {});
            validateTriggerPayload(payload);
            const created = await Trigger.create(payload);
            res.status(201).json(created);
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao criar trigger" });
        }
    });

    app.put("/triggers/:id", requireAuth, async (req, res) => {
        try {
            const payload = parseTriggerPayload(req.body || {});
            validateTriggerPayload(payload);
            const updated = await Trigger.findByIdAndUpdate(req.params.id, payload, {
                new: true,
            }).lean();
            if (!updated) return res.status(404).json({ error: "Trigger não encontrada" });
            res.json(updated);
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao atualizar trigger" });
        }
    });

    app.delete("/triggers/:id", requireAuth, async (req, res) => {
        try {
            const deleted = await Trigger.findByIdAndDelete(req.params.id);
            if (!deleted) return res.status(404).json({ error: "Trigger não encontrada" });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao remover trigger" });
        }
    });
}
