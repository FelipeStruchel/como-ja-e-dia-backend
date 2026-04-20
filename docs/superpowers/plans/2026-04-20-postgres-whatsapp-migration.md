# Migração PostgreSQL + Atualização whatsapp-web.js — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir MongoDB/Mongoose por PostgreSQL local via Docker usando Prisma, e atualizar whatsapp-web.js de 1.34.1 para 1.34.6.

**Architecture:** Prisma client singleton exportado de `services/db.js`, usado diretamente em todas as rotas e services. Os 9 arquivos `models/` são deletados. Cada rota/service que hoje importa um model Mongoose passa a importar `prisma` de `services/db.js`.

**Tech Stack:** Node.js 18 ESM, Prisma 5.x, PostgreSQL 16 (Docker), whatsapp-web.js 1.34.6

---

## Mapa de arquivos

| Arquivo | Ação |
|---|---|
| `prisma/schema.prisma` | Criar |
| `docker-compose.yml` | Modificar — adicionar serviço postgres |
| `.env.example` | Modificar — trocar vars MONGO por DATABASE_URL |
| `package.json` | Modificar — add prisma, remove mongoose/mongodb, bump whatsapp-web.js |
| `services/db.js` | Reescrever |
| `services/logger.js` | Reescrever |
| `services/authService.js` | Reescrever |
| `services/personaConfig.js` | Modificar |
| `services/scheduledJobs.js` | Modificar |
| `handlers/triggers.js` | Modificar |
| `handlers/commands.js` | Modificar |
| `handlers/incoming.js` | Modificar |
| `routes/events.js` | Modificar |
| `routes/frases.js` | Modificar |
| `routes/triggers.js` | Modificar |
| `routes/schedules.js` | Modificar |
| `routes/logs.js` | Modificar |
| `routes/logIngest.js` | Modificar |
| `routes/groupContext.js` | Modificar |
| `routes/auth.js` | Modificar (`_id` → `id`) |
| `app.js` | Modificar |
| `models/*.js` (9 arquivos) | Deletar |

---

## Task 1: Instalar Prisma e criar schema

**Files:**
- Modify: `package.json`
- Create: `prisma/schema.prisma`

- [ ] **Passo 1: Instalar dependências**

```bash
cd como-ja-e-dia-backend
npm install @prisma/client
npm install --save-dev prisma
npm uninstall mongoose mongodb
```

- [ ] **Passo 2: Adicionar scripts ao package.json**

Em `package.json`, na seção `"scripts"`, adicionar:

```json
"prisma:generate": "prisma generate",
"prisma:migrate": "prisma migrate dev",
"prisma:push": "prisma db push"
```

- [ ] **Passo 3: Criar `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserStatus {
  pending
  approved
  blocked
}

model User {
  id           String     @id @default(cuid())
  email        String     @unique
  name         String     @default("")
  passwordHash String
  status       UserStatus @default(pending)
  createdAt    DateTime   @default(now())
}

model Event {
  id          String    @id @default(cuid())
  name        String
  date        DateTime
  createdAt   DateTime  @default(now())
  announced   Boolean   @default(false)
  announcedAt DateTime?
  claimedBy   String?
  claimedAt   DateTime?
}

model Phrase {
  id        String   @id @default(cuid())
  text      String
  createdAt DateTime @default(now())
}

model Trigger {
  id                     String    @id @default(cuid())
  name                   String    @default("")
  phrases                String[]
  matchType              String    @default("exact")
  caseSensitive          Boolean   @default(false)
  normalizeAccents       Boolean   @default(true)
  wholeWord              Boolean   @default(true)
  responseType           String    @default("text")
  responseText           String    @default("")
  responseMediaUrl       String    @default("")
  replyMode              String    @default("reply")
  mentionSender          Boolean   @default(false)
  chancePercent          Float     @default(100)
  expiresAt              DateTime?
  maxUses                Int?
  triggeredCount         Int       @default(0)
  cooldownSeconds        Int       @default(0)
  cooldownPerUserSeconds Int       @default(0)
  active                 Boolean   @default(true)
  allowedUsers           String[]
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt
}

model Schedule {
  id                String    @id @default(cuid())
  name              String
  kind              String    @default("greeting")
  type              String
  mediaUrl          String    @default("")
  textContent       String    @default("")
  captionMode       String    @default("auto")
  customCaption     String    @default("")
  includeIntro      Boolean   @default(true)
  includeRandomPool Boolean   @default(true)
  announceEvents    Boolean   @default(false)
  personaPrompt     String    @default("")
  cron              String    @default("")
  useCronOverride   Boolean   @default(false)
  time              String    @default("06:00")
  timezone          String    @default("America/Sao_Paulo")
  startDate         DateTime?
  endDate           DateTime?
  daysOfWeek        Int[]
  active            Boolean   @default(true)
  repeatJobKey      String    @default("")
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
}

model GroupContext {
  id          String   @id @default(cuid())
  groupId     String   @unique
  subject     String   @default("")
  description String   @default("")
  members     Json     @default("[]")
  fetchedAt   DateTime @default(now())
}

model PersonaConfig {
  id        Int      @id @default(autoincrement())
  prompt    String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model AnalysisLog {
  id            String   @id @default(cuid())
  user          String
  chatId        String?
  requestedN    Int      @default(0)
  analyzedCount Int      @default(0)
  messages      Json     @default("[]")
  result        String?
  error         String?
  durationMs    Int      @default(0)
  createdAt     DateTime @default(now())
}

model LogEntry {
  id        String   @id @default(cuid())
  source    String   @default("backend")
  level     String   @default("info")
  message   String
  meta      Json?
  createdAt DateTime @default(now())
}
```

- [ ] **Passo 4: Gerar cliente Prisma**

```bash
npx prisma generate
```

Saída esperada: `✔ Generated Prisma Client` sem erros.

- [ ] **Passo 5: Commit**

```bash
git add package.json package-lock.json prisma/schema.prisma
git commit -m "chore: add prisma, remove mongoose/mongodb"
```

---

## Task 2: Docker Compose + variáveis de ambiente

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Passo 1: Atualizar `docker-compose.yml`**

