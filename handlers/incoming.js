import { createTriggerProcessor } from "./triggers.js";
import { createCommandProcessor } from "./commands.js";

export function createIncomingProcessor({ log, isDbConnected, generateAIAnalysis, AnalysisLog, enqueueSendMessage }) {
    const triggerProcessor = createTriggerProcessor({ log, isDbConnected });
    const commandProcessor = createCommandProcessor({
        log,
        generateAIAnalysis,
        AnalysisLog,
        MAX_MESSAGE_LENGTH: 4096,
        ANALYSE_COOLDOWN_SECONDS: parseInt(
            process.env.ANALYSE_COOLDOWN_SECONDS || "300",
            10
        ),
        isDbConnected,
        enqueueSendMessage,
    });

    return async function processIncoming(msg) {
        await triggerProcessor(msg);
        await commandProcessor(msg);
    };
}
