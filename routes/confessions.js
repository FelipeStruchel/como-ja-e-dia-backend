import { getRequestIp } from "../utils/ip.js";
import { enqueueSendMessage } from "../services/sendQueue.js";

export function registerConfessionRoutes(
    app,
    { MAX_TEXT_LENGTH, MAX_MESSAGE_LENGTH, CONFESSION_COOLDOWN_MINUTES }
) {
    const lastConfessionByIp = new Map();

    app.post("/confessions", async (req, res) => {
        try {
            const rawMessage =
                (typeof req.body?.message === "string" && req.body.message) ||
                (typeof req.body?.text === "string" && req.body.text) ||
                "";
            const message = rawMessage.trim();
            const confessionLimit = Math.min(MAX_TEXT_LENGTH, MAX_MESSAGE_LENGTH);

            if (!message) {
                return res
                    .status(400)
                    .json({ error: "Mensagem da confissão é obrigatória" });
            }
            if (message.length > confessionLimit) {
                return res.status(400).json({
                    error: `A confissão deve ter no máximo ${confessionLimit} caracteres`,
                    maxLength: confessionLimit,
                });
            }

            const ip = getRequestIp(req);
            const now = Date.now();
            const cooldownMs = CONFESSION_COOLDOWN_MINUTES * 60 * 1000;
            const lastUse = lastConfessionByIp.get(ip) || 0;

            if (cooldownMs > 0 && now - lastUse < cooldownMs) {
                const waitSeconds = Math.ceil((cooldownMs - (now - lastUse)) / 1000);
                res.setHeader("Retry-After", waitSeconds);
                return res.status(429).json({
                    error: `Aguarde ${Math.ceil(waitSeconds / 60)} minuto(s) antes de enviar outra confissão.`,
                    waitSeconds,
                });
            }

            const targetGroupId =
                process.env.GROUP_ID ||
                process.env.ALLOWED_PING_GROUP ||
                "120363339314665620@g.us";
            const finalMessage = `Confissão anônima: ${message}`.slice(
                0,
                MAX_MESSAGE_LENGTH
            );

            await enqueueSendMessage({
                groupId: targetGroupId,
                type: "text",
                content: finalMessage,
            });
            lastConfessionByIp.set(ip, now);

            return res.json({
                success: true,
                cooldownMinutes: CONFESSION_COOLDOWN_MINUTES,
            });
        } catch (error) {
            console.error("Erro ao processar confissão:", error);
            return res.status(500).json({ error: "Erro ao enviar confissão" });
        }
    });
}
