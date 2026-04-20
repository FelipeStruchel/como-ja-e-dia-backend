# Design: Migração MongoDB → PostgreSQL (Prisma) + Atualização whatsapp-web.js

**Data:** 2026-04-20  
**Status:** Aprovado

---

## Escopo

Duas mudanças independentes no backend (`como-ja-e-dia-backend`):

1. Substituir MongoDB/Mongoose por PostgreSQL local via Docker, usando Prisma como ORM
2. Atualizar `whatsapp-web.js` de `^1.34.1` para `^1.34.6`

Ponto de partida: banco vazio (sem migração de dados existentes).

---

## Mudança 1: MongoDB → PostgreSQL com Prisma

### Abordagem

Prisma client direto, sem camada de model files. Os 9 arquivos em `models/` são deletados. O `prisma` client é usado diretamente nas rotas e services.

### Schema Prisma (`prisma/schema.prisma`)

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
  id                   String   @id @default(cuid())
  name                 String   @default("")
  phrases              String[]
  matchType            String   @default("exact")
  caseSensitive        Boolean  @default(false)
  normalizeAccents     Boolean  @default(true)
  wholeWord            Boolean  @default(true)
  responseType         String   @default("text")
  responseText         String   @default("")
  responseMediaUrl     String   @default("")
  replyMode            String   @default("reply")
  mentionSender        Boolean  @default(false)
  chancePercent        Float    @default(100)
  expiresAt            DateTime?
  maxUses              Int?
  triggeredCount       Int      @default(0)
  cooldownSeconds      Int      @default(0)
  cooldownPerUserSeconds Int    @default(0)
  active               Boolean  @default(true)
  allowedUsers         String[]
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
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

**Notas do schema:**
- `PersonaConfig` usa `Int @id @default(autoincrement())` com valor fixo `id: 1` — é um singleton, upsert sempre aponta para o mesmo registro
- `GroupContext.members` e `AnalysisLog.messages` são `Json` — sempre lidos/escritos como bloco atômico
- `Trigger.phrases`, `Trigger.allowedUsers`, `Schedule.daysOfWeek` usam arrays nativos do PostgreSQL

### Docker Compose

Adicionar serviço `postgres` ao `docker-compose.yml`:

```yaml
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
```

O serviço `backend` ganha `depends_on: postgres` e o volume `postgres-data` é adicionado à seção `volumes`.

### Variáveis de ambiente

`.env.example`: remover `MONGO_USER`, `MONGO_PASSWORD`, `MONGO_CONNECTION_STRING`. Adicionar:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/comojaedia
```

Para uso com Docker Compose (dentro da rede):
```
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/comojaedia
```

### DB Service (`services/db.js`)

Rewrite completo. Exporta instância singleton do PrismaClient:

```js
import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();
```

O `moment` que era retornado por `connectDb` passa a ser importado diretamente onde necessário.

### Arquivos deletados

Todos os 9 arquivos em `models/`:
- `models/user.js`, `models/event.js`, `models/phrase.js`, `models/trigger.js`
- `models/schedule.js`, `models/groupContext.js`, `models/personaConfig.js`
- `models/analysisLog.js`, `models/logEntry.js`

### Mapeamento de queries

| Mongoose | Prisma |
|---|---|
| `Model.find()` | `prisma.model.findMany()` |
| `Model.find({ f: v })` | `prisma.model.findMany({ where: { f: v } })` |
| `Model.findOne({ f: v })` | `prisma.model.findFirst({ where: { f: v } })` |
| `Model.findById(id)` | `prisma.model.findUnique({ where: { id } })` |
| `new Model(data); await m.save()` | `prisma.model.create({ data })` |
| `Model.create(data)` | `prisma.model.create({ data })` |
| `Model.findByIdAndUpdate(id, data, { new: true })` | `prisma.model.update({ where: { id }, data })` |
| `Model.findByIdAndDelete(id)` | `prisma.model.delete({ where: { id } })` |
| `.sort({ createdAt: -1 })` | `orderBy: { createdAt: 'desc' }` |
| `.limit(n)` | `take: n` |
| `{ $inc: { count: 1 } }` | `{ count: { increment: 1 } }` |
| `Model.findOneAndUpdate({}, data, { upsert: true })` | `prisma.model.upsert({ where, update: data, create: data })` |
| `Phrase.aggregate([{ $sample: { size: 1 } }])` | `prisma.$queryRaw\`SELECT * FROM "Phrase" ORDER BY RANDOM() LIMIT 1\`` |

