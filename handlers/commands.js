import removeAccentsLib from "remove-accents";

function removeAccents(str) {
    return removeAccentsLib(str || "");
}

export function createCommandProcessor({
    log,
    generateAIAnalysis,
    AnalysisLog,
    MAX_MESSAGE_LENGTH,
    ANALYSE_COOLDOWN_SECONDS,
    isDbConnected,
    enqueueSendMessage,
}) {
    const lastAnalyses = new Map();
    let lastAllTimestamp = 0;

    function getAllowedGroupId() {
        return process.env.ALLOWED_PING_GROUP || "120363339314665620@g.us";
    }

    function isFromAllowedGroup(msg) {
        const allowed = getAllowedGroupId();
        return msg && msg.from === allowed;
    }

    function parseCommand(text) {
        const lowered = removeAccents((text || "").trim().toLowerCase());
        if (lowered === "!all" || lowered === "!everyone") return { name: "all" };
        if (lowered.startsWith("!analise")) {
            const parts = lowered.split(/\s+/);
            let n = 10;
            if (parts.length >= 2) {
                const parsed = parseInt(parts[1], 10);
                if (!isNaN(parsed)) n = parsed;
            }
            return { name: "analise", n };
        }
        return null;
    }

    async function handleAllCommand(msg) {
        const allowedGroup = getAllowedGroupId();
        if (!msg.isGroup) {
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: "Isso só funciona em grupos, parceiro.",
                replyTo: msg.id,
            });
            return true;
        }
        if (msg.from !== allowedGroup) {
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: "Comando !all e !everyone restrito a administradores deste grupo.",
                replyTo: msg.id,
            });
            return true;
        }
        const ALL_COOLDOWN = parseInt(
            process.env.ANALYSE_ALL_COOLDOWN_SECONDS || "600",
            10
        );
        const nowTs = Date.now();
        if ((nowTs - lastAllTimestamp) / 1000 < ALL_COOLDOWN) {
            const wait = Math.ceil(
                ALL_COOLDOWN - (nowTs - lastAllTimestamp) / 1000
            );
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: `Já teve um ping recentemente. Aguenta mais ${wait} segundos.`,
                replyTo: msg.id,
            });
            return true;
        }
        const participants = msg.participants || [];
        const maxMentions = 256;
        if (participants.length === 0) {
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: "Não consegui obter a lista de participantes.",
                replyTo: msg.id,
            });
            return true;
        }
        if (participants.length > maxMentions) {
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: `Esse grupo é gigante (${participants.length} membros). Não vou pingar todo mundo.`,
                replyTo: msg.id,
            });
            return true;
        }
        await enqueueSendMessage({
            groupId: msg.from,
            type: "text",
            content: "@everyone",
            mentions: participants,
        });
        lastAllTimestamp = nowTs;
        return true;
    }

    function getUserIdForCooldown(msg) {
        if (msg.fromMe) return "bot-self";
        return msg.author || msg.from;
    }

    function withinAnalyseCooldown(userId) {
        const now = Date.now();
        const last = lastAnalyses.get(userId) || 0;
        const diffSec = Math.floor((now - last) / 1000);
        if (diffSec < ANALYSE_COOLDOWN_SECONDS) {
            return { blocked: true, wait: ANALYSE_COOLDOWN_SECONDS - diffSec };
        }
        lastAnalyses.set(userId, now);
        return { blocked: false };
    }

    function sanitizeMessagesForAnalysis(msg) {
        // Expect msg.recentMessages from worker
        return Array.isArray(msg.recentMessages)
            ? msg.recentMessages.filter((m) => m && m.body && m.type === "chat")
            : [];
    }

    async function handleAnaliseCommand(msg, n) {
        if (n > 30) {
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: "Tu acha que essa porcaria de IA é de graça? Limite máximo: 30 mensagens.",
                replyTo: msg.id,
            });
            return true;
        }
        if (n <= 0) {
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: "Número inválido. Use !analise ou !analise <n> onde n entre 1 e 30.",
                replyTo: msg.id,
            });
            return true;
        }
        const userId = getUserIdForCooldown(msg);
        const cd = withinAnalyseCooldown(userId);
        if (cd.blocked) {
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: `Aguenta aí, parceiro. Espera mais ${cd.wait} segundos antes de pedir outra análise.`,
                replyTo: msg.id,
            });
            return true;
        }

        const sanitized = sanitizeMessagesForAnalysis(msg);
        const toAnalyze = sanitized.slice(-n);
        if (!toAnalyze || toAnalyze.length === 0) {
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: "Não há mensagens suficientes para analisar.",
                replyTo: msg.id,
            });
            return true;
        }

        let analysis = null;
        const start = Date.now();
        try {
            for (const m of toAnalyze) {
                const sender = m.senderName || m.author || m.from || "desconhecido";
                const txt = String(m.body || "").replace(/\s+/g, " ").trim().slice(0, 160);
                log(`Mensagem para análise: [${sender}] ${txt || "<vazia>"}`, "info");
            }
            analysis = await generateAIAnalysis(toAnalyze);
            if (isDbConnected && isDbConnected()) {
                try {
                    await AnalysisLog.create({
                        user: userId,
                        chatId: msg.from,
                        requestedN: n,
                        analyzedCount: toAnalyze.length,
                        messages: toAnalyze.map((m, i) => ({
                            idx: i + 1,
                            sender: m.senderName || m.author || "desconhecido",
                            text: (m.body || "").slice(0, 1000),
                        })),
                        result: analysis,
                        durationMs: Date.now() - start,
                    });
                } catch (createErr) {
                    log(`Erro ao salvar AnalysisLog: ${createErr.message}`, "error");
                }
            }
        } catch (aiErr) {
            log(
                `AI analysis error: ${
                    aiErr && aiErr.message ? aiErr.message : aiErr
                }`,
                "error"
            );
        }
        if (!analysis) {
            await enqueueSendMessage({
                groupId: msg.from,
                type: "text",
                content: "Hmmm... a IA não colaborou dessa vez.",
                replyTo: msg.id,
            });
            return true;
        }
        await enqueueSendMessage({
            groupId: msg.from,
            type: "text",
            content: (analysis || "").slice(0, MAX_MESSAGE_LENGTH),
            replyTo: msg.id,
        });
        return true;
    }

    return async function processCommand(msg) {
        try {
            if (!msg || !msg.body) return;
            if (!isFromAllowedGroup(msg)) {
                log(
                    `Mensagem recebida de grupo não autorizado (${msg.from}). Ignorando.`,
                    "info"
                );
                return;
            }

            const text = msg.body.trim();
            const cmd = parseCommand(text);
            if (!cmd) return;

            if (cmd.name === "all") {
                await handleAllCommand(msg);
                return;
            }
            if (cmd.name === "analise") {
                await handleAnaliseCommand(msg, cmd.n);
                return;
            }
        } catch (err) {
            log(`Erro no processor de comando: ${err.message}`, "error");
        }
    };
}
