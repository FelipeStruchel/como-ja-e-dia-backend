import { OpenAI } from "openai";
import moment from "moment-timezone";
import "moment/locale/pt-br.js";
import { log } from "../services/logger.js";

moment.locale("pt-br");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export const AI_PERSONA = `
    Você é um bot de WhatsApp criado por Grego.
    Fala como aquele amigo sarcástico que sempre tem uma resposta pronta.
    Humor ácido, direto e às vezes cruel, mas nunca forçado.
    Prefere zoar a situação do que explicar qualquer coisa.
    Nada de frase montada, piada pronta, metáfora “engraçadinha” ou texto com cabeçalho.
    PROIBIDO usar labels como "Resumo:", "Observação:", "Nota:", "Outra:" ou similares.
    Não pareça roteiro: nada de enumerações, bullets, tópicos ou títulos.
    Fala curto, em PT-BR, com gírias leves. Máximo 2 frases. Máximo 2 emojis (só se deixarem mais engraçado).
    Não peça desculpas. Não diga que é bot/IA. Não eduque. Não explique o óbvio.
    Evite soar “fofo” ou “bonzinho”; sarcasmo seco é a base.
    Quando “filosofar”, é no tom de saco cheio, não de coach.
    Não ataque grupos protegidos; zoe a situação ou a própria pessoa que fala, de leve.
    Responda APENAS com a mensagem final, sem preâmbulo e sem formatação de relatório.
`;

function _preview(str, n = 160) {
    return String(str || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, n);
}

function _normalizeMessages(raw) {
    return (raw || [])
        .map((m) => ({
            role: m?.role || "user",
            content:
                typeof m?.content === "string"
                    ? m.content
                    : String(m?.content ?? ""),
        }))
        .filter((m) => m.content.trim());
}

function _extractResponseText(resp) {
    if (resp?.output_text && resp.output_text.trim())
        return resp.output_text.trim();

    if (Array.isArray(resp?.output)) {
        for (const item of resp.output) {
            if (Array.isArray(item?.content)) {
                for (const c of item.content) {
                    if (typeof c?.text === "string" && c.text.trim())
                        return c.text.trim();
                    if (
                        c?.type === "output_text" &&
                        typeof c?.text === "string" &&
                        c.text.trim()
                    )
                        return c.text.trim();
                    if (
                        c?.type === "refusal" &&
                        typeof c?.text === "string" &&
                        c.text.trim()
                    )
                        return c.text.trim();
                }
            }
        }
    }

    if (Array.isArray(resp?.data)) {
        for (const d of resp.data) {
            if (Array.isArray(d?.content)) {
                for (const c of d.content) {
                    if (typeof c?.text === "string" && c.text.trim())
                        return c.text.trim();
                }
            }
        }
    }
    return null;
}

