import { prisma } from "./db.js";
import { GoogleGenAI } from "@google/genai";
import { AI_PERSONA_DEFAULT, AI_PERSONA_GUARDS } from "./personaConstants.js";
import { log } from "./logger.js";

function buildPersonaPrompt(userPrompt?: string | null): string {
  const tone = (userPrompt || AI_PERSONA_DEFAULT).trim();
  return `${AI_PERSONA_GUARDS.trim()}\n\n${tone}`;
}

export async function getPersonaPrompt(groupId?: string | null): Promise<string> {
  if (groupId) {
    const own = await prisma.personaConfig.findUnique({ where: { groupId } });
    if (own) return buildPersonaPrompt(own.prompt);
  }
  // findUnique rejects `null` as a value for a @unique field's where argument
  // (it can't itself guarantee uniqueness among nulls) — Prisma throws a
  // PrismaClientValidationError at the client level, not just a TS error, so
  // it can't be worked around with a cast. findFirst accepts `null` on any
  // field and resolves it correctly as `IS NULL`.
  const fallback = await prisma.personaConfig.findFirst({ where: { groupId: null } });
  return buildPersonaPrompt(fallback?.prompt);
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

export async function savePersonaPrompt(groupId: string | null, prompt: string): Promise<string> {
  await validatePersonaPrompt(prompt);
  if (groupId === null) {
    // upsert can't express "where groupId is null" for a @unique field (see
    // getPersonaPrompt above), so find-then-update/create manually. Postgres
    // unique indexes allow multiple NULLs, so this isn't airtight against a
    // concurrent racing create — acceptable at this project's scale.
    const existing = await prisma.personaConfig.findFirst({ where: { groupId: null } });
    const doc = existing
      ? await prisma.personaConfig.update({ where: { id: existing.id }, data: { prompt } })
      : await prisma.personaConfig.create({ data: { groupId: null, prompt } });
    return buildPersonaPrompt(doc.prompt);
  }
  const doc = await prisma.personaConfig.upsert({
    where: { groupId },
    update: { prompt },
    create: { groupId, prompt },
  });
  return buildPersonaPrompt(doc.prompt);
}
