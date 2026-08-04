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
import { registerGroupRoutes } from "./routes/groups.js";
import { ensureGroupSeeded } from "./services/groupService.js";
import { startMuteScheduler } from "./services/muteSchedulerQueue.js";
import { registerDropRoutes } from "./routes/drops.js";
import { registerMiruRoutes } from "./routes/miru.js";
import { startDropScheduler } from "./services/dropScheduler.js";
import { fetchSourceMeta } from "./services/anilistService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());
app.use(mediaStaticMiddleware({ rootDir: __dirname }));

let _dbConnected = false;
const isDbConnected = () => _dbConnected;

try {
  await prisma.$connect();
  _dbConnected = true;
  log("Conectado ao PostgreSQL com sucesso", "success");
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  log(`Erro ao conectar ao PostgreSQL: ${msg}`, "error");
}

async function ensureSourceMeta(): Promise<void> {
  if (!_dbConnected) return
  try {
    const count = await prisma.characterSourceMeta.count()
    if (count > 0) return
    log("CharacterSourceMeta vazio, buscando metadados do AniList...", "info")
    const results = await fetchSourceMeta()
    for (const { gender, totalCount } of results) {
      await prisma.characterSourceMeta.upsert({
        where: { source_gender: { source: "ANILIST", gender } },
        create: { source: "ANILIST", gender, totalCount },
        update: { totalCount },
      })
    }
    log("CharacterSourceMeta populado.", "success")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Falha ao popular CharacterSourceMeta: ${msg}`, "warning")
  }
}

void ensureSourceMeta()

async function ensureMainGroupSeeded(): Promise<void> {
  if (!_dbConnected) return;
  const groupId =
    process.env.GROUP_ID || process.env.ALLOWED_PING_GROUP || "120363339314665620@g.us";
  try {
    await ensureGroupSeeded(groupId, "Grupo principal");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Falha ao garantir grupo principal: ${msg}`, "error");
  }
}

void ensureMainGroupSeeded();

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
setInterval(() => { void ensureSourceMeta() }, SEVEN_DAYS_MS)

registerEventRoutes(app, { prisma, isDbConnected, tz: moment.tz, moment });
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
registerDropRoutes(app);
registerMiruRoutes(app);
registerGroupRoutes(app);

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
startDropScheduler();
startMuteScheduler();

app.listen(PORT, () => {
  log(`API rodando na porta ${PORT}`, "success");
});