export async function callOpenAIChat(
    messages,
    _timeoutMs = 60000,
    maxCompletionTokensOverride = null,
    modelOverride = null,
    temperatureOverride = null
) {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
    if (!OPENAI_API_KEY) {
        log("OPENAI_API_KEY não configurada, pulando chamada à OpenAI", "warning");
        return null;
    }

    const modelInUse = modelOverride || OPENAI_MODEL;
    const maxOutputTokens =
        maxCompletionTokensOverride ??
        (process.env.OPENAI_MAX_COMPLETION_TOKENS
            ? parseInt(process.env.OPENAI_MAX_COMPLETION_TOKENS, 10)
            : 512);

    const msgs = _normalizeMessages(messages);
    const systemInstructions = msgs
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n")
        .trim();
    const convo = msgs
        .filter((m) => m.role !== "system")
        .map((m) => ({
            role: m.role,
            content: [{ type: "input_text", text: m.content }],
        }));

    try {
        const sum = msgs
            .slice(0, 5)
            .map((m) => _preview(m.content, 100))
            .join(" | ");
        log(
            `OpenAI request -> model=${modelInUse} max_output_tokens=${maxOutputTokens} messagesSummary=[${sum}]`,
            "debug"
        );
    } catch {}

    try {
        const resp = await openai.responses.create({
            model: modelInUse,
            ...(systemInstructions ? { instructions: systemInstructions } : {}),
            input: convo,
            text: { format: { type: "text" } },
            max_output_tokens: maxOutputTokens,
        });

        const text = _extractResponseText(resp);
        if (text && text.trim()) {
            log(
                `OpenAI returned content (truncated): ${_preview(text, 240)}`,
                "debug"
            );
            return text.trim();
        }

        try {
            const outputTypes = Array.isArray(resp?.output)
                ? resp.output.map((o) => o?.type || "unknown")
                : null;
            const contentTypes = Array.isArray(resp?.output)
                ? resp.output.flatMap((o) =>
                      (o?.content || []).map((c) => c?.type || typeof c)
                  )
                : null;

            log(
                `OpenAI vazio. status=${resp?.status} reason=${
                    resp?.incomplete_details?.reason || "n/a"
                } ` +
                    `outputTypes=${JSON.stringify(
                        outputTypes
                    )} contentTypes=${JSON.stringify(contentTypes)} ` +
                    `usage=${JSON.stringify(resp?.usage || {})}`,
                "warning"
            );
        } catch {}

        return null;
    } catch (err) {
        log(`Erro ao chamar OpenAI: ${err.message}`, "error");
        return null;
    }
}

export const AI_PERSONA_BASE = AI_PERSONA;

