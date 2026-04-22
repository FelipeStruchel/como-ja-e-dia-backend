import { GoogleGenAI } from "@google/genai";
import moment from "moment-timezone";
import "moment";
import { log } from "../services/logger.js";
import { getPersonaPrompt } from "./personaConfig.js";
import { AI_PERSONA_DEFAULT, AI_PERSONA_GUARDS } from "./personaConstants.js";

moment.locale("pt-br");

export { AI_PERSONA_DEFAULT, AI_PERSONA_GUARDS };
export const AI_PERSONA_BASE = AI_PERSONA_DEFAULT;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function _preview(str: unknown, n = 160): string {
  return String(str || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
}

export async function callGeminiChat(
  messages: ChatMessage[],
  _timeoutMs = 60000,
  maxOutputTokens: number | null = null,
  modelOverride: string | null = null,
  temperatureOverride: string | null = null
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-2.5-flash-preview";

  if (!apiKey) {
    log("GEMINI_API_KEY não configurada, pulando chamada à Gemini", "warning");
    return null;
  }

  const tokens =
    maxOutputTokens ??
    (process.env.GEMINI_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10)
      : 512);
  const temperature = temperatureOverride ? parseFloat(temperatureOverride) : 0.9;

  const systemParts = messages.filter((m) => m.role === "system");
  const systemInstruction = systemParts.map((m) => m.content).join("\n\n").trim() || undefined;
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    }));

  try {
    const sum = messages
      .slice(0, 5)
      .map((m) => _preview(m.content, 100))
      .join(" | ");
    log(
      `Gemini request -> model=${model} maxOutputTokens=${tokens} summary=[${sum}]`,
      "debug"
    );
  } catch {}

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: conversation,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        maxOutputTokens: tokens,
        temperature,
      },
    });

    const text = response.text?.trim();
    if (text) {
      log(`Gemini retornou (truncado): ${_preview(text, 240)}`, "debug");
      return text;
    }

    log("Gemini retornou resposta vazia", "warning");
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Erro ao chamar Gemini: ${msg}`, "error");
    return null;
  }
}

// Alias para compatibilidade com imports existentes
export { callGeminiChat as callOpenAIChat };

export async function generateAICaption({
  purpose = "greeting",
  names = [] as string[],
  timeStr = null as string | null,
  announceEvents = false,
  noEvents = false,
  dayOfWeek = null as string | null,
  countdown = null as { days: number; hours: number; minutes: number } | null,
  eventsTodayDetails = null as string | null,
  nearestDateStr = null as string | null,
  todayDateStr = null as string | null,
  personaOverride = null as string | null,
  greetingHint = null as string | null,
} = {}): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const personaPrompt = personaOverride
    ? personaOverride.trim()
    : await getPersonaPrompt();
  const eventList = names.length ? names.join(", ") : "nenhum evento";
  const greetingLine = greetingHint
    ? `Cumprimente explicitamente com "${greetingHint}" de acordo com o horario.`
    : "Cumprimente com bom dia/boa tarde/boa noite conforme o horario de Brasil.";
  const userMsgParts: string[] = [];

  if (purpose === "greeting") {
    if (announceEvents && noEvents) {
      userMsgParts.push(
        "Gere uma legenda curta (1-2 frases) em portugues brasileiro para um grupo de WhatsApp dizendo que nao ha eventos hoje. Convide a galera a cadastrar no link: https://vmi2849405.contaboserver.net. Seja acido, engraçado e levemente ofensivo conforme a persona. Use no maximo 2 emojis. RETORNE SOMENTE a legenda final, sem explicacoes, sem introducoes como 'claro' ou 'vou gerar', sem passos."
      );
      userMsgParts.push(greetingLine);
      if (dayOfWeek) userMsgParts.push(`Contexto: hoje e ${dayOfWeek}.`);
      userMsgParts.push("Tente ser engraçado e sarcastico conforme a persona acima.");
    } else if (announceEvents && !noEvents) {
      userMsgParts.push(
        `Gere uma legenda curta (1-3 frases) em portugues brasileiro dando bom dia/boa tarde/boa noite conforme o horario.
                Caso o evento seja hoje informe que o evento e hoje; caso contrario NAO diga que o evento ja comecou ou que e hoje, apenas mencione os proximos eventos, se atente a data do evento e contextos de data passados: ${eventList}${
                  timeStr ? " (" + timeStr + ")" : ""
                }. Seja acido, engraçado, sarcastico e leve. Evite metaforas inspiracionais. Maximo 2 emojis. RETORNE SOMENTE a legenda final, sem explicacoes, sem introducoes como 'claro' ou 'vou gerar', sem passos.`
      );
      userMsgParts.push(greetingLine);
      if (dayOfWeek) userMsgParts.push(`Contexto: hoje e ${dayOfWeek}.`);
      userMsgParts.push(
        "Fale dos eventos usando o tom da persona passada e seja direto ao anunciar."
      );
    } else {
      userMsgParts.push(
        "Gere uma legenda curta (1-2 frases) em portugues brasileiro apenas para dar saudacao com humor (sem mencionar eventos). Seja acido, engraçado e leve; maximo 2 emojis. RETORNE SOMENTE a legenda final, sem explicacoes, sem introducoes como 'claro' ou 'vou gerar', sem passos."
      );
      userMsgParts.push(greetingLine);
      if (dayOfWeek) userMsgParts.push(`Contexto: hoje e ${dayOfWeek}.`);
      userMsgParts.push("Tente ser engraçado e sarcastico conforme a persona acima.");
    }
  } else if (purpose === "event") {
    userMsgParts.push(
      `Gere uma mensagem de anuncio para o grupo dizendo que e hora do evento ${eventList}${
        timeStr ? " (" + timeStr + ")" : ""
      }. A mensagem deve conter: 1) uma frase clara anunciando que o evento comecou; 2) uma observacao curta e sarcastica (1 frase) comentando a situacao — tipo uma zoeira rapida sobre o evento ou os participantes. Curta, sarcastica, com humor acido, em portugues brasileiro. Ate 2 emojis. RETORNE SOMENTE a mensagem final (duas frases no maximo), sem explicacoes.`
    );
    userMsgParts.push("Tente ser engraçado e sarcastico conforme a persona acima.");
  }

  if (purpose === "greeting") {
    userMsgParts.push("Se possivel, com um toque de crueldade divertida (sem exagero).");
    userMsgParts.push(
      "Contexto importante: se o evento ainda nao for hoje, nao diga parabens nem que ja comecou; deixe claro que ainda falta e inclua a contagem."
    );
    if (announceEvents && eventsTodayDetails) {
      userMsgParts.push(`Hoje tem: ${eventsTodayDetails}. Mencione todos com seus horarios.`);
    } else if (announceEvents && nearestDateStr) {
      userMsgParts.push(
        `Proximo evento em: ${nearestDateStr}. Nao diga que ja comecou; deixe claro que ainda falta.`
      );
    }
    if (
      announceEvents &&
      countdown &&
      typeof countdown.days === "number" &&
      typeof countdown.hours === "number" &&
      typeof countdown.minutes === "number"
    ) {
      userMsgParts.push(
        `Obrigatorio: inclua no final a contagem de tempo restante neste formato exato: "Faltam ${countdown.days} dias, ${countdown.hours} horas e ${countdown.minutes} minutos".`
      );
    }
  }
  if (todayDateStr)
    userMsgParts.push(`Data de hoje (America/Sao_Paulo): ${todayDateStr}.`);
  if (purpose === "event" && dayOfWeek)
    userMsgParts.push(`Contexto: hoje e ${dayOfWeek}.`);
  userMsgParts.push(
    "Inclua pelo menos uma observacao sarcastica ou piada curta; evite resposta generica/obvia; mantenha tom acido da persona."
  );

  const msgs: ChatMessage[] = [
    { role: "system", content: personaPrompt },
    { role: "user", content: userMsgParts.join("\n") },
  ];

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-preview";
  const temp = process.env.GEMINI_TEMPERATURE || "0.9";
  return callGeminiChat(msgs, 60000, null, model, temp);
}

export async function generateAIAnalysis(
  messagesArray: Array<{
    body?: string;
    bodySanitized?: string;
    senderName?: string;
    author?: string;
    from?: string;
  }>
): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const personaPrompt = await getPersonaPrompt();

  function redactNumbers(text: string | null | undefined): string {
    if (!text) return text ?? "";
    try {
      let s = String(text);
      s = s.replace(/\+?\d[\d\s().\-]{4,}\d/g, "[NUMERO_REMOVIDO]");
      s = s.replace(/\d{4,}/g, "[NUMERO_REMOVIDO]");
      return s;
    } catch {
      return text;
    }
  }

  const safeMessages = messagesArray
    .map((m, i) => {
      const sender = m.senderName || m.author || m.from || "desconhecido";
      const raw = m.bodySanitized || m.body || "";
      const redacted = redactNumbers(raw);
      const txt = redacted
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\s+/g, " ")
        .trim();
      return `${i + 1}. [${sender}] ${txt.slice(0, 1000)}`;
    })
    .join("\n");

  const userPromptFinal =
    `Você vai analisar as mensagens abaixo e responder com uma análise curta e afiada no estilo da persona (ácido, sarcástico, leve ofensa). Procure algo para zoar nas mensagens, resuma os principais pontos e dê 2-3 observações engraçadas. Não seja muito longo (3-4 frases). IMPORTANTE: NÚMEROS TELEFÔNICOS E DADOS NUMÉRICOS FORAM REMOVIDOS DO TEXTO (substituídos por [NUMERO_REMOVIDO]). NÃO MENCIONE, NÃO TENTE RECONSTRUIR OU COMENTAR NENHUM NÚMERO. \nMensagens:\n${safeMessages} \n FIM DAS MENSAGENS. \n` +
    " Inclua pelo menos UMA piada/observacao sarcastica; evite resposta generica/obvia; mantenha tom acido; RETORNE SOMENTE o texto final, sem explicacoes, sem preambulo." +
    "Formato: escreva 1–2 frases, sem labels (ex.: \"Resumo:\", \"Observacao:\") e sem topicos. Só o texto final.";

  const msgs: ChatMessage[] = [
    { role: "system", content: personaPrompt },
    { role: "user", content: userPromptFinal },
  ];

  const analyseTokens = parseInt(
    process.env.GEMINI_MAX_OUTPUT_TOKENS_ANALYSE ||
      process.env.GEMINI_MAX_OUTPUT_TOKENS ||
      "1024",
    10
  );
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-preview";
  const temp = process.env.GEMINI_TEMPERATURE || "0.9";
  return callGeminiChat(msgs, 60000, analyseTokens, model, temp);
}
