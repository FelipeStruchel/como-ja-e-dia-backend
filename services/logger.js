import { prisma } from "./db.js";

export async function log(message, type = "info", meta = null) {
    const ts = new Date().toISOString();
    const tag =
        {
            info: "[INFO]",
            error: "[ERROR]",
            success: "[SUCCESS]",
            warning: "[WARN]",
            debug: "[DEBUG]",
        }[type] || "[INFO]";

    console.log(`[${ts}] ${tag} ${message}`);

    try {
        await prisma.logEntry.create({
            data: {
                source: "backend",
                level: type,
                message: String(message),
                meta: meta ?? undefined,
            },
        });
    } catch (err) {
        console.error(
            `[${new Date().toISOString()}] [ERROR] Falha ao salvar log: ${err.message}`
        );
    }
}
