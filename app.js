import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import moment from "moment-timezone";
import "moment/locale/pt-br.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerPhraseRoutes } from "./routes/frases.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerConfessionRoutes } from "./routes/confessions.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTriggerRoutes } from "./routes/triggers.js";
import { registerLogIngestRoute } from "./routes/logIngest.js";
import { registerLogRoutes } from "./routes/logs.js";
import { prisma } from "./services/db.js";
import { enqueueSendMessage } from "./services/sendQueue.js";
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
import { registerWhatsAppQrRoutes } from "./routes/whatsappQr.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());
app.use(mediaStaticMiddleware({ rootDir: __dirname }));

// Conectar ao banco
let _dbConnected = false;
const isDbConnected = () => _dbConnected;

try {
    await prisma.$connect();
    _dbConnected = true;
    log("Conectado ao PostgreSQL com sucesso", "success");
} catch (err) {
    log(`Erro ao conectar ao PostgreSQL: ${err.message}`, "error");
}

// Registrar rotas
registerEventRoutes(app, {
    prisma,
    isDbConnected,
    tz: moment.tz,
    moment,
});
registerAuthRoutes(app);
registerPhraseRoutes(app, { MAX_MESSAGE_LENGTH: 4096, prisma });
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
registerWhatsAppQrRoutes(app);

app.get("/db-status", async (_req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ connected: true });
    } catch {
        res.json({ connected: false });
    }
});

const processIncoming = createIncomingProcessor({
    log,
    isDbConnected,
    generateAIAnalysis,
    prisma,
    enqueueSendMessage,
});
startIncomingConsumer(processIncoming);
startScheduledWorker();
resyncSchedules();

app.listen(PORT, () => {
    log(`API rodando na porta ${PORT}`, "success");
});
