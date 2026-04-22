import removeAccentsLib from "remove-accents";
import { prisma } from "../services/db.js";
import { enqueueSendMessage } from "../services/sendQueue.js";
import { log } from "../services/logger.js";
import { generateAIAnalysis } from "../services/ai.js";

function removeAccents(str: string): string {
  return removeAccentsLib(str || "");
}

interface IncomingMsg {
  body?: string;
  from?: string;
  author?: string;
  id?: string;
  isGroup?: boolean;
  fromMe?: boolean;
  participants?: unknown[];
  recentMessages?: Array<{
    body?: string;
    type?: string;
    senderName?: string;
    author?: string;
    bodySanitized?: string;
  }>;
}

export function createCommandProcessor({
  log: logFn,
  generateAIAnalysis: analysisFn,
  prisma: prismaClient,
  MAX_MESSAGE_LENGTH,
  ANALYSE_COOLDOWN_SECONDS,
  isDbConnected,
  enqueueSendMessage: enqueueFn,
}: {
  log: typeof log;
  generateAIAnalysis: typeof generateAIAnalysis;
  prisma: typeof prisma;
  MAX_MESSAGE_LENGTH: number;
  ANALYSE_COOLDOWN_SECONDS: number;
  isDbConnected: () => boolean;
  enqueueSendMessage: typeof enqueueSendMessage;
}) {
  const lastAnalyses = new Map<string, number>();
  let lastAllTimestamp = 0;

  function getAllowedGroupId(): string {
    return process.env.ALLOWED_PING_GROUP || "120363339314665620@g.us";
  }

  function isFromAllowedGroup(msg: IncomingMsg): boolean {
    const allowed = getAllowedGroupId();
    return !!(msg && msg.from === allowed);
  }

  function parseCommand(
    text: string
  ): { name: "all" } | { name: "analise"; n: number } | null {
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

  async function handleAllCommand(msg: IncomingMsg): Promise<void> {
    const allowedGroup = getAllowedGroupId();
    if (!msg.isGroup) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Isso só funciona em grupos, parceiro.",
        replyTo: msg.id,
      });
      return;
    }
    if (msg.from !== allowedGroup) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Comando !all e !everyone restrito a administradores deste grupo.",
        replyTo: msg.id,
      });
      return;
    }
    const ALL_COOLDOWN = parseInt(
      process.env.ANALYSE_ALL_COOLDOWN_SECONDS || "600",
      10
    );
    const nowTs = Date.now();
    if ((nowTs - lastAllTimestamp) / 1000 < ALL_COOLDOWN) {
      const wait = Math.ceil(ALL_COOLDOWN - (nowTs - lastAllTimestamp) / 1000);
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Já teve um ping recentemente. Aguenta mais ${wait} segundos.`,
        replyTo: msg.id,
      });
      return;
    }
    const rawParticipants = msg.participants || [];
    const mentionIds = Array.from(
      new Set(
        rawParticipants
          .map((p): string | null => {
            if (typeof p === "string") return p;
            if (p && typeof p === "object") {
              const obj = p as Record<string, unknown>;
              if (obj._serialized) return String(obj._serialized);
              if (obj.id && typeof obj.id === "object") {
                const id = obj.id as Record<string, unknown>;
                if (id._serialized) return String(id._serialized);
              }
              if (obj.id && typeof obj.id === "string") return obj.id;
            }
            return null;
          })
          .filter((x): x is string => x !== null)
      )
    );
    const maxMentions = 256;
    if (mentionIds.length === 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Não consegui obter a lista de participantes.",
        replyTo: msg.id,
      });
      return;
    }
    if (mentionIds.length > maxMentions) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Esse grupo é gigante (${mentionIds.length} membros). Não vou pingar todo mundo.`,
        replyTo: msg.id,
      });
      return;
    }
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: "@everyone",
      mentions: mentionIds,
    });
    lastAllTimestamp = nowTs;
  }

  function getUserIdForCooldown(msg: IncomingMsg): string {
    if (msg.fromMe) return "bot-self";
    return msg.author || msg.from || "unknown";
  }

  function withinAnalyseCooldown(
    userId: string
  ): { blocked: true; wait: number } | { blocked: false } {
    const now = Date.now();
    const last = lastAnalyses.get(userId) || 0;
    const diffSec = Math.floor((now - last) / 1000);
    if (diffSec < ANALYSE_COOLDOWN_SECONDS) {
      return { blocked: true, wait: ANALYSE_COOLDOWN_SECONDS - diffSec };
    }
    lastAnalyses.set(userId, now);
    return { blocked: false };
  }

  function sanitizeMessagesForAnalysis(msg: IncomingMsg) {
    return Array.isArray(msg.recentMessages)
      ? msg.recentMessages.filter((m) => m && m.body && m.type === "chat")
      : [];
  }

  async function handleAnaliseCommand(msg: IncomingMsg, n: number): Promise<void> {
    if (n > 30) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Tu acha que essa porcaria de IA é de graça? Limite máximo: 30 mensagens.",
        replyTo: msg.id,
      });
      return;
    }
    if (n <= 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Número inválido. Use !analise ou !analise <n> onde n entre 1 e 30.",
        replyTo: msg.id,
      });
      return;
    }
    const userId = getUserIdForCooldown(msg);
    const cd = withinAnalyseCooldown(userId);
    if (cd.blocked) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Aguenta aí, parceiro. Espera mais ${cd.wait} segundos antes de pedir outra análise.`,
        replyTo: msg.id,
      });
      return;
    }

    const sanitized = sanitizeMessagesForAnalysis(msg);
    const toAnalyze = sanitized.slice(-n);
    if (!toAnalyze || toAnalyze.length === 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Não há mensagens suficientes para analisar.",
        replyTo: msg.id,
      });
      return;
    }

    let analysis: string | null = null;
    const start = Date.now();
    try {
      analysis = await analysisFn(toAnalyze);
      if (isDbConnected && isDbConnected()) {
        try {
          await prismaClient.analysisLog.create({
            data: {
              user: userId,
              chatId: msg.from || "",
              requestedN: n,
              analyzedCount: toAnalyze.length,
              messages: toAnalyze.map((m, i) => ({
                idx: i + 1,
                sender: m.senderName || m.author || "desconhecido",
                text: (m.body || "").slice(0, 1000),
              })),
              result: analysis,
              durationMs: Date.now() - start,
            },
          });
        } catch (createErr: unknown) {
          const msg2 = createErr instanceof Error ? createErr.message : String(createErr);
          logFn(`Erro ao salvar AnalysisLog: ${msg2}`, "error");
        }
      }
    } catch (aiErr: unknown) {
      const msg2 = aiErr instanceof Error ? aiErr.message : String(aiErr);
      logFn(`AI analysis error: ${msg2}`, "error");
    }

    if (!analysis) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Hmmm... a IA não colaborou dessa vez.",
        replyTo: msg.id,
      });
      return;
    }
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: (analysis || "").slice(0, MAX_MESSAGE_LENGTH),
      replyTo: msg.id,
    });
  }

  return async function processCommand(msg: IncomingMsg): Promise<void> {
    try {
      if (!msg || !msg.body) return;
      if (!isFromAllowedGroup(msg)) return;

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
    } catch (err: unknown) {
      const msg2 = err instanceof Error ? err.message : String(err);
      logFn(`Erro no processor de comando: ${msg2}`, "error");
    }
  };
}
