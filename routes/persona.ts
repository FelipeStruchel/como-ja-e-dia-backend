import { Express } from "express";
import { requireAuth, requireGroupAdmin } from "../middleware/auth.js";
import { getPersonaPrompt, savePersonaPrompt } from "../services/personaConfig.js";
import { AI_PERSONA_DEFAULT } from "../services/personaConstants.js";
import { prisma } from "../services/db.js";

function resolveGroupIdParam(req: { query: Record<string, unknown> }): string | null {
  const raw = req.query.groupId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function registerPersonaRoutes(app: Express) {
  app.get(
    "/persona",
    requireGroupAdmin((req) => resolveGroupIdParam(req as any)),
    async (req, res) => {
      try {
        const groupId = resolveGroupIdParam(req);
        const doc = groupId ? await prisma.personaConfig.findUnique({ where: { groupId } }) : null;
        const prompt = doc?.prompt || (await getPersonaPrompt(groupId ?? undefined));
        res.json({ prompt, default: AI_PERSONA_DEFAULT.trim() });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro ao obter persona";
        res.status(500).json({ error: msg });
      }
    }
  );

  app.put(
    "/persona",
    requireGroupAdmin((req) => resolveGroupIdParam(req as any)),
    async (req, res) => {
      try {
        const prompt = (req.body?.prompt || "").toString();
        if (!prompt.trim()) {
          return res.status(400).json({ error: "Prompt não pode ser vazio" });
        }
        const groupId = resolveGroupIdParam(req);
        const saved = await savePersonaPrompt(groupId, prompt);
        res.json({ prompt: saved });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro ao salvar persona";
        res.status(400).json({ error: msg });
      }
    }
  );
}
