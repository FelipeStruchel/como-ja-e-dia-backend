import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { registerEventRoutes } from "./routes/events.js";
import { registerPhraseRoutes } from "./routes/frases.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerConfessionRoutes } from "./routes/confessions.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTriggerRoutes } from "./routes/triggers.js";
import { registerLogIngestRoute } from "./routes/logIngest.js";
import { registerLogRoutes } from "./routes/logs.js";
import { connectDb } from "./services/db.js";
import { enqueueSendMessage } from "./services/sendQueue.js";
import { Event } from "./models/event.js";
import { AnalysisLog } from "./models/analysisLog.js";
import { Phrase } from "./models/phrase.js";
import { log } from "./services/logger.js";
import { generateAIAnalysis } from "./services/ai.js";
import { MEDIA_TYPES, saveMedia, listAllMedia } from "./mediaManager.js";
import { startIncomingConsumer } from "./services/incomingQueue.js";
import { createIncomingProcessor } from "./handlers/incoming.js";
import { mediaStaticMiddleware } from "./services/staticMedia.js";
import { registerGroupContextRoutes } from "./routes/groupContext.js";
import { registerPersonaRoutes } from "./routes/persona.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { startScheduledWorker, resyncSchedules } from "./services/scheduledJobs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Respeitar X-Forwarded-* (necessário atrás de proxy para IP real)
app.set("trust proxy", true);

// Middlewares
app.use(cors());
app.use(express.json());
app.use(mediaStaticMiddleware({ rootDir: __dirname }));

// Conectar DB
const { dbConnected, mongoose, moment } = await connectDb(log);

const isDbConnected = () => dbConnected();

// Registrar rotas
registerEventRoutes(app, {
    Event,
    isDbConnected,
    tz: moment.tz,
    moment,
});
registerAuthRoutes(app);
registerPhraseRoutes(app, { MAX_MESSAGE_LENGTH: 4096, Phrase });
registerMediaRoutes(app, { MEDIA_TYPES, saveMedia, listAllMedia });
registerConfessionRoutes(app, {
    MAX_TEXT_LENGTH: parseInt(process.env.MAX_TEXT_LENGTH || "1000", 10),
    MAX_MESSAGE_LENGTH: 4096,
    CONFESSION_COOLDOWN_MINUTES: Math.max(
        0,
        parseInt(process.env.CONFESSION_COOLDOWN_MINUTES || "10", 10)
    ),
});
registerHealthRoute(app);
registerTriggerRoutes(app);
registerLogRoutes(app);
registerLogIngestRoute(app);
registerGroupContextRoutes(app);
registerPersonaRoutes(app);
registerScheduleRoutes(app);

app.get("/db-status", (req, res) => {
    res.json({ connected: isDbConnected() });
});

// Consumidor de mensagens recebidas (fila -> processamento -> fila de envio)
const processIncoming = createIncomingProcessor({
    log,
    isDbConnected,
    generateAIAnalysis,
    AnalysisLog,
    enqueueSendMessage,
});
startIncomingConsumer(processIncoming);
startScheduledWorker();
resyncSchedules();

// Start server
app.listen(PORT, () => {
    log(`API rodando na porta ${PORT}`, "success");
});
