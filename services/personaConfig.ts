import { prisma } from "./db.js";
import { GoogleGenAI } from "@google/genai";
import { AI_PERSONA_DEFAULT, AI_PERSONA_GUARDS } from "./personaConstants.js";
import { log } from "./logger.js";

interface PersonaCache {
  prompt: string | null;
  loadedAt: number;
}

let cache: PersonaCache = {
  prompt: null,
  loadedAt: 0,
};
const cacheTtlMs = 5 * 60 * 1000;

function buildPersonaPrompt(userPrompt?: string | null): string {
  const tone = (userPrompt || AI_PERSONA_DEFAULT).trim();
  return `${AI_PERSONA_GUARDS.trim()}\n\n${tone}`;
}

export async function getPersonaPrompt(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cache.prompt && now - cache.loadedAt < cacheTtlMs) {
    return cache.prompt;
  }
  const doc = await prisma.personaConfig.findFirst();
  const prompt = buildPersonaPrompt(doc?.prompt);
  cache = { prompt, loadedAt: now };
  return prompt;
}

async function validatePersonaPrompt(prompt: string): Promise<string> {
  const systemPrompt = buildPersonaPrompt(prompt);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY nao configurada para validar persona");
  }
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-preview";
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Gere uma frase de teste de bom dia sarcastica, curta, com ate 2 frases. Nao use labels ou listas.",
            },
          ],
        },
      ],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 100,
      },
    });
    const text = response.text?.trim();
    if (!text) throw new Error("Resposta vazia");
    return text;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Validação da persona falhou: ${msg}`, "warning");
    throw new Error(
      "A Gemini recusou ou retornou vazio com esse prompt. Ajuste o texto da persona."
    );
  }
}

export async function savePersonaPrompt(prompt: string): Promise<string> {
  await validatePersonaPrompt(prompt);
  const doc = await prisma.personaConfig.upsert({
    where: { id: 1 },
    update: { prompt },
    create: { id: 1, prompt },
  });
  cache = { prompt: buildPersonaPrompt(doc.prompt), loadedAt: Date.now() };
  return cache.prompt!;
}

export function getPersonaCache(): PersonaCache {
  return cache;
}
