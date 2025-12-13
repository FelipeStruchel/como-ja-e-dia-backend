import { Trigger } from "../models/trigger.js";
import { enqueueSendMessage } from "../services/sendQueue.js";

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(str, normalizeAccents, caseSensitive) {
    let s = str || "";
    if (normalizeAccents) {
        s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    if (!caseSensitive) s = s.toLowerCase();
    return s;
}

function buildMatcher(trigger) {
    const phrases = trigger.phrases || [];
    const flags = trigger.caseSensitive ? "" : "i";

    return (text) => {
        if (!text) return false;
        for (const phrase of phrases) {
            if (!phrase) continue;
            if (trigger.matchType === "regex") {
                try {
                    const re = new RegExp(phrase, flags);
                    if (re.test(text)) return true;
                } catch (_) {
                    continue;
                }
            } else if (trigger.matchType === "exact") {
                if (trigger.wholeWord) {
                    const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, flags);
                    if (re.test(text)) return true;
                } else {
                    if (
                        normalize(text, trigger.normalizeAccents, trigger.caseSensitive) ===
                        normalize(phrase, trigger.normalizeAccents, trigger.caseSensitive)
                    ) {
                        return true;
                    }
                }
            } else if (trigger.matchType === "contains") {
                if (trigger.wholeWord) {
                    const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, flags);
                    if (re.test(text)) return true;
                } else {
                    const hay = normalize(
                        text,
                        trigger.normalizeAccents,
                        trigger.caseSensitive
                    );
                    const needle = normalize(
                        phrase,
                        trigger.normalizeAccents,
                        trigger.caseSensitive
                    );
                    if (hay.includes(needle)) return true;
                }
            }
        }
        return false;
    };
}

export function createTriggerProcessor({ log, isDbConnected }) {
    if (!isDbConnected) {
        return async () => {};
    }

    const allowedGroup =
        process.env.ALLOWED_PING_GROUP ||
        process.env.GROUP_ID ||
        "120363339314665620@g.us";

    const normalizeJid = (jid) => {
        if (!jid) return "";
        const str = jid.toString();
        const base = str.split("@")[0];
        return base;
    };

    let cache = { items: [], fetchedAt: 0 };
    const cacheTtlMs = 30_000;
    const lastGlobalCooldown = new Map();
    const lastUserCooldown = new Map();

    async function loadTriggers(force = false) {
        if (!isDbConnected()) return [];
        const now = Date.now();
        if (!force && now - cache.fetchedAt < cacheTtlMs) return cache.items;
        try {
            const list = await Trigger.find({}).lean();
            cache = { items: list, fetchedAt: now };
            return list;
        } catch (err) {
            log(`Erro ao carregar triggers: ${err.message}`, "error");
            return [];
        }
    }

    async function updateUseCount(triggerId) {
        try {
            await Trigger.findByIdAndUpdate(triggerId, {
                $inc: { triggeredCount: 1 },
            });
        } catch (_) {}
    }

    return async function processTrigger(msg) {
        try {
            if (!msg || !msg.body) return;
            if (msg.from !== allowedGroup) return;
            if ((msg.body || "").trim().startsWith("!")) return;

            const triggers = await loadTriggers();
            if (!triggers.length) return;

            const now = Date.now();
            let senderId =
                msg.author ||
                msg.id?.participant ||
                msg.from ||
                "";
            if (!senderId && typeof msg.getContact === "function") {
                try {
                    const c = await msg.getContact();
                    senderId = c?.id?._serialized || "";
                } catch (_) {
                    // ignore
                }
            }
            const senderNorm = normalizeJid(senderId);
            for (const trig of triggers) {
                if (!trig.active) continue;
                if (trig.expiresAt && new Date(trig.expiresAt).getTime() <= now) continue;
                if (trig.maxUses && trig.triggeredCount >= trig.maxUses) continue;
                if (Array.isArray(trig.allowedUsers) && trig.allowedUsers.length) {
                    const match = trig.allowedUsers.some(
                        (u) =>
                            u === senderId ||
                            normalizeJid(u) === senderNorm
                    );
                    if (!senderId || !match) continue;
                }

                const matcher = buildMatcher(trig);
                if (!matcher(msg.body || "")) continue;

                if (trig.chancePercent < 100) {
                    const roll = Math.random() * 100;
                    if (roll > trig.chancePercent) continue;
                }

                const globalKey = trig._id.toString();
                const userId = msg.author || msg.from || "unknown";
                const userKey = `${globalKey}:${userId}`;

                if (trig.cooldownSeconds > 0) {
                    const last = lastGlobalCooldown.get(globalKey) || 0;
                    if ((now - last) / 1000 < trig.cooldownSeconds) continue;
                }
                if (trig.cooldownPerUserSeconds > 0) {
                    const lastU = lastUserCooldown.get(userKey) || 0;
                    if ((now - lastU) / 1000 < trig.cooldownPerUserSeconds) continue;
                }

                let mediaUrl = trig.responseMediaUrl || "";
                if (
                    mediaUrl &&
                    !mediaUrl.startsWith("http") &&
                    process.env.BACKEND_PUBLIC_URL
                ) {
                    const base = process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, "");
                    mediaUrl = `${base}/${mediaUrl.replace(/^\/+/, "")}`;
                }

                const payload = {
                    groupId: msg.from,
                    type: trig.responseType,
                    content:
                        trig.responseType === "text"
                            ? trig.responseText || "(sem texto configurado)"
                            : mediaUrl || trig.responseMediaUrl,
                    caption: trig.responseType === "text" ? undefined : trig.responseText,
                    replyTo: trig.replyMode === "reply" ? msg.id : undefined,
                    mentions: trig.mentionSender && msg.author ? [msg.author] : [],
                };

                try {
                    await enqueueSendMessage(payload, { idempotencyKey: `${msg.id}-${trig._id}` });
                    lastGlobalCooldown.set(globalKey, now);
                    lastUserCooldown.set(userKey, now);
                    updateUseCount(trig._id);
                    cache.fetchedAt = 0;
                    break; // stop after first trigger fired
                } catch (err) {
                    log(`Erro ao enfileirar resposta do trigger: ${err.message}`, "error");
                }
            }
        } catch (err) {
            log(`Erro no processor de triggers: ${err.message}`, "error");
        }
    };
}
