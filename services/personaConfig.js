import { PersonaConfig } from "../models/personaConfig.js";
import { OpenAI } from "openai";
import { AI_PERSONA_DEFAULT, AI_PERSONA_GUARDS } from "./personaConstants.js";
import { log } from "./logger.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let cache = {
    prompt: null,
    loadedAt: 0,
};
const cacheTtlMs = 5 * 60 * 1000;

function buildPersonaPrompt(userPrompt) {
    const tone = (userPrompt || AI_PERSONA_DEFAULT).trim();
    return `${AI_PERSONA_GUARDS.trim()}\n\n${tone}`;
}

export async function getPersonaPrompt(force = false) {
    const now = Date.now();
    if (!force && cache.prompt && now - cache.loadedAt < cacheTtlMs) {
        return cache.prompt;
    }
    const doc = await PersonaConfig.findOne().lean();
    const prompt = buildPersonaPrompt(doc?.prompt);
    cache = { prompt, loadedAt: now };
    return prompt;
}

async function validatePersonaPrompt(prompt) {
    const systemPrompt = buildPersonaPrompt(prompt);
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY nao configurada para validar persona");
    }
    try {
        const resp = await openai.responses.create({
            model: process.env.OPENAI_MODEL_GREET || "gpt-5-mini",
            instructions: systemPrompt,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: "Gere uma frase de teste de bom dia sarcastica, curta, com ate 2 frases. Nao use labels ou listas.",
                        },
                    ],
                },
            ],
            max_output_tokens: 100,
        });
        const text =
            resp?.output_text ||
            resp?.output?.[0]?.content?.[0]?.text ||
            null;
        if (!text || !text.trim()) throw new Error("Resposta vazia");
        return text.trim();
    } catch (err) {
        log(`Validação da persona falhou: ${err.message}`, "warning");
        throw new Error(
            "A OpenAI recusou ou retornou vazio com esse prompt. Ajuste o texto da persona."
        );
    }
}

export async function savePersonaPrompt(prompt) {
    await validatePersonaPrompt(prompt);
    const doc = await PersonaConfig.findOneAndUpdate(
        {},
        { prompt },
        { upsert: true, new: true }
    );
    cache = { prompt: buildPersonaPrompt(doc.prompt), loadedAt: Date.now() };
    return cache.prompt;
}

export function getPersonaCache() {
    return cache;
}