export async function generateAICaption({
    purpose = "greeting",
    names = [],
    timeStr = null,
    noEvents = false,
    dayOfWeek = null,
    countdown = null,
    eventsTodayDetails = null,
    nearestDateStr = null,
    todayDateStr = null,
}) {
    if (!process.env.OPENAI_API_KEY) return null;
    const eventList = names.length ? names.join(", ") : "nenhum evento";
    const userMsgParts = [];
    if (purpose === "greeting") {
        if (noEvents) {
            userMsgParts.push(
                `Gere uma legenda curta (1-2 frases) em português brasileiro para um grupo de WhatsApp dizendo que não há eventos hoje. Convide a galera a cadastrar no link: https://vmi2849405.contaboserver.net. Seja ácido, engraçado e levemente ofensivo conforme a persona. Use no máximo 2 emojis. RETORNE SOMENTE a legenda final, sem explicações, sem introduções como 'claro' ou 'vou gerar', sem passos.`
            );
            if (dayOfWeek) userMsgParts.push(`Contexto: hoje é ${dayOfWeek}.`);
            userMsgParts.push(
                "Tente ser engraçado e sarcástico conforme a persona acima."
            );
        } else {
            userMsgParts.push(
                `Gere uma legenda curta (1-3 frases) em português brasileiro dando bom dia ou boa noite ( dependendo do contexto de data e horario passados via Contexto: hoje é ... )
                caso o evento seja hoje informe que o evento é hoje, caso contrario NÃO diga que o evento ja comecou ou que é hoje, apenasw 
                mencionando os eventos proximos eventos, se atente a data do evento e contextos de data passados: ${eventList}${
                    timeStr ? " (" + timeStr + ")" : ""
                }. Seja ácido, engraçado, sarcástico e leve. Evite metáforas inspiracionais. Máximo 2 emojis. RETORNE SOMENTE a legenda final, sem explicações, sem introduções como 'claro' ou 'vou gerar', sem passos.`
            );
            if (dayOfWeek) userMsgParts.push(`Contexto: hoje é ${dayOfWeek}.`);
            userMsgParts.push(
                "Tente ser engraçado e sarcástico conforme a persona acima."
            );
        }
    } else if (purpose === "event") {
        userMsgParts.push(
            `Gere uma mensagem de anúncio para o grupo dizendo que é hora do evento ${eventList}${
                timeStr ? " (" + timeStr + ")" : ""
            }. A mensagem deve conter: 1) uma frase clara anunciando que o evento começou; 2) uma observação curta e sarcástica (1 frase) comentando a situação — tipo uma zoeira rápida sobre o evento ou os participantes. Curta, sarcástica, com humor ácido, em português brasileiro. Até 2 emojis. RETORNE SOMENTE a mensagem final (duas frases no máximo), sem explicações.`
        );
        userMsgParts.push(
            "Tente ser engraçado e sarcástico conforme a persona acima."
        );
    }

    if (purpose === "greeting") {
        userMsgParts.push(
            "Se possivel, com um toque de crueldade divertida (sem exagero)."
        );
        userMsgParts.push(
            "Contexto importante: se o evento ainda nao for hoje, nao diga parabens nem que ja comecou; deixe claro que ainda falta e inclua a contagem."
        );
        if (eventsTodayDetails) {
            userMsgParts.push(
                `Hoje tem: ${eventsTodayDetails}. Mencione todos com seus horarios.`
            );
        } else if (nearestDateStr) {
            userMsgParts.push(
                `Proximo evento em: ${nearestDateStr}. Não diga que ja comecou; deixe claro que ainda falta.`
            );
        }
        if (
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
        userMsgParts.push(`Contexto: hoje é ${dayOfWeek}.`);
    userMsgParts.push(
        "Inclua pelo menos uma observacao sarcastica ou piada curta; evite resposta generica/obvia; mantenha tom acido da persona."
    );
    const messages = [
        { role: "system", content: AI_PERSONA },
        { role: "user", content: userMsgParts.join("\n") },
    ];

    const modelForCaption = process.env.OPENAI_MODEL_GREET || "gpt-5-mini";
    const tempForCaption = process.env.OPENAI_TEMPERATURE_GREET || "0.9";
    const raw = await callOpenAIChat(
        messages,
        60000,
        null,
        modelForCaption,
        tempForCaption
    );
    return raw;
}

export async function generateAIAnalysis(messagesArray) {
    if (!process.env.OPENAI_API_KEY) return null;
    function redactNumbers(text) {
        if (!text) return text;
        try {
            let s = String(text);
            s = s.replace(/\+?\d[\d\s().\-]{4,}\d/g, "[NÚMERO_REMOVIDO]");
            s = s.replace(/\d{4,}/g, "[NÚMERO_REMOVIDO]");
            return s;
        } catch (e) {
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

    const userPrompt = `Você vai analisar as mensagens abaixo e responder com uma análise curta e afiada no estilo da persona (ácido, sarcástico, leve ofensa). Procure algo para zoar nas mensagens, resuma os principais pontos e dê 2-3 observações engraçadas. Não seja muito longo (3-4 frases). IMPORTANTE: NÚMEROS TELEFÔNICOS E DADOS NUMÉRICOS FORAM REMOVIDOS DO TEXTO (substituídos por [NÚMERO_REMOVIDO]). NÃO MENCIONE, NÃO TENTE RECONSTRUIR OU COMENTAR NENHUM NÚMERO. \nMensagens:\n${safeMessages} \n FIM DAS MENSAGENS. \n`;

    const userPromptFinal =
        userPrompt +
        " Inclua pelo menos UMA piada/observacao sarcastica; evite resposta generica/obvia; mantenha tom acido; RETORNE SOMENTE o texto final, sem explicacoes, sem preambulo." +
        "Formato: escreva 1–2 frases, sem labels (ex.: “Resumo:”, “Observação:”) e sem tópicos. Só o texto final.";
    const messages = [
        { role: "system", content: AI_PERSONA },
        { role: "user", content: userPromptFinal },
    ];

    const analyseTokens = parseInt(
        process.env.OPENAI_MAX_COMPLETION_TOKENS_ANALYSE ||
            process.env.OPENAI_MAX_COMPLETION_TOKENS ||
            "1024",
        10
    );
    const modelForAnalysis = process.env.OPENAI_MODEL_ANALYSE || "gpt-5-mini";
    const tempForAnalysis = process.env.OPENAI_TEMPERATURE_ANALYSE || "0.9";
    const raw = await callOpenAIChat(
        messages,
        60000,
        analyseTokens,
        modelForAnalysis,
        tempForAnalysis
    );
    return raw;
}