### Impacto em `_id` → `id`

Todos os documentos do Mongoose usavam `_id`. Com Prisma, o campo é `id`. Impactos diretos:

- `services/authService.js`: JWT payload `sub: user._id.toString()` → `sub: user.id`
- `routes/auth.js`: resposta de login/me `id: user._id` → `id: user.id`
- `services/scheduledJobs.js`: `schedule._id.toString()` → `schedule.id`; `schedule.save()` → `prisma.schedule.update`
- `handlers/triggers.js`: `trig._id.toString()` → `trig.id`
- `routes/frases.js`: `target._id` → `target.id`; `deleteOne({ _id })` → `prisma.phrase.delete({ where: { id } })`
- `routes/logIngest.js`: resposta `doc._id` → `doc.id`

### Mudanças em `app.js`

- Remover `import { connectDb } from "./services/db.js"` e `await connectDb(log)`
- Importar `import { prisma } from "./services/db.js"`
- Importar `moment` diretamente
- Remover imports de `Event`, `AnalysisLog`, `Phrase` dos models
- Passar `prisma` para todas as rotas e services que precisam de acesso ao banco
- Rota `/db-status` verifica conexão via `prisma.$queryRaw\`SELECT 1\``

### `services/logger.js`

Remove a conexão própria ao MongoDB (`ensureDb`, `mongoose.connect`). Usa `prisma.logEntry.create` diretamente. Importa `prisma` de `services/db.js`.

### Arquivos que recebem `prisma` via parâmetro (injeção)

- `routes/events.js` — recebe `{ prisma, tz, moment }`
- `routes/frases.js` — recebe `{ prisma, MAX_MESSAGE_LENGTH }`
- `routes/triggers.js` — recebe `prisma` via import direto (atualmente importa `Trigger` diretamente)
- `routes/schedules.js` — recebe `prisma` via import direto
- `routes/logs.js` — recebe `prisma` via import direto
- `routes/logIngest.js` — recebe `prisma` via import direto
- `routes/groupContext.js` — recebe `prisma` via import direto
- `routes/persona.js` — sem mudança (usa personaConfig service)
- `handlers/commands.js` — recebe `{ prisma }` em vez de `{ AnalysisLog }`
- `services/authService.js` — importa `prisma` diretamente
- `services/personaConfig.js` — importa `prisma` diretamente
- `services/scheduledJobs.js` — importa `prisma` diretamente

### Scripts npm adicionados

```json
"prisma:generate": "prisma generate",
"prisma:migrate": "prisma migrate dev",
"prisma:push": "prisma db push"
```

---

## Mudança 2: Atualização whatsapp-web.js

Bump simples no `package.json`:

```json
"whatsapp-web.js": "^1.34.6"
```

Versão atual: `1.34.1` → nova: `1.34.6`. Patch dentro do mesmo minor — sem breaking changes esperadas.

---

## Dependências novas

```
+ @prisma/client
+ prisma (devDependency)
```

## Dependências removidas

```
- mongoose
- mongodb
```

---

## Ordem de execução sugerida

1. Instalar Prisma e criar `prisma/schema.prisma`
2. Atualizar `docker-compose.yml` e `.env.example`
3. Reescrever `services/db.js`
4. Migrar `services/logger.js` (usado em todo lugar, precisa funcionar cedo)
5. Migrar `services/authService.js`
6. Migrar `services/personaConfig.js`
7. Migrar `services/scheduledJobs.js`
8. Migrar `handlers/triggers.js` e `handlers/commands.js`
9. Migrar `handlers/incoming.js` (ajuste de assinatura)
10. Migrar todas as rotas
11. Atualizar `app.js`
12. Deletar `models/`
13. Remover `mongoose` e `mongodb` do `package.json`
14. Bump `whatsapp-web.js` para `^1.34.6`
15. Rodar `npm install` e `prisma db push`
