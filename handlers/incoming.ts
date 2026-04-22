import { createTriggerProcessor } from "./triggers.js";
import { createCommandProcessor } from "./commands.js";
import { prisma } from "../services/db.js";
import { enqueueSendMessage } from "../services/sendQueue.js";
import { log } from "../services/logger.js";
import { generateAIAnalysis } from "../services/ai.js";

export function createIncomingProcessor({
  log: logFn,
  isDbConnected,
  generateAIAnalysis: analysisFn,
  prisma: prismaClient,
  enqueueSendMessage: enqueueFn,
}: {
  log: typeof log;
  isDbConnected: () => boolean;
  generateAIAnalysis: typeof generateAIAnalysis;
  prisma: typeof prisma;
  enqueueSendMessage: typeof enqueueSendMessage;
}) {
  const triggerProcessor = createTriggerProcessor({ log: logFn, isDbConnected });
  const commandProcessor = createCommandProcessor({
    log: logFn,
    generateAIAnalysis: analysisFn,
    prisma: prismaClient,
    MAX_MESSAGE_LENGTH: 4096,
    ANALYSE_COOLDOWN_SECONDS: parseInt(
      process.env.ANALYSE_COOLDOWN_SECONDS || "300",
      10
    ),
    isDbConnected,
    enqueueSendMessage: enqueueFn,
  });

  return async function processIncoming(msg: Record<string, unknown>) {
    await triggerProcessor(msg);
    await commandProcessor(msg);
  };
}
