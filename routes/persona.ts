import { Express } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getPersonaPrompt,
  savePersonaPrompt,
  getPersonaCache,
} from "../services/personaConfig.js";
import { AI_PERSONA_DEFAULT } from "../services/personaConstants.js";
import { prisma } from "../services/db.js";

export function registerPersonaRoutes(app: Express) {
  app.get("/persona", requireAuth, async (_req, res) => {
    try {
      const doc = await prisma.personaConfig.findFirst();
      const prompt = doc?.prompt || AI_PERSONA_DEFAULT.trim();
      res.json({
        prompt,
        cache: getPersonaCache(),
        default: AI_PERSONA_DEFAULT.trim(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao obter persona";
      res.status(500).json({ error: msg });
    }
  });

  app.put("/persona", requireAuth, async (req, res) => {
    try {
      const prompt = (req.body?.prompt || "").toString();
      if (!prompt.trim()) {
        return res.status(400).json({ error: "Prompt não pode ser vazio" });
      }
      const saved = await savePersonaPrompt(prompt);
      res.json({ prompt: saved });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao salvar persona";
      res.status(400).json({ error: msg });
    }
  });
}