Substituir conteúdo completo:

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-comojaedia}
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - bot-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  backend:
    build: .
    restart: unless-stopped
    env_file:
      - ./.env
    ports:
      - "3000:3000"
    environment:
      REDIS_URL: ${REDIS_URL:-redis://redis:6379}
      REDIS_HOST: ${REDIS_HOST:-redis}
      REDIS_PORT: ${REDIS_PORT:-6379}
    volumes:
      - backend-media:/app/media
      - backend-media-triggers:/app/media_triggers
      - backend-daily:/app/daily_vid
    networks:
      - bot-net
    depends_on:
      postgres:
        condition: service_healthy

networks:
  bot-net:
    name: bot-net
    external: true

volumes:
  postgres-data:
  backend-media:
  backend-media-triggers:
  backend-daily:
```

- [ ] **Passo 2: Atualizar `.env.example`**

Substituir conteúdo completo:

```
PORT=3000

# PostgreSQL
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/comojaedia

# WhatsApp
GROUP_ID=120363339314665620@g.us
ALLOWED_PING_GROUP=120363339314665620@g.us
CONFIRMATION_NUMBER=5514997061981
JWT_SECRET=change-me
BACKEND_PUBLIC_URL=http://localhost:3000
MEDIA_BASE_URL=http://localhost:3000

# Redis / Fila
REDIS_URL=redis://redis:6379
REDIS_HOST=redis
REDIS_PORT=6379
SEND_QUEUE_NAME=send-messages
INCOMING_QUEUE_NAME=incoming-messages
LOG_INGEST_TOKEN=change-me
GROUP_CONTEXT_QUEUE_NAME=group-context
CONTEXT_INGEST_TOKEN=change-me

# OpenAI
OPENAI_API_KEY=sk-xxxxx
OPENAI_MODEL=gpt-5-mini
OPENAI_MODEL_GREET=gpt-5-mini
OPENAI_MODEL_ANALYSE=gpt-5-mini
OPENAI_FALLBACK_MODEL=gpt-5-mini
OPENAI_TEMPERATURE_GREET=0.9
OPENAI_TEMPERATURE_ANALYSE=0.9
OPENAI_MAX_COMPLETION_TOKENS=2048
OPENAI_MAX_COMPLETION_TOKENS_ANALYSE=2048

# Limits e timeouts
MAX_TEXT_LENGTH=1000
ANALYSE_COOLDOWN_SECONDS=300
ANALYSE_ALL_COOLDOWN_SECONDS=600
CONFESSION_COOLDOWN_MINUTES=10
```

- [ ] **Passo 3: Subir postgres local e aplicar schema**

Certifique-se de ter `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/comojaedia` no seu `.env` local.

```bash
docker compose up postgres -d
# aguardar ~5s para o healthcheck passar
npx prisma db push
```

Saída esperada: `✔ Your database is now in sync with your Prisma schema.`

- [ ] **Passo 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add postgres service to docker compose, update env example"
```

---

## Task 3: Reescrever `services/db.js`

**Files:**
- Modify: `services/db.js`

- [ ] **Passo 1: Substituir conteúdo completo de `services/db.js`**

```js
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
```

- [ ] **Passo 2: Commit**

```bash
git add services/db.js
git commit -m "refactor: replace mongoose connection with prisma singleton"
```

---

## Task 4: Migrar `services/logger.js`

**Files:**
- Modify: `services/logger.js`

- [ ] **Passo 1: Substituir conteúdo completo de `services/logger.js`**

```js
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
```

- [ ] **Passo 2: Commit**

```bash
git add services/logger.js
git commit -m "refactor(logger): replace mongoose with prisma"
```

---

## Task 5: Migrar `services/authService.js`

**Files:**
- Modify: `services/authService.js`

- [ ] **Passo 1: Substituir conteúdo completo de `services/authService.js`**

```js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

const DEFAULT_JWT_TTL = "7d";

function getJwtSecret() {
    return process.env.JWT_SECRET || "dev-secret-change-me";
}

export async function registerUser({ email, password, name }) {
    const normalized = String(email || "").toLowerCase().trim();
    if (!normalized || !password) {
        throw new Error("Email e senha são obrigatórios");
    }
    const exists = await prisma.user.findUnique({ where: { email: normalized } });
    if (exists) {
        throw new Error("Email já cadastrado");
    }
    const passwordHash = await bcrypt.hash(password, 10);
    return prisma.user.create({
        data: { email: normalized, name: name || "", passwordHash, status: "pending" },
    });
}

export async function authenticateUser({ email, password }) {
    const normalized = String(email || "").toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email: normalized } });
    if (!user) throw new Error("Credenciais inválidas");
    const ok = await bcrypt.compare(password || "", user.passwordHash);
    if (!ok) throw new Error("Credenciais inválidas");
    if (user.status === "pending") throw new Error("Cadastro pendente de aprovação");
    if (user.status === "blocked") throw new Error("Usuário bloqueado");
    const token = jwt.sign(
        { sub: user.id, email: user.email },
        getJwtSecret(),
        { expiresIn: process.env.JWT_TTL || DEFAULT_JWT_TTL }
    );
    return { user, token };
}

export function verifyToken(token) {
    return jwt.verify(token, getJwtSecret());
}

export async function getUserById(id) {
    return prisma.user.findUnique({ where: { id } });
}

export async function listUsers({ status }) {
    const where = status ? { status } : {};
    return prisma.user.findMany({ where, orderBy: { createdAt: "desc" } });
}

export async function setUserStatus(id, status) {
    try {
        return await prisma.user.update({ where: { id }, data: { status } });
    } catch (err) {
        if (err.code === "P2025") return null;
        throw err;
    }
}
```

- [ ] **Passo 2: Atualizar referências `_id` → `id` em `routes/auth.js`**

No arquivo `routes/auth.js`, substituir todas as ocorrências de `user._id` por `user.id`:

Linha ~37 (resposta de login):
```js
user: { id: user.id, email: user.email, name: user.name, status: user.status },
```

Linha ~53 (resposta de `/auth/me`):
```js
user: {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
},
```

Linha ~76 (listagem de usuários):
```js
users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    createdAt: u.createdAt,
}))
```

- [ ] **Passo 3: Commit**

```bash
git add services/authService.js routes/auth.js
git commit -m "refactor(auth): replace mongoose User with prisma"
```

---

## Task 6: Migrar `services/personaConfig.js`

**Files:**
- Modify: `services/personaConfig.js`

- [ ] **Passo 1: Substituir conteúdo completo de `services/personaConfig.js`**

```js
import { prisma } from "./db.js";
import { OpenAI } from "openai";
import { AI_PERSONA_DEFAULT, AI_PERSONA_GUARDS } from "./personaConstants.js";
import { log } from "./logger.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let cache = {
    prompt: null,
    loadedAt: 0,
};
const cacheTtlMs = 5 * 60 * 1000;

function buildPersonaPrompt(userPrompt) {
    const tone = (userPrompt || AI_PERSONA_DEFAULT).trim();
    return `${AI_PERSONA_GUARDS.trim()}\n\n${tone}`;
}

export async function getPersonaPrompt(force = false) {
    const now = Date.now();
    if (!force && cache.prompt && now - cache.loadedAt < cacheTtlMs) {
        return cache.prompt;
    }
    const doc = await prisma.personaConfig.findFirst();
    const prompt = buildPersonaPrompt(doc?.prompt);
    cache = { prompt, loadedAt: now };
    return prompt;
}

async function validatePersonaPrompt(prompt) {
    const systemPrompt = buildPersonaPrompt(prompt);
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY nao configurada para validar persona");
    }
    try {
        const resp = await openai.responses.create({
            model: process.env.OPENAI_MODEL_GREET || "gpt-5-mini",
            instructions: systemPrompt,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: "Gere uma frase de teste de bom dia sarcastica, curta, com ate 2 frases. Nao use labels ou listas.",
                        },
                    ],
                },
            ],
            max_output_tokens: 100,
        });
        const text =
            resp?.output_text ||
            resp?.output?.[0]?.content?.[0]?.text ||
            null;
        if (!text || !text.trim()) throw new Error("Resposta vazia");
        return text.trim();
    } catch (err) {
        log(`Validação da persona falhou: ${err.message}`, "warning");
        throw new Error(
            "A OpenAI recusou ou retornou vazio com esse prompt. Ajuste o texto da persona."
        );
    }
}

export async function savePersonaPrompt(prompt) {
    await validatePersonaPrompt(prompt);
    const doc = await prisma.personaConfig.upsert({
        where: { id: 1 },
        update: { prompt },
        create: { id: 1, prompt },
    });
    cache = { prompt: buildPersonaPrompt(doc.prompt), loadedAt: Date.now() };
    return cache.prompt;
}

export function getPersonaCache() {
    return cache;
}
```

- [ ] **Passo 2: Commit**

```bash
git add services/personaConfig.js
git commit -m "refactor(persona): replace mongoose PersonaConfig with prisma"
```

---

## Task 7: Migrar `services/scheduledJobs.js`

**Files:**
- Modify: `services/scheduledJobs.js`

- [ ] **Passo 1: Substituir conteúdo completo de `services/scheduledJobs.js`**

```js
import { Queue, Worker } from "bullmq";
import moment from "moment-timezone";
import path from "path";
import { prisma } from "./db.js";
import { generateAICaption } from "./ai.js";
import { enqueueSendMessage } from "./sendQueue.js";
import { log } from "./logger.js";
import { getRandomMedia } from "../mediaManager.js";

const connection = {
    host: process.env.REDIS_HOST || "redis",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

const queueName = "scheduled-jobs";
const schedQueue = new Queue(queueName, { connection });

function buildRepeatOpts(schedule) {
    let cron = schedule.cron || "";
    if (!schedule.useCronOverride) {
        const [hh = "06", mm = "00"] = (schedule.time || "06:00").split(":");
        const days =
            Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length
                ? schedule.daysOfWeek.join(",")
                : "*";
        cron = `${mm} ${hh} * * ${days}`;
    }
    return {
        cron,
        tz: schedule.timezone || "America/Sao_Paulo",
        startDate: schedule.startDate || undefined,
        endDate: schedule.endDate || undefined,
    };
}

function resolveGreeting(now) {
    const minutes = now.hours() * 60 + now.minutes();
    if (minutes <= 12 * 60) return "bom dia";
    if (minutes <= 18 * 60) return "boa tarde";
    return "boa noite";
}

async function buildEventsContext(tz) {
    const now = moment.tz(tz);
    const start = now.clone().startOf("day");
    const end = now.clone().endOf("day");

    const eventsToday = await prisma.event.findMany({
        where: { date: { gte: start.toDate(), lte: end.toDate() } },
        orderBy: { date: "asc" },
    });

    const nextEvents = await prisma.event.findMany({
        where: { date: { gt: end.toDate() } },
        orderBy: { date: "asc" },
        take: 1,
    });
    const nextEvent = nextEvents[0] || null;

    const names = eventsToday.map((e) => e.name);
    let eventsTodayDetails = null;
    if (eventsToday.length) {
        eventsTodayDetails = eventsToday
            .map((e) => {
                const m = moment.tz(e.date, tz);
                return `${e.name} às ${m.format("HH:mm")}`;
            })
            .join("; ");
    }

    let nearestDateStr = null;
    let countdown = null;
    if (nextEvent) {
        const m = moment.tz(nextEvent.date, tz);
        names.push(nextEvent.name);
        nearestDateStr = `${nextEvent.name} em ${m.format("DD/MM/YYYY [às] HH:mm")}`;
        const diff = moment.duration(m.diff(now));
        countdown = {
            days: Math.max(0, Math.floor(diff.asDays())),
            hours: diff.hours(),
            minutes: diff.minutes(),
        };
    }

    return {
        names,
        eventsTodayDetails,
        nearestDateStr,
        countdown,
        hasEvents: names.length > 0,
    };
}

export async function clearRepeat(schedule) {
    if (!schedule.repeatJobKey) return;
    try {
        await schedQueue.removeRepeatableByKey(schedule.repeatJobKey);
    } catch (err) {
        log(`Erro ao remover repeatable ${schedule.id}: ${err.message}`, "warn");
    }
}

export async function registerRepeat(schedule) {
    if (!schedule.active) return null;
    const repeat = buildRepeatOpts(schedule);
    const job = await schedQueue.add(
        "run-schedule",
        { scheduleId: schedule.id },
        {
            repeat,
            removeOnComplete: true,
            removeOnFail: 20,
            jobId: `schedule:${schedule.id}`,
        }
    );
    const repeatJobKey = job?.repeatJobKey || "";
    await prisma.schedule.update({
        where: { id: schedule.id },
        data: { repeatJobKey },
    });
    return job;
}

export async function resyncSchedules() {
    const all = await prisma.schedule.findMany();
    for (const sch of all) {
        if (!sch.repeatJobKey) continue;
        try {
            await schedQueue.removeRepeatableByKey(sch.repeatJobKey);
        } catch (_) {}
    }
    const docs = await prisma.schedule.findMany({ where: { active: true } });
    for (const doc of docs) {
        await registerRepeat(doc);
    }
    log(`Resync schedules: ${docs.length} ativos registrados`, "info");
}

function shouldRunToday(schedule, now) {
    if (schedule.startDate && moment(now).isBefore(schedule.startDate)) return false;
    if (schedule.endDate && moment(now).isAfter(schedule.endDate)) return false;
    if (Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length) {
        const dow = moment(now).tz(schedule.timezone || "America/Sao_Paulo").day();
        if (!schedule.daysOfWeek.includes(dow)) return false;
    }
    return true;
}

async function processScheduleJob(scheduleId) {
    const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
    if (!schedule || !schedule.active) return;
    const now = moment.tz(schedule.timezone || "America/Sao_Paulo");
    if (!shouldRunToday(schedule, now)) return;

    const greetingHint = resolveGreeting(now);
    const shouldAnnounceEvents = !!schedule.announceEvents;
    const eventsContext = shouldAnnounceEvents
        ? await buildEventsContext(schedule.timezone || "America/Sao_Paulo")
        : { names: [], eventsTodayDetails: null, nearestDateStr: null, countdown: null, hasEvents: false };

    let caption = null;
    if (schedule.captionMode === "custom") caption = schedule.customCaption || "";
    else if (schedule.captionMode === "auto") {
        try {
            caption = await generateAICaption({
                purpose: "greeting",
                names: eventsContext.names,
                timeStr: eventsContext.eventsTodayDetails,
                announceEvents: shouldAnnounceEvents,
                noEvents: shouldAnnounceEvents ? !eventsContext.hasEvents : null,
                dayOfWeek: now.format("dddd"),
                todayDateStr: now.format("DD/MM/YYYY"),
                personaOverride: schedule.personaPrompt || null,
                eventsTodayDetails: eventsContext.eventsTodayDetails,
                nearestDateStr: eventsContext.nearestDateStr,
                countdown: eventsContext.countdown,
                greetingHint,
            });
        } catch (err) {
            log(`Falha ao gerar caption auto: ${err.message}`, "warn");
        }
    }

    const payloads = [];
    const groupId =
        process.env.GROUP_ID ||
        process.env.ALLOWED_PING_GROUP ||
        "120363339314665620@g.us";
    const mediaUrl = schedule.mediaUrl || "";

    if (schedule.type === "text") {
        payloads.push({ groupId, type: "text", content: schedule.textContent || "" });
    } else {
        payloads.push({
            groupId,
            type: schedule.type,
            content: mediaUrl,
            caption: caption || undefined,
        });
    }

    if (schedule.includeRandomPool !== false) {
        const randomMedia = await getRandomMedia();
        const randomTextRows = await prisma.$queryRaw`
            SELECT * FROM "Phrase" ORDER BY RANDOM() LIMIT 1
        `;
        const randomTextDoc = Array.isArray(randomTextRows) ? randomTextRows[0] : null;
        const candidates = [];
        if (randomMedia) candidates.push({ kind: "media", data: randomMedia });
        if (randomTextDoc) {
            candidates.push({
                kind: "text",
                data: { type: "text", content: randomTextDoc.text || "", id: randomTextDoc.id || null },
            });
        }
        if (candidates.length) {
            const choice = candidates[Math.floor(Math.random() * candidates.length)];
            const isText = choice.kind === "text" || choice.data.type === "text";
            const typeLabel = isText ? "Frase" : choice.data.type === "image" ? "Foto" : "Vídeo";
            if (schedule.includeIntro) {
                payloads.push({ groupId, type: "text", content: `${typeLabel} do dia:` });
            }
            if (isText) {
                payloads.push({
                    groupId,
                    type: "text",
                    content: choice.data.content || "",
                    cleanup: choice.data.id ? { type: "phrase", id: choice.data.id } : undefined,
                });
            } else {
                const baseInternal = (
                    process.env.MEDIA_BASE_URL ||
                    process.env.BACKEND_PUBLIC_URL ||
                    "http://backend:3000"
                ).replace(/\/+$/, "");
                const filename = path.basename(choice.data.path);
                payloads.push({
                    groupId,
                    type: choice.data.type,
                    content: `${baseInternal}/media/${choice.data.type}/${filename}`,
                    cleanup: { type: choice.data.type, filename, scope: "media" },
                });
            }
        }
    }

    for (const p of payloads) {
        await enqueueSendMessage(p);
    }
}

export function startScheduledWorker() {
    const worker = new Worker(
        queueName,
        async (job) => {
            if (job.name !== "run-schedule") return;
            const scheduleId = job.data?.scheduleId;
            if (!scheduleId) return;
            await processScheduleJob(scheduleId);
        },
        { connection }
    );

    worker.on("failed", (job, err) => {
        log(`scheduled job ${job?.id} failed: ${err?.message}`, "error");
    });

    log("Scheduled worker iniciado", "info");
    return worker;
}
```

- [ ] **Passo 2: Commit**

```bash
git add services/scheduledJobs.js
git commit -m "refactor(scheduled-jobs): replace mongoose with prisma"
```

---

## Task 8: Migrar `handlers/triggers.js` e `handlers/commands.js`

**Files:**
- Modify: `handlers/triggers.js`
- Modify: `handlers/commands.js`
- Modify: `handlers/incoming.js`

- [ ] **Passo 1: Substituir conteúdo completo de `handlers/triggers.js`**

```js
import removeAccentsLib from "remove-accents";
import { prisma } from "../services/db.js";
import { enqueueSendMessage } from "../services/sendQueue.js";

function removeAccents(str) {
    return removeAccentsLib(str || "");
}

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
        const normalizedText = normalize(text, trigger.normalizeAccents, trigger.caseSensitive);
        for (const phrase of phrases) {
            if (!phrase) continue;
            if (trigger.matchType === "regex") {
                const pattern = normalize(phrase, trigger.normalizeAccents, trigger.caseSensitive);
                try {
                    const re = new RegExp(pattern, flags);
                    if (re.test(normalizedText)) return true;
                } catch (_) {
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
        const digits = (str.split("@")[0] || "").replace(/\D/g, "");
        return digits;
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
            const list = await prisma.trigger.findMany();
            cache = { items: list, fetchedAt: now };
            return list;
        } catch (err) {
            log(`Erro ao carregar triggers: ${err.message}`, "error");
            return [];
        }
    }

    async function updateUseCount(triggerId) {
        try {
            await prisma.trigger.update({
                where: { id: triggerId },
                data: { triggeredCount: { increment: 1 } },
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
            const senderId = msg.author || msg.id?.participant || msg.from || "";
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
                if (mediaUrl && !mediaUrl.startsWith("http") && process.env.BACKEND_PUBLIC_URL) {
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
                    await enqueueSendMessage(payload, { idempotencyKey: `${msg.id}-${trig.id}` });
                    lastGlobalCooldown.set(globalKey, now);
                    lastUserCooldown.set(userKey, now);
                    updateUseCount(trig.id);
                    cache.fetchedAt = 0;
                    break;
                } catch (err) {
                    log(`Erro ao enfileirar resposta do trigger: ${err.message}`, "error");
                }
            }
        } catch (err) {
            log(`Erro no processor de triggers: ${err.message}`, "error");
        }
    };
}
```

- [ ] **Passo 2: Atualizar `handlers/commands.js`**

Substituir a assinatura da função e uso de `AnalysisLog`:

- Linha 7: trocar `AnalysisLog,` por `prisma,`
- Linha 195–208: trocar `await AnalysisLog.create({...})` por `await prisma.analysisLog.create({ data: {...} })`:

```js
export function createCommandProcessor({
    log,
    generateAIAnalysis,
    prisma,
    MAX_MESSAGE_LENGTH,
    ANALYSE_COOLDOWN_SECONDS,
    isDbConnected,
    enqueueSendMessage,
}) {
```

E no bloco de criação do log (dentro de `handleAnaliseCommand`):

```js
if (isDbConnected && isDbConnected()) {
    try {
        await prisma.analysisLog.create({
            data: {
                user: userId,
                chatId: msg.from,
                requestedN: n,
                analyzedCount: toAnalyze.length,
                messages: toAnalyze.map((m, i) => ({
                    idx: i + 1,
                    sender: m.senderName || m.author || "desconhecido",
                    text: (m.body || "").slice(0, 1000),
                })),
                result: analysis,
                durationMs: Date.now() - start,
            },
        });
    } catch (createErr) {
        log(`Erro ao salvar AnalysisLog: ${createErr.message}`, "error");
    }
}
```

- [ ] **Passo 3: Atualizar `handlers/incoming.js`**

Trocar `AnalysisLog` por `prisma` na assinatura e no repasse:

```js
export function createIncomingProcessor({ log, isDbConnected, generateAIAnalysis, prisma, enqueueSendMessage }) {
    const triggerProcessor = createTriggerProcessor({ log, isDbConnected });
    const commandProcessor = createCommandProcessor({
        log,
        generateAIAnalysis,
        prisma,
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
```

- [ ] **Passo 4: Commit**

```bash
git add handlers/triggers.js handlers/commands.js handlers/incoming.js
git commit -m "refactor(handlers): replace mongoose Trigger/AnalysisLog with prisma"
```

---

## Task 9: Migrar `routes/events.js` e `routes/frases.js`

**Files:**
- Modify: `routes/events.js`
- Modify: `routes/frases.js`

- [ ] **Passo 1: Substituir conteúdo completo de `routes/events.js`**

```js
export function registerEventRoutes(app, { prisma, isDbConnected, tz, moment }) {
    app.get("/events", async (req, res) => {
        if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
        try {
            const now = new Date();
            const events = await prisma.event.findMany({
                where: { announced: false, claimedBy: null, date: { gt: now } },
                orderBy: { date: "asc" },
            });
            res.json(events);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/events", async (req, res) => {
        if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
        try {
            const { name, date } = req.body;
            if (!name || !date)
                return res.status(400).json({ error: "name and date are required" });

            let m = tz(date, "America/Sao_Paulo");
            if (!m.isValid()) {
                m = moment(date);
                if (!m.isValid())
                    return res.status(400).json({ error: "Invalid date format" });
            }

            const nowSP = tz("America/Sao_Paulo");
            if (m.isBefore(nowSP)) {
                return res.status(400).json({ error: "Cannot create event in the past" });
            }

            const ev = await prisma.event.create({ data: { name, date: m.toDate() } });
            res.status(201).json(ev);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete("/events/:id", async (req, res) => {
        if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
        try {
            await prisma.event.delete({ where: { id: req.params.id } });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}
```

- [ ] **Passo 2: Substituir conteúdo completo de `routes/frases.js`**

```js
export function registerPhraseRoutes(app, { MAX_MESSAGE_LENGTH, prisma }) {
    app.get("/frases", async (_req, res) => {
        try {
            const docs = await prisma.phrase.findMany({ orderBy: { createdAt: "asc" } });
            res.json(docs.map((d) => d.text));
        } catch (error) {
            console.error("Erro ao buscar frases:", error);
            res.status(500).json({ error: "Erro ao buscar frases" });
        }
    });

    app.post("/frases", async (req, res) => {
        try {
            const { frase } = req.body || {};
            if (!frase) {
                return res.status(400).json({ error: "Frase e obrigatoria" });
            }
            if (frase.length > MAX_MESSAGE_LENGTH) {
                return res.status(400).json({
                    error: `A frase deve ter no maximo ${MAX_MESSAGE_LENGTH} caracteres`,
                    maxLength: MAX_MESSAGE_LENGTH,
                });
            }
            const doc = await prisma.phrase.create({ data: { text: frase } });
            res.status(201).json({ message: "Frase adicionada com sucesso", frase: doc.text });
        } catch (error) {
            console.error("Erro ao adicionar frase:", error);
            res.status(500).json({ error: "Erro ao adicionar frase" });
        }
    });

    app.delete("/frases/by-id/:id", async (req, res) => {
        try {
            const { id } = req.params;
            if (!id) return res.status(400).json({ error: "ID obrigatorio" });
            try {
                await prisma.phrase.delete({ where: { id } });
            } catch (err) {
                if (err.code === "P2025")
                    return res.status(404).json({ error: "Frase nao encontrada" });
                throw err;
            }
            res.json({ message: "Frase removida com sucesso" });
        } catch (error) {
            res.status(500).json({ error: "Erro ao remover frase" });
        }
    });

    app.delete("/frases/:index", async (req, res) => {
        try {
            const index = parseInt(req.params.index, 10);
            const docs = await prisma.phrase.findMany({ orderBy: { createdAt: "asc" } });
            if (Number.isNaN(index) || index < 0 || index >= docs.length) {
                return res.status(404).json({ error: "Frase nao encontrada" });
            }
            await prisma.phrase.delete({ where: { id: docs[index].id } });
            res.json({ message: "Frase removida com sucesso" });
        } catch (error) {
            res.status(500).json({ error: "Erro ao remover frase" });
        }
    });
}
```

- [ ] **Passo 3: Commit**

```bash
git add routes/events.js routes/frases.js
git commit -m "refactor(routes): replace mongoose Event/Phrase with prisma"
```

---

## Task 10: Migrar `routes/triggers.js` e `routes/schedules.js`

**Files:**
- Modify: `routes/triggers.js`
- Modify: `routes/schedules.js`

- [ ] **Passo 1: Substituir conteúdo completo de `routes/triggers.js`**

```js
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../services/db.js";

function parseTriggerPayload(body) {
    const safe = {};
    safe.name = (body.name || "").toString().trim();
    safe.phrases = Array.isArray(body.phrases)
        ? body.phrases.map((p) => (p || "").toString().trim()).filter((p) => p.length > 0)
        : [];
    safe.matchType = ["exact", "contains", "regex"].includes(body.matchType)
        ? body.matchType
        : "exact";
    safe.caseSensitive = !!body.caseSensitive;
    safe.normalizeAccents =
        typeof body.normalizeAccents === "boolean" ? body.normalizeAccents : true;
    safe.wholeWord = !!body.wholeWord;
    safe.responseType = ["text", "image", "video"].includes(body.responseType)
        ? body.responseType
        : "text";
    safe.responseText = (body.responseText || "").toString();
    safe.responseMediaUrl = (body.responseMediaUrl || "").toString();
    safe.replyMode = ["reply", "new"].includes(body.replyMode) ? body.replyMode : "reply";
    safe.mentionSender = !!body.mentionSender;
    safe.chancePercent = Math.min(
        100,
        Math.max(0, Number.parseFloat(body.chancePercent ?? 100) || 0)
    );
    safe.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    safe.maxUses = body.maxUses ? Number.parseInt(body.maxUses, 10) || null : null;
    safe.cooldownSeconds = Math.max(0, Number.parseInt(body.cooldownSeconds || 0, 10));
    safe.cooldownPerUserSeconds = Math.max(
        0,
        Number.parseInt(body.cooldownPerUserSeconds || 0, 10)
    );
    safe.active = body.active !== undefined ? !!body.active : true;
    safe.allowedUsers = Array.isArray(body.allowedUsers)
        ? body.allowedUsers.map((u) => (u || "").toString().trim()).filter(Boolean)
        : [];
    return safe;
}

function validateTriggerPayload(payload) {
    if (!payload.phrases || payload.phrases.length === 0) {
        throw new Error("Pelo menos uma frase/palavra é obrigatória");
    }
    if (payload.responseType === "text" && !payload.responseText.trim()) {
        throw new Error("Resposta de texto é obrigatória para responseType=text");
    }
    if (
        (payload.responseType === "image" || payload.responseType === "video") &&
        !payload.responseMediaUrl
    ) {
        throw new Error("responseMediaUrl é obrigatório para mídia");
    }
    if (payload.expiresAt && isNaN(payload.expiresAt.getTime())) {
        throw new Error("Data de expiração inválida");
    }
    if (payload.expiresAt && payload.expiresAt.getTime() <= Date.now()) {
        throw new Error("A data de expiração deve ser no futuro");
    }
    if (payload.maxUses !== null && payload.maxUses < 0) {
        throw new Error("maxUses deve ser >= 0");
    }
}

export function registerTriggerRoutes(app) {
    app.get("/triggers", requireAuth, async (req, res) => {
        try {
            const list = await prisma.trigger.findMany({ orderBy: { createdAt: "desc" } });
            res.json(list);
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao listar triggers" });
        }
    });

    app.post("/triggers", requireAuth, async (req, res) => {
        try {
            const payload = parseTriggerPayload(req.body || {});
            validateTriggerPayload(payload);
            const created = await prisma.trigger.create({ data: payload });
            res.status(201).json(created);
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao criar trigger" });
        }
    });

    app.put("/triggers/:id", requireAuth, async (req, res) => {
        try {
            const payload = parseTriggerPayload(req.body || {});
            validateTriggerPayload(payload);
            let updated;
            try {
                updated = await prisma.trigger.update({
                    where: { id: req.params.id },
                    data: payload,
                });
            } catch (err) {
                if (err.code === "P2025")
                    return res.status(404).json({ error: "Trigger não encontrada" });
                throw err;
            }
            res.json(updated);
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao atualizar trigger" });
        }
    });

    app.delete("/triggers/:id", requireAuth, async (req, res) => {
        try {
            try {
                await prisma.trigger.delete({ where: { id: req.params.id } });
            } catch (err) {
                if (err.code === "P2025")
                    return res.status(404).json({ error: "Trigger não encontrada" });
                throw err;
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao remover trigger" });
        }
    });
}
```

- [ ] **Passo 2: Substituir conteúdo completo de `routes/schedules.js`**

```js
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../services/db.js";
import { clearRepeat, registerRepeat, resyncSchedules } from "../services/scheduledJobs.js";

function parseSchedule(body) {
    const safe = {};
    safe.name = (body.name || "").toString().trim() || "Mensagem";
    safe.kind = ["greeting"].includes(body.kind) ? body.kind : "greeting";
    const inferMediaType = (url) => {
        const lower = (url || "").toLowerCase();
        const videoExt = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
        if (videoExt.some((ext) => lower.endsWith(ext))) return "video";
        return "image";
    };
    const rawType = (body.type || "").toString();
    safe.mediaUrl = (body.mediaUrl || "").toString().trim();
    const inferredType =
        rawType === "text"
            ? "text"
            : ["image", "video"].includes(rawType)
            ? rawType
            : inferMediaType(safe.mediaUrl);
    safe.type = inferredType || "text";
    safe.textContent = (body.textContent || "").toString();
    safe.captionMode = ["auto", "custom", "none"].includes(body.captionMode)
        ? body.captionMode
        : "auto";
    safe.customCaption = (body.customCaption || "").toString();
    safe.includeIntro = body.includeIntro !== undefined ? !!body.includeIntro : true;
    safe.includeRandomPool =
        body.includeRandomPool !== undefined ? !!body.includeRandomPool : true;
    safe.announceEvents = body.announceEvents !== undefined ? !!body.announceEvents : false;
    safe.personaPrompt = (body.personaPrompt || "").toString();
    safe.useCronOverride = !!body.useCronOverride;
    safe.cron = (body.cron || "").toString().trim();
    safe.time = (body.time || "06:00").toString().trim();
    safe.timezone = "America/Sao_Paulo";
    safe.startDate = body.startDate ? new Date(body.startDate) : null;
    safe.endDate = body.endDate ? new Date(body.endDate) : null;
    safe.daysOfWeek = Array.isArray(body.daysOfWeek)
        ? body.daysOfWeek.map((d) => parseInt(d, 10)).filter((n) => !Number.isNaN(n))
        : [];
    safe.active = body.active !== undefined ? !!body.active : true;

    if (!safe.useCronOverride) {
        const [hh = "06", mm = "00"] = safe.time.split(":");
        const days =
            Array.isArray(safe.daysOfWeek) && safe.daysOfWeek.length
                ? safe.daysOfWeek.join(",")
                : "*";
        safe.cron = `${mm} ${hh} * * ${days}`;
    }
    return safe;
}

export function registerScheduleRoutes(app) {
    app.get("/schedules", requireAuth, async (_req, res) => {
        try {
            const list = await prisma.schedule.findMany({ orderBy: { createdAt: "desc" } });
            res.json(list);
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao listar schedules" });
        }
    });

    app.post("/schedules", requireAuth, async (req, res) => {
        try {
            const payload = parseSchedule(req.body || {});
            if (!payload.cron) return res.status(400).json({ error: "cron é obrigatório" });
            const created = await prisma.schedule.create({ data: payload });
            await registerRepeat(created);
            res.status(201).json(created);
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao criar schedule" });
        }
    });

    app.put("/schedules/:id", requireAuth, async (req, res) => {
        try {
            const payload = parseSchedule(req.body || {});
            if (!payload.cron) return res.status(400).json({ error: "cron é obrigatório" });
            const existing = await prisma.schedule.findUnique({ where: { id: req.params.id } });
            if (!existing) return res.status(404).json({ error: "Schedule não encontrado" });
            await clearRepeat(existing);
            const updated = await prisma.schedule.update({
                where: { id: req.params.id },
                data: payload,
            });
            await registerRepeat(updated);
            res.json(updated);
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao atualizar schedule" });
        }
    });

    app.delete("/schedules/:id", requireAuth, async (req, res) => {
        try {
            const existing = await prisma.schedule.findUnique({ where: { id: req.params.id } });
            if (!existing) return res.status(404).json({ error: "Schedule não encontrado" });
            await clearRepeat(existing);
            await prisma.schedule.delete({ where: { id: req.params.id } });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao remover schedule" });
        }
    });

    app.post("/schedules/resync", requireAuth, async (_req, res) => {
        try {
            await resyncSchedules();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao resync schedules" });
        }
    });
}
```

- [ ] **Passo 3: Commit**

```bash
git add routes/triggers.js routes/schedules.js
git commit -m "refactor(routes): replace mongoose Trigger/Schedule with prisma"
```

---

## Task 11: Migrar rotas restantes

**Files:**
- Modify: `routes/logs.js`
- Modify: `routes/logIngest.js`
- Modify: `routes/groupContext.js`
- Modify: `routes/persona.js`

- [ ] **Passo 1: Substituir conteúdo completo de `routes/logs.js`**

```js
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../services/db.js";

export function registerLogRoutes(app) {
    app.get("/logs", requireAuth, async (req, res) => {
        try {
            const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "100", 10)));
            const source = req.query.source;
            const logs = await prisma.logEntry.findMany({
                where: source ? { source } : {},
                orderBy: { createdAt: "desc" },
                take: limit,
            });
            res.json(logs);
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao buscar logs" });
        }
    });
}
```

- [ ] **Passo 2: Substituir conteúdo completo de `routes/logIngest.js`**

```js
import { prisma } from "../services/db.js";

export function registerLogIngestRoute(app) {
    app.post("/logs/ingest", async (req, res) => {
        try {
            const token =
                req.headers["x-log-token"] || req.headers["x-log-ingest-token"];
            const expected = process.env.LOG_INGEST_TOKEN;
            if (!expected || !token || token !== expected) {
                return res.status(401).json({ error: "Unauthorized" });
            }
            const { source = "external", level = "info", message, meta = null } =
                req.body || {};
            if (!message) {
                return res.status(400).json({ error: "message é obrigatório" });
            }
            const doc = await prisma.logEntry.create({
                data: { source, level, message: String(message), meta: meta ?? undefined },
            });
            return res.status(201).json({ id: doc.id });
        } catch (err) {
            return res.status(500).json({ error: err.message || "Erro ao salvar log" });
        }
    });
}
```

- [ ] **Passo 3: Substituir conteúdo completo de `routes/groupContext.js`**

```js
import { requireAuth } from "../middleware/auth.js";
import { enqueueGroupContextJob } from "../services/groupContextQueue.js";
import { prisma } from "../services/db.js";

export function registerGroupContextRoutes(app) {
    app.post("/context/refresh", requireAuth, async (req, res) => {
        try {
            const groupId =
                req.body?.groupId ||
                process.env.GROUP_ID ||
                process.env.ALLOWED_PING_GROUP;
            if (!groupId) {
                return res.status(400).json({ error: "groupId é obrigatório" });
            }
            await enqueueGroupContextJob(groupId);
            res.json({ message: "Job de contexto enfileirado", groupId });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao enfileirar" });
        }
    });

    app.post("/context/ingest", async (req, res) => {
        try {
            const token = req.headers["x-context-token"] || req.query.token;
            const expected = process.env.CONTEXT_INGEST_TOKEN || process.env.LOG_INGEST_TOKEN;
            if (!expected || token !== expected) {
                return res.status(401).json({ error: "Token inválido" });
            }
            const { groupId, subject, description, members } = req.body || {};
            if (!groupId) return res.status(400).json({ error: "groupId é obrigatório" });

            const payload = {
                subject: subject || "",
                description: description || "",
                members: Array.isArray(members) ? members : [],
                fetchedAt: new Date(),
            };
            await prisma.groupContext.upsert({
                where: { groupId },
                update: payload,
                create: { groupId, ...payload },
            });
            res.json({ message: "Contexto salvo", groupId });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao salvar contexto" });
        }
    });

    app.get("/context/:groupId", requireAuth, async (req, res) => {
        try {
            const doc = await prisma.groupContext.findUnique({
                where: { groupId: req.params.groupId },
            });
            if (!doc) return res.status(404).json({ error: "Contexto não encontrado" });
            res.json(doc);
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao buscar contexto" });
        }
    });
}
```

- [ ] **Passo 4: Substituir conteúdo completo de `routes/persona.js`**

```js
import { requireAuth } from "../middleware/auth.js";
import { getPersonaPrompt, savePersonaPrompt, getPersonaCache } from "../services/personaConfig.js";
import { AI_PERSONA_DEFAULT } from "../services/personaConstants.js";
import { prisma } from "../services/db.js";

export function registerPersonaRoutes(app) {
    app.get("/persona", requireAuth, async (_req, res) => {
        try {
            const doc = await prisma.personaConfig.findFirst();
            const prompt = doc?.prompt || AI_PERSONA_DEFAULT.trim();
            res.json({
                prompt,
                cache: getPersonaCache(),
                default: AI_PERSONA_DEFAULT.trim(),
            });
        } catch (err) {
            res.status(500).json({ error: err.message || "Erro ao obter persona" });
        }
    });

    app.put("/persona", requireAuth, async (req, res) => {
        try {
            const prompt = (req.body?.prompt || "").toString();
            if (!prompt.trim()) {
                return res.status(400).json({ error: "Prompt não pode ser vazio" });
            }
            const saved = await savePersonaPrompt(prompt);
            res.json({ prompt: saved });
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao salvar persona" });
        }
    });
}
```

- [ ] **Passo 5: Commit**

```bash
git add routes/logs.js routes/logIngest.js routes/groupContext.js routes/persona.js
git commit -m "refactor(routes): replace mongoose LogEntry/GroupContext/PersonaConfig with prisma"
```

---

## Task 12: Atualizar `app.js`

**Files:**
- Modify: `app.js`

- [ ] **Passo 1: Substituir conteúdo completo de `app.js`**

```js
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
```

- [ ] **Passo 2: Commit**

```bash
git add app.js
git commit -m "refactor(app): wire prisma, remove connectDb and model imports"
```

---

## Task 13: Deletar `models/` e limpar `package.json`

**Files:**
- Delete: todos os arquivos em `models/`
- Modify: `package.json`

- [ ] **Passo 1: Deletar os 9 model files**

```bash
rm como-ja-e-dia-backend/models/user.js \
   como-ja-e-dia-backend/models/event.js \
   como-ja-e-dia-backend/models/phrase.js \
   como-ja-e-dia-backend/models/trigger.js \
   como-ja-e-dia-backend/models/schedule.js \
   como-ja-e-dia-backend/models/groupContext.js \
   como-ja-e-dia-backend/models/personaConfig.js \
   como-ja-e-dia-backend/models/analysisLog.js \
   como-ja-e-dia-backend/models/logEntry.js
rmdir como-ja-e-dia-backend/models
```

- [ ] **Passo 2: Verificar que `mongoose` e `mongodb` já foram removidos do `package.json`**

```bash
grep -c "mongoose\|mongodb" como-ja-e-dia-backend/package.json
```

Saída esperada: `0`. Se não for zero, remover manualmente as linhas correspondentes e rodar `npm install`.

- [ ] **Passo 3: Commit**

```bash
git add -A
git commit -m "chore: delete models/ directory (replaced by prisma)"
```

---

## Task 14: Atualizar `whatsapp-web.js` para `1.34.6`

**Files:**
- Modify: `package.json`

- [ ] **Passo 1: Atualizar versão no `package.json`**

No arquivo `package.json`, na seção `dependencies`, alterar:

```json
"whatsapp-web.js": "^1.34.6"
```

- [ ] **Passo 2: Instalar**

```bash
cd como-ja-e-dia-backend
npm install
```

Saída esperada: `added/updated X packages` sem erros.

- [ ] **Passo 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump whatsapp-web.js to 1.34.6"
```

---

## Task 15: Verificação final

- [ ] **Passo 1: Garantir que postgres está rodando**

```bash
docker compose up postgres -d
```

- [ ] **Passo 2: Aplicar schema ao banco**

```bash
cd como-ja-e-dia-backend
npx prisma db push
```

Saída esperada: `✔ Your database is now in sync with your Prisma schema.`

- [ ] **Passo 3: Subir o servidor**

```bash
node app.js
```

Saída esperada (nas primeiras linhas):
```
[INFO] Conectado ao PostgreSQL com sucesso
[SUCCESS] API rodando na porta 3000
[INFO] Scheduled worker iniciado
```

- [ ] **Passo 4: Testar endpoint de health**

```bash
curl http://localhost:3000/health
```

Saída esperada: `200 OK` com JSON de status.

- [ ] **Passo 5: Testar registro de usuário**

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"123456","name":"Teste"}'
```

Saída esperada: `{"message":"Cadastro realizado. Aguarde aprovação.","status":"pending"}`

- [ ] **Passo 6: Testar listagem de frases**

```bash
curl http://localhost:3000/frases
```

Saída esperada: `[]` (banco vazio)

- [ ] **Passo 7: Testar status do banco**

```bash
curl http://localhost:3000/db-status
```

Saída esperada: `{"connected":true}`

- [ ] **Passo 8: Commit final de verificação**

```bash
git add -A
git commit -m "chore: migration complete - mongodb to postgresql via prisma"
```
