import removeAccentsLib from "remove-accents";
import { prisma } from "../services/db.js";
import { enqueueSendMessage } from "../services/sendQueue.js";
import { log } from "../services/logger.js";

function removeAccents(str: string): string {
  return removeAccentsLib(str || "");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(str: string, normalizeAccents: boolean, caseSensitive: boolean): string {
  let s = str || "";
  if (normalizeAccents) {
    s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  if (!caseSensitive) s = s.toLowerCase();
  return s;
}

interface TriggerRecord {
  id: string;
  active: boolean;
  phrases: string[];
  caseSensitive: boolean;
  normalizeAccents: boolean;
  matchType: string;
  wholeWord: boolean;
  chancePercent: number;
  expiresAt?: Date | null;
  maxUses?: number | null;
  triggeredCount: number;
  allowedUsers: string[];
  cooldownSeconds: number;
  cooldownPerUserSeconds: number;
  responseType: string;
  responseText?: string | null;
  responseMediaUrl?: string | null;
  replyMode: string;
  mentionSender: boolean;
}

interface IncomingMsg {
  body?: string;
  from?: string;
  author?: string;
  id?: string;
}

function buildMatcher(trigger: TriggerRecord): (text: string) => boolean {
  const phrases = trigger.phrases || [];
  const flags = trigger.caseSensitive ? "" : "i";

  return (text: string) => {
    if (!text) return false;
    const normalizedText = normalize(text, trigger.normalizeAccents, trigger.caseSensitive);
    for (const phrase of phrases) {
      if (!phrase) continue;
      if (trigger.matchType === "regex") {
        const pattern = normalize(phrase, trigger.normalizeAccents, trigger.caseSensitive);
        try {
          const re = new RegExp(pattern, flags);
          if (re.test(normalizedText)) return true;
        } catch {
          continue;
        }
      } else if (trigger.matchType === "exact") {
        const needle = normalize(phrase, trigger.normalizeAccents, trigger.caseSensitive);
        if (trigger.wholeWord) {
          const re = new RegExp(`\\b${escapeRegex(needle)}\\b`);
          if (re.test(normalizedText)) return true;
        } else {
          if (normalizedText === needle) return true;
        }
      } else if (trigger.matchType === "contains") {
        const needle = normalize(phrase, trigger.normalizeAccents, trigger.caseSensitive);
        if (trigger.wholeWord) {
          const re = new RegExp(`\\b${escapeRegex(needle)}\\b`);
          if (re.test(normalizedText)) return true;
        } else {
          if (normalizedText.includes(needle)) return true;
        }
      }
    }
    return false;
  };
}

export function createTriggerProcessor({
  log: logFn,
  isDbConnected,
}: {
  log: typeof log;
  isDbConnected: () => boolean;
}) {
  if (!isDbConnected) {
    return async (_msg: unknown) => {};
  }

  const allowedGroup =
    process.env.ALLOWED_PING_GROUP ||
    process.env.GROUP_ID ||
    "120363339314665620@g.us";

  const normalizeJid = (jid: string | undefined): string => {
    if (!jid) return "";
    const str = jid.toString();
    const digits = (str.split("@")[0] || "").replace(/\D/g, "");
    return digits;
  };

  let cache: { items: TriggerRecord[]; fetchedAt: number } = {
    items: [],
    fetchedAt: 0,
  };
  const cacheTtlMs = 30_000;
  const lastGlobalCooldown = new Map<string, number>();
  const lastUserCooldown = new Map<string, number>();

  async function loadTriggers(force = false): Promise<TriggerRecord[]> {
    if (!isDbConnected()) return [];
    const now = Date.now();
    if (!force && now - cache.fetchedAt < cacheTtlMs) return cache.items;
    try {
      const list = await prisma.trigger.findMany();
      cache = { items: list as unknown as TriggerRecord[], fetchedAt: now };
      return cache.items;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logFn(`Erro ao carregar triggers: ${msg}`, "error");
      return [];
    }
  }

  async function updateUseCount(triggerId: string): Promise<void> {
    try {
      await prisma.trigger.update({
        where: { id: triggerId },
        data: { triggeredCount: { increment: 1 } },
      });
    } catch {}
  }

  return async function processTrigger(msg: IncomingMsg): Promise<void> {
    try {
      if (!msg || !msg.body) return;
      if (msg.from !== allowedGroup) return;
      if ((msg.body || "").trim().startsWith("!")) return;

      const triggers = await loadTriggers();
      if (!triggers.length) return;

      const now = Date.now();
      const senderId = msg.author || msg.from || "";
      const senderNorm = normalizeJid(senderId);

      for (const trig of triggers) {
        if (!trig.active) continue;
        if (trig.expiresAt && new Date(trig.expiresAt).getTime() <= now) continue;
        if (trig.maxUses && trig.triggeredCount >= trig.maxUses) continue;
        if (Array.isArray(trig.allowedUsers) && trig.allowedUsers.length) {
          const match = trig.allowedUsers.some(
            (u) => u === senderId || normalizeJid(u) === senderNorm
          );
          if (!senderId || !match) continue;
        }

        const matcher = buildMatcher(trig);
        if (!matcher(msg.body || "")) continue;

        if (trig.chancePercent < 100) {
          const roll = Math.random() * 100;
          if (roll > trig.chancePercent) continue;
        }

        const globalKey = trig.id;
        const userId = senderId || msg.from || "unknown";
        const userKey = `${globalKey}:${normalizeJid(userId)}`;

        if (trig.cooldownSeconds > 0) {
          const last = lastGlobalCooldown.get(globalKey) || 0;
          if ((now - last) / 1000 < trig.cooldownSeconds) continue;
        }
        if (trig.cooldownPerUserSeconds > 0) {
          const lastU = lastUserCooldown.get(userKey) || 0;
          if ((now - lastU) / 1000 < trig.cooldownPerUserSeconds) continue;
        }

        let mediaUrl = trig.responseMediaUrl || "";
        if (mediaUrl && !mediaUrl.startsWith("http")) {
          const base = (process.env.MEDIA_BASE_URL || process.env.BACKEND_PUBLIC_URL || "http://backend:3000").replace(/\/+$/, "");
          mediaUrl = `${base}/${mediaUrl.replace(/^\/+/, "")}`;
        }

        const payload: Parameters<typeof enqueueSendMessage>[0] = {
          groupId: msg.from,
          type: trig.responseType as "text" | "image" | "video",
          content:
            trig.responseType === "text"
              ? trig.responseText || "(sem texto configurado)"
              : mediaUrl || trig.responseMediaUrl || "",
          caption: trig.responseType === "text" ? undefined : trig.responseText || undefined,
          replyTo: trig.replyMode === "reply" ? msg.id : undefined,
          mentions: trig.mentionSender && msg.author ? [msg.author] : [],
        };

        try {
          await enqueueSendMessage(payload, {
            idempotencyKey: `${msg.id}-${trig.id}`,
          });
          lastGlobalCooldown.set(globalKey, now);
          lastUserCooldown.set(userKey, now);
          updateUseCount(trig.id);
          cache.fetchedAt = 0;
          break;
        } catch (err: unknown) {
          const msg2 = err instanceof Error ? err.message : String(err);
          logFn(`Erro ao enfileirar resposta do trigger: ${msg2}`, "error");
        }
      }
    } catch (err: unknown) {
      const msg2 = err instanceof Error ? err.message : String(err);
      logFn(`Erro no processor de triggers: ${msg2}`, "error");
    }
  };
}
