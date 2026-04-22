import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

const TAG: Record<string, string> = {
  info: "[INFO]",
  error: "[ERROR]",
  success: "[SUCCESS]",
  warning: "[WARN]",
  debug: "[DEBUG]",
};

export async function log(
  message: string,
  type = "info",
  meta: Record<string, unknown> | null = null
): Promise<void> {
  const ts = new Date().toISOString();
  const tag = TAG[type] || "[INFO]";
  console.log(`[${ts}] ${tag} ${message}`);

  try {
    await prisma.logEntry.create({
      data: {
        source: "backend",
        level: type,
        message: String(message),
        meta: meta ? (meta as Prisma.InputJsonValue) : undefined,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toISOString()}] [ERROR] Falha ao salvar log: ${msg}`);
  }
}
