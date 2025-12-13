import { requireAuth } from "../middleware/auth.js";
import { getPersonaPrompt, savePersonaPrompt, getPersonaCache } from "../services/personaConfig.js";
import { AI_PERSONA_DEFAULT } from "../services/ai.js";

export function registerPersonaRoutes(app) {
    app.get("/persona", requireAuth, async (_req, res) => {
        try {
            const prompt = await getPersonaPrompt();
            res.json({
                prompt,
                cache: getPersonaCache(),
                default: AI_PERSONA_DEFAULT.trim(),
            });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao obter persona" });
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
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao salvar persona" });
        }
    });
}
