import { Express } from "express";
import { Prisma } from "@prisma/client";
import { requireGroupAdmin } from "../middleware/auth.js";
import { savePersonaPrompt } from "../services/personaConfig.js";
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
        // Always look up the row directly for whatever groupId resolves to
        // (including null for the global fallback) and return the RAW
        // prompt text — never through getPersonaPrompt, which exists to
        // produce the guards-wrapped production text, not the editable raw
        // text the admin UI shows/edits.
        const doc = await prisma.personaConfig.findUnique({
          where: { groupId } as unknown as Prisma.PersonaConfigWhereUniqueInput,
        });
        const prompt = doc?.prompt || AI_PERSONA_DEFAULT.trim();
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
