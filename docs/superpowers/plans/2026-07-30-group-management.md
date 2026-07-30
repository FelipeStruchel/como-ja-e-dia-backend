# Multi-Group Support with Admin-Managed Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single hardcoded `GROUP_ID`/`ALLOWED_PING_GROUP` env var with a `Group` database table whose 5 boolean feature toggles (pokemon, confessions, scheduled greetings, triggers, context sync) can be managed per-group from the admin frontend, without redeploying — plus mute-all notification silencing for the bot's secondary-chip WhatsApp session.

**Architecture:** A new Prisma `Group` model (id = WhatsApp JID) replaces every env-var read across `handlers/commands.ts`, `services/dropScheduler.ts`, `services/dropService.ts`, `services/scheduledJobs.ts`, `routes/confessions.ts`, `handlers/triggers.ts`, and `routes/groupContext.ts`. A cached (`Redis`, 1-day TTL) group-discovery flow round-trips through a new BullMQ queue to the worker's Baileys session (`groupFetchAllParticipating()`), feeding a shared `GroupPicker` frontend component reused by both the new Groups admin screen and the Trigger form's group selector. A separate repeatable BullMQ job keeps every WhatsApp group muted indefinitely (renews a 1-week mute every 6 days) since the bot's number is also the user's personal secondary-chip phone.

**Tech Stack:** TypeScript, Express, Prisma (Postgres), BullMQ + ioredis, Baileys 7.x (worker), Next.js + MUI (frontend), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-group-management-design.md` — this plan implements it in full; no scope beyond it.
- All 5 toggles default to `false` for newly created `Group` rows; the seeded production group gets all 5 `true`.
- No hard Prisma relation from `groupId` fields to `Group.id` — stay consistent with existing `PokemonDrop.groupId`, `CharacterOwnership.groupId` etc., which are plain strings.
- All new/modified admin routes require `requireRole("super_admin")` (which internally also allows any role passed, but Groups admin is super_admin only per the design).
- Worker→backend callback routes use `requireWorkerOrRole` (header `x-worker-secret` = `WORKER_API_SECRET`), matching the existing pattern in `middleware/auth.ts`.
- Mute duration: `7 * 24 * 60 * 60 * 1000` ms (1 week) per application; renewal job runs every `6 * 24 * 60 * 60 * 1000` ms (6 days).
- Discovery cache TTL: `EX 86400` (1 day) on Redis key `groups:discovered`.
- Frontend never calls the backend directly — always through a Next.js `pages/api/*` proxy using `proxyJson` from `lib/backendApi.js`, matching every existing `pages/api/**` route.

---

## Part 1 — Backend (`como-ja-e-dia-backend`)

### Task 1: `Group` Prisma model + `Trigger.groupId` + migration + seed

**Files:**
- Modify: `prisma/schema.prisma`
- Create: migration via `prisma migrate dev` (auto-named folder under `prisma/migrations/`)
- Modify: `prisma/migrations/<new_folder>/migration.sql` (append seed/backfill SQL after `prisma migrate dev --create-only` generates the DDL)

**Interfaces:**
- Produces: `prisma.group` Prisma Client model with fields `id, name, pokemonEnabled, confessionsEnabled, scheduledGreetingsEnabled, triggersEnabled, contextSyncEnabled, createdAt, updatedAt`. `prisma.trigger` gains `groupId: string`.

- [ ] **Step 1: Add the `Group` model to `prisma/schema.prisma`**

Add this block right after the closing brace of the existing `model LinkedGroup { ... }` (currently ending at line 267):

```prisma
model Group {
  id                        String   @id
  name                      String
  pokemonEnabled            Boolean  @default(false)
  confessionsEnabled        Boolean  @default(false)
  scheduledGreetingsEnabled Boolean  @default(false)
  triggersEnabled           Boolean  @default(false)
  contextSyncEnabled        Boolean  @default(false)
  createdAt                 DateTime @default(now())
  updatedAt                 DateTime @updatedAt
}
```

- [ ] **Step 2: Add `groupId` to the `Trigger` model**

In `prisma/schema.prisma`, find `model Trigger {` (line 54) and add a new field right after `phrases String[]` (line 57):

```prisma
  groupId                String    @default("")
```

(Default `""` only exists so the column can be added without failing on existing rows — Step 4 backfills it, and Task 9 makes the API-level validation require a non-empty value going forward.)

- [ ] **Step 3: Generate the migration (schema-only, no data yet)**

Run: `cd como-ja-e-dia-backend && npx prisma migrate dev --name add_group_table --create-only`
Expected: creates `prisma/migrations/<timestamp>_add_group_table/migration.sql` containing `CREATE TABLE "Group" (...)` and `ALTER TABLE "Trigger" ADD COLUMN "groupId" TEXT NOT NULL DEFAULT ''`.

- [ ] **Step 4: Append seed + backfill SQL to the generated migration file**

Open the generated `migration.sql` and append at the end:

```sql
-- Seed the current production group with every feature enabled (zero-downtime migration)
INSERT INTO "Group" ("id", "name", "pokemonEnabled", "confessionsEnabled", "scheduledGreetingsEnabled", "triggersEnabled", "contextSyncEnabled", "createdAt", "updatedAt")
VALUES (
  COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us'),
  'Grupo principal',
  true, true, true, true, true,
  now(), now()
)
ON CONFLICT ("id") DO NOTHING;

-- Backfill existing triggers to point at that same seeded group
UPDATE "Trigger" SET "groupId" = COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us') WHERE "groupId" = '';
```

Since `current_setting('app.group_id', true)` will be empty in every real deployment (Postgres session vars aren't wired to Node's `process.env`), this always falls back to the hardcoded default `120363339314665620@g.us` — which matches today's `config.groupId` fallback exactly. This is fine: the migration's job is to seed *some* row so the app doesn't regress; if the real production `GROUP_ID` env var ever differs from that fallback, Task 12 below (`registerGroupsBootstrap`) reconciles it on every app boot anyway.

- [ ] **Step 5: Apply the migration and regenerate the client**

Run: `npx prisma migrate deploy && npx prisma generate`
Expected: `Group` table exists, `Trigger.groupId` column exists with 1 backfilled row (or 0 if no triggers exist yet), and `@prisma/client` types include `prisma.group`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add Group table and Trigger.groupId for multi-group support"
```

---

### Task 2: `services/groupService.ts` — shared Group lookups

**Files:**
- Create: `services/groupService.ts`
- Test: `__tests__/groupService.test.ts`

**Interfaces:**
- Consumes: `prisma` from `services/db.js`.
- Produces:
  - `isGroupRegistered(groupId: string): Promise<boolean>` — cached 60s (mirrors the `linkedGroupCache` pattern in `handlers/commands.ts:69-70`).
  - `isPokemonEnabled(groupId: string): Promise<boolean>`
  - `isTriggersEnabledForGroup(groupId: string): Promise<boolean>`
  - `getPokemonEnabledGroupIds(): Promise<string[]>`
  - `getConfessionsEnabledGroupIds(): Promise<string[]>`
  - `getScheduledGreetingsEnabledGroupIds(): Promise<string[]>`
  - `getContextSyncEnabledGroupIds(): Promise<string[]>`
  - `isContextSyncEnabled(groupId: string): Promise<boolean>`
  - `resetGroupCache(): void` (test-only escape hatch to clear the module-level cache between tests)
  - `ensureGroupSeeded(id: string, name: string): Promise<void>` — upsert used by Task 12's boot-time reconciliation.

- [ ] **Step 1: Write the failing test**

Create `__tests__/groupService.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    group: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))

import { prisma } from '../services/db.js'
import {
  isGroupRegistered,
  isPokemonEnabled,
  isTriggersEnabledForGroup,
  getPokemonEnabledGroupIds,
  isContextSyncEnabled,
  resetGroupCache,
  ensureGroupSeeded,
} from '../services/groupService.js'

beforeEach(() => {
  vi.clearAllMocks()
  resetGroupCache()
})

describe('groupService', () => {
  it('isGroupRegistered returns true when a Group row exists', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue({ id: 'g1@g.us' } as any)
    expect(await isGroupRegistered('g1@g.us')).toBe(true)
  })

  it('isGroupRegistered returns false and caches the miss for 60s', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue(null)
    expect(await isGroupRegistered('unknown@g.us')).toBe(false)
    expect(await isGroupRegistered('unknown@g.us')).toBe(false)
    expect(prisma.group.findUnique).toHaveBeenCalledTimes(1)
  })

  it('isPokemonEnabled reflects the pokemonEnabled flag', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue({ id: 'g1@g.us', pokemonEnabled: true } as any)
    expect(await isPokemonEnabled('g1@g.us')).toBe(true)
  })

  it('isPokemonEnabled is false for an unregistered group', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue(null)
    expect(await isPokemonEnabled('unknown@g.us')).toBe(false)
  })

  it('isTriggersEnabledForGroup reflects the triggersEnabled flag', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue({ id: 'g1@g.us', triggersEnabled: false } as any)
    expect(await isTriggersEnabledForGroup('g1@g.us')).toBe(false)
  })

  it('getPokemonEnabledGroupIds maps rows to ids', async () => {
    vi.mocked(prisma.group.findMany).mockResolvedValue([{ id: 'a@g.us' }, { id: 'b@g.us' }] as any)
    expect(await getPokemonEnabledGroupIds()).toEqual(['a@g.us', 'b@g.us'])
    expect(prisma.group.findMany).toHaveBeenCalledWith({
      where: { pokemonEnabled: true },
      select: { id: true },
    })
  })

  it('isContextSyncEnabled reflects the contextSyncEnabled flag', async () => {
    vi.mocked(prisma.group.findUnique).mockResolvedValue({ id: 'g1@g.us', contextSyncEnabled: true } as any)
    expect(await isContextSyncEnabled('g1@g.us')).toBe(true)
  })

  it('ensureGroupSeeded upserts with the given id and name, all toggles left untouched on conflict', async () => {
    vi.mocked(prisma.group.upsert).mockResolvedValue({} as any)
    await ensureGroupSeeded('g1@g.us', 'Grupo principal')
    expect(prisma.group.upsert).toHaveBeenCalledWith({
      where: { id: 'g1@g.us' },
      update: {},
      create: {
        id: 'g1@g.us',
        name: 'Grupo principal',
        pokemonEnabled: true,
        confessionsEnabled: true,
        scheduledGreetingsEnabled: true,
        triggersEnabled: true,
        contextSyncEnabled: true,
      },
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/groupService.test.ts`
Expected: FAIL — `Cannot find module '../services/groupService.js'`

- [ ] **Step 3: Implement `services/groupService.ts`**

```typescript
import { prisma } from './db.js'

type GroupRow = {
  id: string
  pokemonEnabled: boolean
  triggersEnabled: boolean
  contextSyncEnabled: boolean
} | null

const CACHE_TTL_MS = 60_000
let cache = new Map<string, { row: GroupRow; fetchedAt: number }>()

export function resetGroupCache(): void {
  cache = new Map()
}

async function fetchGroup(groupId: string): Promise<GroupRow> {
  const cached = cache.get(groupId)
  const now = Date.now()
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.row
  const row = await prisma.group.findUnique({ where: { id: groupId } })
  cache.set(groupId, { row: row as GroupRow, fetchedAt: now })
  return row as GroupRow
}

export async function isGroupRegistered(groupId: string): Promise<boolean> {
  return (await fetchGroup(groupId)) !== null
}

export async function isPokemonEnabled(groupId: string): Promise<boolean> {
  const row = await fetchGroup(groupId)
  return !!row?.pokemonEnabled
}

export async function isTriggersEnabledForGroup(groupId: string): Promise<boolean> {
  const row = await fetchGroup(groupId)
  return !!row?.triggersEnabled
}

export async function isContextSyncEnabled(groupId: string): Promise<boolean> {
  const row = await fetchGroup(groupId)
  return !!row?.contextSyncEnabled
}

export async function getPokemonEnabledGroupIds(): Promise<string[]> {
  const rows = await prisma.group.findMany({ where: { pokemonEnabled: true }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function getConfessionsEnabledGroupIds(): Promise<string[]> {
  const rows = await prisma.group.findMany({ where: { confessionsEnabled: true }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function getScheduledGreetingsEnabledGroupIds(): Promise<string[]> {
  const rows = await prisma.group.findMany({ where: { scheduledGreetingsEnabled: true }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function getContextSyncEnabledGroupIds(): Promise<string[]> {
  const rows = await prisma.group.findMany({ where: { contextSyncEnabled: true }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function ensureGroupSeeded(id: string, name: string): Promise<void> {
  await prisma.group.upsert({
    where: { id },
    update: {},
    create: {
      id,
      name,
      pokemonEnabled: true,
      confessionsEnabled: true,
      scheduledGreetingsEnabled: true,
      triggersEnabled: true,
      contextSyncEnabled: true,
    },
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/groupService.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add services/groupService.ts __tests__/groupService.test.ts
git commit -m "feat: add groupService with cached per-group feature lookups"
```

---

### Task 3: Fix `dropService.ts` cross-group `excludeIds` bug

**Files:**
- Modify: `services/dropService.ts:77-93`
- Test: `__tests__/dropService.test.ts` (extend)

**Interfaces:**
- Consumes: `prisma.pokemonDrop.findMany` (unchanged shape, now filtered by `groupId`).
- Produces: no change to `executeDrop`'s exported signature.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/dropService.test.ts` (new imports/mocks at the top of the file, new `describe` block at the bottom):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    pokemonDrop: { findMany: vi.fn(), create: vi.fn() },
    pokemonCache: { findUnique: vi.fn() },
  },
}))
vi.mock('../services/redis.js', () => ({
  getRedis: vi.fn(() => ({ get: vi.fn().mockResolvedValue(null), set: vi.fn() })),
}))
vi.mock('../services/pokemonService.js', () => ({
  fetchAndCachePokemon: vi.fn().mockResolvedValue({ id: 1, name: 'Bulbasaur', imageUrl: 'x', types: ['grass'] }),
}))
vi.mock('../services/sendQueue.js', () => ({ enqueueSendMessage: vi.fn() }))
vi.mock('../services/ai.js', () => ({ callGeminiChat: vi.fn().mockResolvedValue('...') }))

import { prisma } from '../services/db.js'
import { executeDrop } from '../services/dropService.js'

describe('executeDrop excludeIds scoping', () => {
  beforeEach(() => vi.clearAllMocks())

  it('only queries captured drops for the target group, not globally', async () => {
    vi.mocked(prisma.pokemonDrop.findMany).mockResolvedValue([])
    vi.mocked(prisma.pokemonCache.findUnique).mockResolvedValue({ aiCaption: 'cached caption' } as any)
    vi.mocked(prisma.pokemonDrop.create).mockResolvedValue({ id: 'drop1' } as any)

    await executeDrop('groupA@g.us')

    expect(prisma.pokemonDrop.findMany).toHaveBeenCalledWith({
      where: { capturedBy: { not: null }, groupId: 'groupA@g.us' },
      select: { pokemonId: true },
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/dropService.test.ts -t "excludeIds scoping"`
Expected: FAIL — actual call was `{ where: { capturedBy: { not: null } }, ... }` (missing `groupId`)

- [ ] **Step 3: Fix the query in `services/dropService.ts`**

In `executeDrop`, replace lines 89-92:

```typescript
  const captured = await prisma.pokemonDrop.findMany({
    where: { capturedBy: { not: null } },
    select: { pokemonId: true },
  })
```

with:

```typescript
  const captured = await prisma.pokemonDrop.findMany({
    where: { capturedBy: { not: null }, groupId },
    select: { pokemonId: true },
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/dropService.test.ts`
Expected: PASS (all existing `weightedRandom` tests + the new one)

- [ ] **Step 5: Commit**

```bash
git add services/dropService.ts __tests__/dropService.test.ts
git commit -m "fix: scope pokemon drop-exclusion query by groupId

Previously a Pokémon captured in one group made it permanently
unavailable to drop in every other group."
```

---

### Task 4: `dropScheduler.ts` — fan out across all pokemon-enabled groups

**Files:**
- Modify: `services/dropScheduler.ts`

**Interfaces:**
- Consumes: `getPokemonEnabledGroupIds()` from Task 2's `services/groupService.js`.
- Produces: no change to `startDropScheduler()`'s exported signature.

- [ ] **Step 1: Replace the single-group cron registration and worker body**

Replace the whole `startDropScheduler` function body in `services/dropScheduler.ts` (currently lines 20-70):

```typescript
import { getPokemonEnabledGroupIds } from './groupService.js'

export async function startDropScheduler(): Promise<void> {
  // Remove jobs existentes para evitar duplicatas no restart
  const existing = await dropQueue.getRepeatableJobs()
  for (const job of existing) {
    if (job.name === 'check-drop') {
      await dropQueue.removeRepeatableByKey(job.key)
    }
  }

  await dropQueue.add(
    'check-drop',
    {},
    {
      repeat: { pattern: DROP_CONFIG.CHECK_INTERVAL_CRON },
      removeOnComplete: true,
      removeOnFail: 10,
    }
  )

  const worker = new Worker(
    DROP_CONFIG.QUEUE_NAME,
    async (job) => {
      if (job.name !== 'check-drop') return

      const groupIds = await getPokemonEnabledGroupIds()
      const redis = getRedis()

      for (const groupId of groupIds) {
        const activityRaw = await redis.get(`activity:${groupId}`)
        const activityCount = activityRaw ? parseInt(activityRaw, 10) : 0

        const p = calculateDropProbability(activityCount)
        const roll = Math.random()

        log(
          `Drop check [${groupId}]: activity=${activityCount} p=${p.toFixed(4)} roll=${roll.toFixed(4)} → ${roll < p ? 'DROPA' : 'passa'}`,
          'info'
        )

        if (roll < p) {
          await executeDrop(groupId)
        }
      }
    },
    { connection }
  )

  worker.on('failed', (job, err) => {
    log(`Drop scheduler job ${job?.id} falhou: ${err.message}`, 'error')
  })

  log('Drop scheduler iniciado', 'info')
}
```

Also delete the now-unused `groupId` env-var block at the top of the old function (the three lines reading `process.env.GROUP_ID || process.env.ALLOWED_PING_GROUP || '...'`), since it's replaced by the per-tick `getPokemonEnabledGroupIds()` call.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Manual verification**

Run the backend locally against a test DB with 2 `Group` rows (`pokemonEnabled: true` for both), confirm the worker log line appears once per group per tick (`Drop check [groupA@g.us]: ...` and `Drop check [groupB@g.us]: ...`).

- [ ] **Step 4: Commit**

```bash
git add services/dropScheduler.ts
git commit -m "feat: fan out automatic pokemon drop checks across all enabled groups"
```

---

### Task 5: `scheduledJobs.ts` — fan out greeting broadcasts

**Files:**
- Modify: `services/scheduledJobs.ts:216-232`

**Interfaces:**
- Consumes: `getScheduledGreetingsEnabledGroupIds()` from Task 2.

- [ ] **Step 1: Replace the single `groupId` with a loop over enabled groups**

In `services/scheduledJobs.ts`, replace lines 216-232:

```typescript
  const payloads: Parameters<typeof enqueueSendMessage>[0][] = [];
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
      type: (schedule.type as "image" | "video") || "image",
      content: mediaUrl,
      caption: caption || undefined,
    });
  }
```

with:

```typescript
  const payloads: Parameters<typeof enqueueSendMessage>[0][] = [];
  const groupIds = await getScheduledGreetingsEnabledGroupIds();
  const mediaUrl = schedule.mediaUrl || "";

  for (const groupId of groupIds) {
    if (schedule.type === "text") {
      payloads.push({ groupId, type: "text", content: schedule.textContent || "" });
    } else {
      payloads.push({
        groupId,
        type: (schedule.type as "image" | "video") || "image",
        content: mediaUrl,
        caption: caption || undefined,
      });
    }
  }
```

Then, further down in the same function, the `if (schedule.includeRandomPool !== false) { ... }` block (lines 234-286) currently pushes exactly one more payload referencing the single `groupId` variable that no longer exists. Wrap that whole block in the same `for (const groupId of groupIds)` loop instead of running it once — replace:

```typescript
  if (schedule.includeRandomPool !== false) {
    const randomMedia = await getRandomMedia();
    const randomTextRows = await prisma.$queryRaw<
      { id: string; text: string }[]
    >`SELECT * FROM "Phrase" ORDER BY RANDOM() LIMIT 1`;
    const randomTextDoc = Array.isArray(randomTextRows) ? randomTextRows[0] : null;
    const candidates: Array<
      | { kind: "media"; data: Awaited<ReturnType<typeof getRandomMedia>> }
      | { kind: "text"; data: { type: "text"; content: string; id: string | null } }
    > = [];
    if (randomMedia) candidates.push({ kind: "media", data: randomMedia });
    if (randomTextDoc) {
      candidates.push({
        kind: "text",
        data: { type: "text", content: randomTextDoc.text || "", id: randomTextDoc.id || null },
      });
    }
    if (candidates.length) {
      const choice = candidates[Math.floor(Math.random() * candidates.length)];
      const isText = choice.kind === "text" || choice.data?.type === "text";
      const typeLabel = isText
        ? "Frase"
        : choice.data?.type === "image"
          ? "Foto"
          : "Vídeo";
      if (schedule.includeIntro) {
        payloads.push({ groupId, type: "text", content: `${typeLabel} do dia:` });
      }
      if (isText && choice.kind === "text") {
        payloads.push({
          groupId,
          type: "text",
          content: choice.data.content || "",
          cleanup: choice.data.id
            ? { type: "phrase", id: choice.data.id }
            : undefined,
        });
      } else if (choice.kind === "media" && choice.data) {
        const baseInternal = (
          process.env.MEDIA_BASE_URL ||
          process.env.BACKEND_PUBLIC_URL ||
          "http://backend:3000"
        ).replace(/\/+$/, "");
        const filename = path.basename(choice.data.path);
        payloads.push({
          groupId,
          type: choice.data.type as "image" | "video",
          content: `${baseInternal}/media/${choice.data.type}/${filename}`,
          cleanup: { type: choice.data.type, filename, scope: "media" },
        });
      }
    }
  }
```

with (same body, now looped, and the random media/text choice made once outside the loop so every group gets the *same* random pick rather than a different one each — matching today's single-broadcast behavior):

```typescript
  if (schedule.includeRandomPool !== false && groupIds.length) {
    const randomMedia = await getRandomMedia();
    const randomTextRows = await prisma.$queryRaw<
      { id: string; text: string }[]
    >`SELECT * FROM "Phrase" ORDER BY RANDOM() LIMIT 1`;
    const randomTextDoc = Array.isArray(randomTextRows) ? randomTextRows[0] : null;
    const candidates: Array<
      | { kind: "media"; data: Awaited<ReturnType<typeof getRandomMedia>> }
      | { kind: "text"; data: { type: "text"; content: string; id: string | null } }
    > = [];
    if (randomMedia) candidates.push({ kind: "media", data: randomMedia });
    if (randomTextDoc) {
      candidates.push({
        kind: "text",
        data: { type: "text", content: randomTextDoc.text || "", id: randomTextDoc.id || null },
      });
    }
    if (candidates.length) {
      const choice = candidates[Math.floor(Math.random() * candidates.length)];
      const isText = choice.kind === "text" || choice.data?.type === "text";
      const typeLabel = isText
        ? "Frase"
        : choice.data?.type === "image"
          ? "Foto"
          : "Vídeo";
      for (const groupId of groupIds) {
        if (schedule.includeIntro) {
          payloads.push({ groupId, type: "text", content: `${typeLabel} do dia:` });
        }
        if (isText && choice.kind === "text") {
          payloads.push({
            groupId,
            type: "text",
            content: choice.data.content || "",
            cleanup: choice.data.id
              ? { type: "phrase", id: choice.data.id }
              : undefined,
          });
        } else if (choice.kind === "media" && choice.data) {
          const baseInternal = (
            process.env.MEDIA_BASE_URL ||
            process.env.BACKEND_PUBLIC_URL ||
            "http://backend:3000"
          ).replace(/\/+$/, "");
          const filename = path.basename(choice.data.path);
          payloads.push({
            groupId,
            type: choice.data.type as "image" | "video",
            content: `${baseInternal}/media/${choice.data.type}/${filename}`,
            cleanup: { type: choice.data.type, filename, scope: "media" },
          });
        }
      }
    }
  }
```

Add the import at the top of the file (after the existing `import { getRandomMedia } from "../mediaManager.js";` on line 8):

```typescript
import { getScheduledGreetingsEnabledGroupIds } from "./groupService.js";
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add services/scheduledJobs.ts
git commit -m "feat: broadcast scheduled greetings to all scheduledGreetingsEnabled groups"
```

---

### Task 6: `routes/confessions.ts` — fan out confession broadcasts

**Files:**
- Modify: `routes/confessions.ts:51-56`

**Interfaces:**
- Consumes: `getConfessionsEnabledGroupIds()` from Task 2.

- [ ] **Step 1: Replace the single target group with a loop**

In `routes/confessions.ts`, replace:

```typescript
      const targetGroupId =
        process.env.GROUP_ID ||
        process.env.ALLOWED_PING_GROUP ||
        "120363339314665620@g.us";
      const finalMessage = `Confissão anônima: ${message}`.slice(0, MAX_MESSAGE_LENGTH);

      await enqueueSendMessage({ groupId: targetGroupId, type: "text", content: finalMessage });
      lastConfessionByIp.set(ip, now);
```

with:

```typescript
      const targetGroupIds = await getConfessionsEnabledGroupIds();
      const finalMessage = `Confissão anônima: ${message}`.slice(0, MAX_MESSAGE_LENGTH);

      for (const targetGroupId of targetGroupIds) {
        await enqueueSendMessage({ groupId: targetGroupId, type: "text", content: finalMessage });
      }
      lastConfessionByIp.set(ip, now);
```

Add the import at the top (after `import { enqueueSendMessage } from "../services/sendQueue.js";`):

```typescript
import { getConfessionsEnabledGroupIds } from "../services/groupService.js";
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add routes/confessions.ts
git commit -m "feat: broadcast confessions to all confessionsEnabled groups"
```

---

### Task 7: `handlers/commands.ts` — replace `isFromAllowedGroup` with DB-backed gating

**Files:**
- Modify: `handlers/commands.ts:65-86,1146`

**Interfaces:**
- Consumes: `isGroupRegistered`, `isPokemonEnabled` from Task 2.
- Produces: `isFromAllowedGroup` keeps its exact name and `(msg: IncomingMsg) => Promise<boolean>` signature so the single call site at line 1146 and any other internal usage is unaffected.

- [ ] **Step 1: Replace the allowed-group check**

Replace lines 65-86 of `handlers/commands.ts`:

```typescript
  function getAllowedGroupId(): string {
    return process.env.ALLOWED_PING_GROUP || "120363339314665620@g.us";
  }

  let linkedGroupCache: { ids: Set<string>; fetchedAt: number } = { ids: new Set(), fetchedAt: 0 }
  const LINKED_CACHE_TTL_MS = 60_000

  async function isFromAllowedGroup(msg: IncomingMsg): Promise<boolean> {
    if (!msg?.from) return false
    if (msg.from === getAllowedGroupId()) return true
    const now = Date.now()
    if (now - linkedGroupCache.fetchedAt > LINKED_CACHE_TTL_MS) {
      try {
        const linked = await prismaClient.linkedGroup.findMany({
          select: { mainGroupId: true, gameGroupId: true },
        })
        const ids = new Set<string>()
        for (const l of linked) { ids.add(l.mainGroupId); ids.add(l.gameGroupId) }
        linkedGroupCache = { ids, fetchedAt: now }
      } catch {}
    }
    return linkedGroupCache.ids.has(msg.from)
  }
```

with:

```typescript
  let linkedGroupCache: { ids: Set<string>; fetchedAt: number } = { ids: new Set(), fetchedAt: 0 }
  const LINKED_CACHE_TTL_MS = 60_000

  async function isFromAllowedGroup(msg: IncomingMsg): Promise<boolean> {
    if (!msg?.from) return false
    if (await isGroupRegistered(msg.from)) return true
    const now = Date.now()
    if (now - linkedGroupCache.fetchedAt > LINKED_CACHE_TTL_MS) {
      try {
        const linked = await prismaClient.linkedGroup.findMany({
          select: { mainGroupId: true, gameGroupId: true },
        })
        const ids = new Set<string>()
        for (const l of linked) { ids.add(l.mainGroupId); ids.add(l.gameGroupId) }
        linkedGroupCache = { ids, fetchedAt: now }
      } catch {}
    }
    return linkedGroupCache.ids.has(msg.from)
  }
```

(The Miru `LinkedGroup` fallback stays untouched — Miru is out of scope, but its existing groups must keep working.)

- [ ] **Step 2: Add the import**

At the top of `handlers/commands.ts`, add after `import { getRedis } from "../services/redis.js";`:

```typescript
import { isGroupRegistered, isPokemonEnabled } from "../services/groupService.js";
```

- [ ] **Step 3: Gate pokemon-specific commands on `pokemonEnabled`**

Find the dispatcher's main `processCommand` switch/if-chain (search for `case CommandType.Pokemons` or the first `if (cmd.type === CommandType.Pokemons)` — it's the function containing the `isFromAllowedGroup` call at line 1146). Immediately after the existing gate:

```typescript
      if (!isMiruCmd && !(await isFromAllowedGroup(msg))) return;
```

add a second gate for the pokemon command family:

```typescript
      const POKEMON_COMMAND_TYPES = new Set([
        CommandType.Pokemons,
        CommandType.Galeria,
        CommandType.Give,
        CommandType.Trade,
        CommandType.Aceitar,
        CommandType.Recusar,
        CommandType.Confirmar,
        CommandType.Cancelar,
        CommandType.ForceSpawn,
      ]);
      if (POKEMON_COMMAND_TYPES.has(cmd.type) && !(await isPokemonEnabled(msg.from!))) return;
```

(`msg.from!` is safe here: `isFromAllowedGroup` above already returned `false`/short-circuited for any message without `msg.from`.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Manual verification**

With a `Group` row that has `pokemonEnabled: false`, confirm `!ajuda` still responds but `!pokemon` does not. Flip `pokemonEnabled: true` and confirm `!pokemon` starts responding without a restart (thanks to the 60s cache in `groupService.ts`, wait up to 60s or call `resetGroupCache()` in a REPL/test).

- [ ] **Step 6: Commit**

```bash
git add handlers/commands.ts
git commit -m "feat: gate command dispatch and pokemon commands on the Group table"
```

---

### Task 8: `handlers/triggers.ts` — per-group trigger matching

**Files:**
- Modify: `handlers/triggers.ts:100-153`
- Test: `__tests__/triggers.test.ts` (new)

**Interfaces:**
- Consumes: `isTriggersEnabledForGroup` from Task 2.
- Produces: `createTriggerProcessor` keeps its exact exported signature; the returned `processTrigger` function now additionally requires `trig.groupId === msg.from`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/triggers.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: { trigger: { findMany: vi.fn(), update: vi.fn() } },
}))
vi.mock('../services/groupService.js', () => ({
  isTriggersEnabledForGroup: vi.fn(),
}))
vi.mock('../services/sendQueue.js', () => ({ enqueueSendMessage: vi.fn() }))

import { prisma } from '../services/db.js'
import { isTriggersEnabledForGroup } from '../services/groupService.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { createTriggerProcessor } from '../handlers/triggers.js'

function baseTrigger(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 't1',
    groupId: 'groupA@g.us',
    active: true,
    phrases: ['oi'],
    caseSensitive: false,
    normalizeAccents: true,
    matchType: 'contains',
    wholeWord: false,
    chancePercent: 100,
    expiresAt: null,
    maxUses: null,
    triggeredCount: 0,
    allowedUsers: [],
    cooldownSeconds: 0,
    cooldownPerUserSeconds: 0,
    responseType: 'text',
    responseText: 'oi pra você',
    responseMediaUrl: '',
    replyMode: 'reply',
    mentionSender: false,
    ...overrides,
  }
}

describe('createTriggerProcessor group scoping', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires a trigger whose groupId matches the incoming message group', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([baseTrigger()] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'oi', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)
  })

  it('does not fire a trigger registered for a different group', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([baseTrigger({ groupId: 'groupB@g.us' })] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'oi', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })

  it('does not fire any trigger when triggersEnabled is false for the group', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([baseTrigger()] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(false)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'oi', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/triggers.test.ts`
Expected: FAIL — current code gates on `msg.from !== allowedGroup` (a hardcoded env-derived string), not on DB-driven per-trigger `groupId`, so all three assertions behave differently than expected (in particular the "different group" and "disabled" cases would currently fire since there's no such gating at all).

- [ ] **Step 3: Update `handlers/triggers.ts`**

Replace lines 102-105:

```typescript
  const allowedGroup =
    process.env.ALLOWED_PING_GROUP ||
    process.env.GROUP_ID ||
    "120363339314665620@g.us";
```

Just delete these lines entirely (no replacement needed at this location).

Add the import at the top of the file (after `import { log } from "../services/logger.js";`):

```typescript
import { isTriggersEnabledForGroup } from "../services/groupService.js";
```

Replace line 149 (`if (msg.from !== allowedGroup) return;`) with:

```typescript
      if (!msg.from || !(await isTriggersEnabledForGroup(msg.from))) return;
```

Inside the `for (const trig of triggers)` loop (starting line 159), add a group-match guard right after the existing `if (!trig.active) continue;` (line 160):

```typescript
        if (trig.groupId !== msg.from) continue;
```

(This requires `TriggerRecord` interface, lines 23-43, to include `groupId: string;` — add it right after `id: string;` on line 24.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/triggers.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add handlers/triggers.ts __tests__/triggers.test.ts
git commit -m "feat: scope trigger matching to each trigger's own groupId and per-group toggle"
```

---

### Task 9: `routes/triggers.ts` — require `groupId` on create/update

**Files:**
- Modify: `routes/triggers.ts`

**Interfaces:**
- Produces: `POST /triggers` and `PUT /triggers/:id` now reject a request with no `groupId`.

- [ ] **Step 1: Add `groupId` to `parseTriggerPayload`**

In `routes/triggers.ts`, inside `parseTriggerPayload` (after line 7, `safe.name = ...`), add:

```typescript
  safe.groupId = ((body.groupId || "") as string).toString().trim();
```

- [ ] **Step 2: Add validation in `validateTriggerPayload`**

At the top of `validateTriggerPayload` (before the existing `if (!payload.phrases...)` check on line 46), add:

```typescript
  if (!payload.groupId || !(payload.groupId as string).trim()) {
    throw new Error("groupId é obrigatório");
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Manual verification**

`POST /triggers` with no `groupId` in the body → `400 { error: "groupId é obrigatório" }`. With a valid `groupId` → `201` as before.

- [ ] **Step 5: Commit**

```bash
git add routes/triggers.ts
git commit -m "feat: require groupId when creating or updating a trigger"
```

---

### Task 10: `routes/groupContext.ts` — scope by `contextSyncEnabled`

**Files:**
- Modify: `routes/groupContext.ts`

**Interfaces:**
- Consumes: `isContextSyncEnabled` from Task 2.

- [ ] **Step 1: Gate `POST /context/refresh` on the group's toggle**

Replace the handler body (lines 7-20):

```typescript
  app.post("/context/refresh", requireAuth, async (req, res) => {
    try {
      const groupId =
        req.body?.groupId ||
        process.env.GROUP_ID ||
        process.env.ALLOWED_PING_GROUP;
      if (!groupId) return res.status(400).json({ error: "groupId é obrigatório" });
      await enqueueGroupContextJob(groupId);
      res.json({ message: "Job de contexto enfileirado", groupId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao enfileirar";
      res.status(500).json({ error: msg });
    }
  });
```

with:

```typescript
  app.post("/context/refresh", requireAuth, async (req, res) => {
    try {
      const groupId = req.body?.groupId;
      if (!groupId) return res.status(400).json({ error: "groupId é obrigatório" });
      if (!(await isContextSyncEnabled(groupId))) {
        return res.status(403).json({ error: "Sync de contexto não habilitado para este grupo" });
      }
      await enqueueGroupContextJob(groupId);
      res.json({ message: "Job de contexto enfileirado", groupId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao enfileirar";
      res.status(500).json({ error: msg });
    }
  });
```

Add the import at the top:

```typescript
import { isContextSyncEnabled } from "../services/groupService.js";
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add routes/groupContext.ts
git commit -m "feat: require contextSyncEnabled before refreshing a group's context"
```

---

### Task 11: `services/groupDiscoveryQueue.ts` + `services/muteSchedulerQueue.ts`

**Files:**
- Create: `services/groupDiscoveryQueue.ts`
- Create: `services/muteSchedulerQueue.ts`

**Interfaces:**
- Produces:
  - `enqueueGroupDiscoveryJob(): Promise<unknown>` (no payload)
  - `getGroupDiscoveryQueueName(): string`
  - `startMuteScheduler(): Promise<void>` — registers a repeatable BullMQ job; the worker-side processor for this queue is built in Task 14.

- [ ] **Step 1: Create `services/groupDiscoveryQueue.ts`**

Modeled directly on `services/groupContextQueue.ts`:

```typescript
import { Queue } from "bullmq";

const queueName = process.env.GROUP_DISCOVERY_QUEUE_NAME || "group-discovery";
const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);

const hasHostPort = !!process.env.REDIS_HOST || !!process.env.REDIS_PORT;
const baseConnection = hasHostPort
  ? { host: redisHost, port: redisPort }
  : redisUrl
    ? { url: redisUrl }
    : { host: "redis", port: 6379 };

const connection = {
  ...baseConnection,
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
};

const queue = new Queue(queueName, { connection });

export async function enqueueGroupDiscoveryJob(): Promise<unknown> {
  const jobPromise = queue.add("group-discovery", {}, { removeOnComplete: 20, removeOnFail: 20 });

  const timeoutMs = 5000;
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(
      () => rej(new Error("Timeout ao enfileirar descoberta de grupos (Redis indisponivel?)")),
      timeoutMs
    )
  );
  return Promise.race([jobPromise, timeout]);
}

export function getGroupDiscoveryQueueName(): string {
  return queueName;
}
```

- [ ] **Step 2: Create `services/muteSchedulerQueue.ts`**

```typescript
import { Queue } from "bullmq";
import { log } from "./logger.js";

const queueName = process.env.MUTE_QUEUE_NAME || "mute-all-groups";
const connection = {
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

const queue = new Queue(queueName, { connection });

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

export function getMuteQueueName(): string {
  return queueName;
}

export async function startMuteScheduler(): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === "mute-all") {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    "mute-all",
    {},
    {
      repeat: { every: SIX_DAYS_MS },
      removeOnComplete: true,
      removeOnFail: 10,
    }
  );

  // Fire once immediately on boot too, so a fresh deploy doesn't wait up to 6 days.
  await queue.add("mute-all", {}, { removeOnComplete: true, removeOnFail: 10 });

  log("Mute scheduler iniciado (renovação a cada 6 dias)", "info");
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add services/groupDiscoveryQueue.ts services/muteSchedulerQueue.ts
git commit -m "feat: add group-discovery and mute-scheduler BullMQ queues"
```

---

### Task 12: `routes/groups.ts` — CRUD + cached discovery endpoints + boot reconciliation

**Files:**
- Create: `routes/groups.ts`
- Modify: `app.ts`

**Interfaces:**
- Consumes: `prisma.group`, `getRedis()`, `enqueueGroupDiscoveryJob()`, `ensureGroupSeeded()`, `startMuteScheduler()`.
- Produces: routes `GET/POST /groups`, `PATCH/DELETE /groups/:id`, `GET /groups/discover`, `POST /groups/discover/sync`, `POST /groups/discover/ingest`.

- [ ] **Step 1: Create `routes/groups.ts`**

```typescript
import { Express } from "express";
import { requireAuth, requireRole, requireWorkerOrRole } from "../middleware/auth.js";
import { prisma } from "../services/db.js";
import { getRedis } from "../services/redis.js";
import { enqueueGroupDiscoveryJob } from "../services/groupDiscoveryQueue.js";

const DISCOVERY_CACHE_KEY = "groups:discovered";
const DISCOVERY_CACHE_TTL_SEC = 86_400;

const FEATURE_FIELDS = [
  "pokemonEnabled",
  "confessionsEnabled",
  "scheduledGreetingsEnabled",
  "triggersEnabled",
  "contextSyncEnabled",
] as const;

function parseFeatureFlags(body: Record<string, unknown>) {
  const out: Record<string, boolean> = {};
  for (const field of FEATURE_FIELDS) {
    if (typeof body[field] === "boolean") out[field] = body[field] as boolean;
  }
  return out;
}

export function registerGroupRoutes(app: Express) {
  app.get("/groups", requireAuth, requireRole("super_admin"), async (_req, res) => {
    try {
      const groups = await prisma.group.findMany({ orderBy: { createdAt: "asc" } });
      res.json(groups);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar grupos";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/groups", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const id = ((req.body?.id || "") as string).trim();
      const name = ((req.body?.name || "") as string).trim();
      if (!id) return res.status(400).json({ error: "id (JID do grupo) é obrigatório" });
      if (!name) return res.status(400).json({ error: "name é obrigatório" });
      const created = await prisma.group.create({
        data: {
          id,
          name,
          pokemonEnabled: false,
          confessionsEnabled: false,
          scheduledGreetingsEnabled: false,
          triggersEnabled: false,
          contextSyncEnabled: false,
        },
      });
      res.status(201).json(created);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2002") {
        return res.status(409).json({ error: "Grupo já cadastrado" });
      }
      const msg = err instanceof Error ? err.message : "Erro ao criar grupo";
      res.status(400).json({ error: msg });
    }
  });

  app.patch("/groups/:id", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const data: Record<string, unknown> = parseFeatureFlags(req.body || {});
      if (typeof req.body?.name === "string" && req.body.name.trim()) {
        data.name = req.body.name.trim();
      }
      const updated = await prisma.group.update({
        where: { id: req.params.id },
        data,
      });
      res.json(updated);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2025") {
        return res.status(404).json({ error: "Grupo não encontrado" });
      }
      const msg = err instanceof Error ? err.message : "Erro ao atualizar grupo";
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/groups/:id", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      await prisma.group.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2025") {
        return res.status(404).json({ error: "Grupo não encontrado" });
      }
      const msg = err instanceof Error ? err.message : "Erro ao remover grupo";
      res.status(500).json({ error: msg });
    }
  });

  app.get("/groups/discover", requireAuth, requireRole("super_admin"), async (_req, res) => {
    try {
      const redis = getRedis();
      const cached = await redis.get(DISCOVERY_CACHE_KEY);
      if (cached) {
        return res.json({ status: "ready", groups: JSON.parse(cached) });
      }
      await enqueueGroupDiscoveryJob();
      res.json({ status: "pending" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao buscar grupos";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/groups/discover/sync", requireAuth, requireRole("super_admin"), async (_req, res) => {
    try {
      const redis = getRedis();
      await redis.del(DISCOVERY_CACHE_KEY);
      await enqueueGroupDiscoveryJob();
      res.json({ status: "pending" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao sincronizar grupos";
      res.status(500).json({ error: msg });
    }
  });

  app.post(
    "/groups/discover/ingest",
    requireWorkerOrRole("super_admin"),
    async (req, res) => {
      try {
        const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
        const redis = getRedis();
        await redis.set(DISCOVERY_CACHE_KEY, JSON.stringify(groups), "EX", DISCOVERY_CACHE_TTL_SEC);
        res.json({ success: true, count: groups.length });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro ao salvar descoberta de grupos";
        res.status(500).json({ error: msg });
      }
    }
  );
}
```

- [ ] **Step 2: Wire it into `app.ts`**

Add the import (after `import { registerWhatsAppQrRoutes } from "./routes/whatsappQr.js";`):

```typescript
import { registerGroupRoutes } from "./routes/groups.js";
import { ensureGroupSeeded } from "./services/groupService.js";
import { startMuteScheduler } from "./services/muteSchedulerQueue.js";
```

Add the route registration (after `registerWhatsAppQrRoutes(app);`):

```typescript
registerGroupRoutes(app);
```

Add boot-time reconciliation right after `void ensureSourceMeta()` (line 79) — this guarantees the production group row exists even if the migration's SQL fallback (Task 1, Step 4) ever diverges from the real env var:

```typescript
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
```

Add `startMuteScheduler();` next to the other startup calls near the bottom of `app.ts` (after `startDropScheduler();`):

```typescript
startMuteScheduler();
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Manual verification**

`GET /groups` (as super_admin) → `[{ id: '120363339314665620@g.us', name: 'Grupo principal', ...all true }]`. `POST /groups` with `{ id: 'new@g.us', name: 'Novo grupo' }` → `201`, all 5 flags `false`. `PATCH /groups/new@g.us` with `{ pokemonEnabled: true }` → flag flips. `GET /groups/discover` with empty Redis cache → `{ status: 'pending' }` and a job appears in the `group-discovery` BullMQ queue (verify via `redis-cli` or BullMQ dashboard).

- [ ] **Step 5: Commit**

```bash
git add routes/groups.ts app.ts
git commit -m "feat: add Group CRUD routes, cached discovery endpoints, and boot-time seeding"
```

---

## Part 2 — Worker (`como-ja-e-dia-worker`)

### Task 13: `muteAllGroups` helper

**Files:**
- Create: `src/muteAllGroups.ts`
- Test: `src/__tests__/muteAllGroups.test.ts`

**Interfaces:**
- Produces: `muteAllGroups(sock: WASocket): Promise<number>` — returns the count of groups muted. Consumed by Tasks 14 and 15.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/muteAllGroups.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { muteAllGroups, ONE_WEEK_MS } from '../muteAllGroups.js'

describe('muteAllGroups', () => {
  it('mutes every group returned by groupFetchAllParticipating', async () => {
    const chatModify = vi.fn().mockResolvedValue(undefined)
    const sock = {
      groupFetchAllParticipating: vi.fn().mockResolvedValue({
        'a@g.us': { id: 'a@g.us' },
        'b@g.us': { id: 'b@g.us' },
      }),
      chatModify,
    } as any

    const count = await muteAllGroups(sock)

    expect(count).toBe(2)
    expect(chatModify).toHaveBeenCalledWith({ mute: ONE_WEEK_MS }, 'a@g.us')
    expect(chatModify).toHaveBeenCalledWith({ mute: ONE_WEEK_MS }, 'b@g.us')
  })

  it('continues muting remaining groups if one chatModify call fails', async () => {
    const chatModify = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    const sock = {
      groupFetchAllParticipating: vi.fn().mockResolvedValue({
        'a@g.us': { id: 'a@g.us' },
        'b@g.us': { id: 'b@g.us' },
      }),
      chatModify,
    } as any

    const count = await muteAllGroups(sock)

    expect(count).toBe(1)
    expect(chatModify).toHaveBeenCalledTimes(2)
  })

  it('returns 0 when the account is in no groups', async () => {
    const sock = {
      groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      chatModify: vi.fn(),
    } as any

    expect(await muteAllGroups(sock)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd como-ja-e-dia-worker && npx vitest run src/__tests__/muteAllGroups.test.ts`
Expected: FAIL — `Cannot find module '../muteAllGroups.js'`

- [ ] **Step 3: Implement `src/muteAllGroups.ts`**

```typescript
import type { WASocket } from 'baileys'
import { log } from './logger.js'

export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export async function muteAllGroups(sock: WASocket): Promise<number> {
  const participating = await sock.groupFetchAllParticipating()
  const jids = Object.keys(participating)

  let muted = 0
  for (const jid of jids) {
    try {
      await sock.chatModify({ mute: ONE_WEEK_MS }, jid)
      muted++
    } catch (err) {
      log(`Falha ao mutar grupo ${jid}: ${(err as Error).message}`, 'warn')
    }
  }
  return muted
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/muteAllGroups.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/muteAllGroups.ts src/__tests__/muteAllGroups.test.ts
git commit -m "feat: add muteAllGroups helper to silence notifications on the bot's phone"
```

---

### Task 14: `src/groupDiscoveryProcessor.ts`

**Files:**
- Create: `src/groupDiscoveryProcessor.ts`

**Interfaces:**
- Consumes: `getSocket()` from `src/client.ts`, `muteAllGroups()` from Task 13, `config` from `src/config.ts`.
- Produces: `startGroupDiscoveryWorker(): Worker` — a BullMQ worker on the `group-discovery` queue.

- [ ] **Step 1: Add config entries**

In `src/config.ts`, add two lines inside the `config` object (after `groupContextQueueName`):

```typescript
  groupDiscoveryQueueName: process.env.GROUP_DISCOVERY_QUEUE_NAME ?? 'group-discovery',
  muteQueueName: process.env.MUTE_QUEUE_NAME ?? 'mute-all-groups',
```

- [ ] **Step 2: Implement `src/groupDiscoveryProcessor.ts`**

Modeled on `src/contextProcessor.ts`:

```typescript
import { Worker } from 'bullmq'
import axios from 'axios'
import { getSocket } from './client.js'
import { config } from './config.js'
import { redisConnection } from './queues.js'
import { log } from './logger.js'
import { muteAllGroups } from './muteAllGroups.js'

async function discoverAndReport(): Promise<void> {
  const sock = getSocket()
  const participating = await sock.groupFetchAllParticipating()

  const groups = Object.values(participating).map((meta) => ({
    id: meta.id,
    subject: meta.subject ?? '',
  }))

  await axios.post(
    `${config.backendUrl}/groups/discover/ingest`,
    { groups },
    { headers: { 'x-worker-secret': config.workerApiSecret } },
  )

  const muted = await muteAllGroups(sock)
  log(`Descoberta de grupos: ${groups.length} grupos, ${muted} mutados`, 'info')
}

export function startGroupDiscoveryWorker(): Worker {
  const worker = new Worker(
    config.groupDiscoveryQueueName,
    async (job) => {
      if (job.name !== 'group-discovery') return
      await discoverAndReport()
    },
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    log(`Job de descoberta de grupos ${job?.id} falhou: ${err.message}`, 'error')
  })

  return worker
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/groupDiscoveryProcessor.ts
git commit -m "feat: worker processor for group discovery, reports to backend and mutes all groups"
```

---

### Task 15: `src/muteSchedulerProcessor.ts`

**Files:**
- Create: `src/muteSchedulerProcessor.ts`

**Interfaces:**
- Consumes: `getSocket()`, `muteAllGroups()`, `config`.
- Produces: `startMuteSchedulerWorker(): Worker` — BullMQ worker on the `mute-all-groups` queue (the repeatable job itself is registered backend-side in Task 11).

- [ ] **Step 1: Implement `src/muteSchedulerProcessor.ts`**

```typescript
import { Worker } from 'bullmq'
import { getSocket } from './client.js'
import { config } from './config.js'
import { redisConnection } from './queues.js'
import { log } from './logger.js'
import { muteAllGroups } from './muteAllGroups.js'

export function startMuteSchedulerWorker(): Worker {
  const worker = new Worker(
    config.muteQueueName,
    async (job) => {
      if (job.name !== 'mute-all') return
      const sock = getSocket()
      const muted = await muteAllGroups(sock)
      log(`Renovação de mute: ${muted} grupos mutados`, 'info')
    },
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    log(`Job de mute ${job?.id} falhou: ${err.message}`, 'error')
  })

  return worker
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/muteSchedulerProcessor.ts
git commit -m "feat: worker processor for the recurring mute-renewal job"
```

---

### Task 16: Wire the two new workers into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Start both workers at boot**

Add imports at the top of `src/index.ts` (after `import { startContextWorker } from './contextProcessor.js'`):

```typescript
import { startGroupDiscoveryWorker } from './groupDiscoveryProcessor.js'
import { startMuteSchedulerWorker } from './muteSchedulerProcessor.js'
```

Add the calls (after `startContextWorker()`):

```typescript
startGroupDiscoveryWorker()
startMuteSchedulerWorker()
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Manual verification**

Boot the worker, confirm log lines `Worker iniciando...` are followed by no errors from the two new BullMQ workers connecting to Redis.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: start group-discovery and mute-scheduler workers on boot"
```

---

## Part 3 — Frontend (`como-ja-e-dia-frontend`)

### Task 17: `lib/apiClient.js` — group endpoints

**Files:**
- Modify: `lib/apiClient.js`

- [ ] **Step 1: Add group methods**

In `lib/apiClient.js`, add inside the `api` object (after the `getGroupContext`/`refreshGroupContext` pair, before the `// Persona` comment):

```javascript
    getGroups: () =>
        fetch("/api/groups", { ...withCreds, headers: handleHeaders() }).then(handleResponse),
    createGroup: ({ id, name }) =>
        fetch("/api/groups", {
            method: "POST",
            headers: handleHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ id, name }),
            credentials: "include",
        }).then(handleResponse),
    updateGroup: (id, payload) =>
        fetch(`/api/groups/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: handleHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(payload),
            credentials: "include",
        }).then(handleResponse),
    deleteGroup: (id) =>
        fetch(`/api/groups/${encodeURIComponent(id)}`, {
            method: "DELETE",
            credentials: "include",
            headers: handleHeaders(),
        }).then(handleResponse),
    getGroupDiscovery: () =>
        fetch("/api/groups/discover", { ...withCreds, headers: handleHeaders() }).then(handleResponse),
    syncGroupDiscovery: () =>
        fetch("/api/groups/discover/sync", {
            method: "POST",
            credentials: "include",
            headers: handleHeaders(),
        }).then(handleResponse),
```

- [ ] **Step 2: Commit**

```bash
git add lib/apiClient.js
git commit -m "feat: add group management client methods"
```

---

### Task 18: Next.js proxy pages for `/groups`

**Files:**
- Create: `pages/api/groups/index.js`
- Create: `pages/api/groups/[id].js`
- Create: `pages/api/groups/discover/index.js`
- Create: `pages/api/groups/discover/sync.js`

- [ ] **Step 1: `pages/api/groups/index.js`**

```javascript
import { proxyJson } from "../../../lib/backendApi";

export default async function handler(req, res) {
    if (req.method === "GET") {
        return proxyJson(req, res, { path: "/groups", method: "GET" });
    }
    if (req.method === "POST") {
        return proxyJson(req, res, { path: "/groups", method: "POST" });
    }
    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).end("Method Not Allowed");
}
```

- [ ] **Step 2: `pages/api/groups/[id].js`**

```javascript
import { proxyJson } from "../../../lib/backendApi";

export default async function handler(req, res) {
    const { id } = req.query;
    if (req.method === "PATCH") {
        return proxyJson(req, res, { path: `/groups/${id}`, method: "PATCH" });
    }
    if (req.method === "DELETE") {
        return proxyJson(req, res, { path: `/groups/${id}`, method: "DELETE" });
    }
    res.setHeader("Allow", ["PATCH", "DELETE"]);
    res.status(405).end("Method Not Allowed");
}
```

- [ ] **Step 3: `pages/api/groups/discover/index.js`**

```javascript
import { proxyJson } from "../../../../lib/backendApi";

export default async function handler(req, res) {
    if (req.method === "GET") {
        return proxyJson(req, res, { path: "/groups/discover", method: "GET" });
    }
    res.setHeader("Allow", ["GET"]);
    res.status(405).end("Method Not Allowed");
}
```

- [ ] **Step 4: `pages/api/groups/discover/sync.js`**

```javascript
import { proxyJson } from "../../../../lib/backendApi";

export default async function handler(req, res) {
    if (req.method === "POST") {
        return proxyJson(req, res, { path: "/groups/discover/sync", method: "POST" });
    }
    res.setHeader("Allow", ["POST"]);
    res.status(405).end("Method Not Allowed");
}
```

- [ ] **Step 5: Commit**

```bash
git add pages/api/groups
git commit -m "feat: add Next.js proxy routes for group management endpoints"
```

---

### Task 19: `components/GroupPicker.js` — shared discovery picker

**Files:**
- Create: `components/GroupPicker.js`

**Interfaces:**
- Produces: `<GroupPicker onSelect={(group: {id: string, subject: string}) => void} />` — a MUI `Autocomplete` fed by `api.getGroupDiscovery()`, polling while `status === 'pending'`, with a "Sync" button calling `api.syncGroupDiscovery()`.

- [ ] **Step 1: Implement the component**

```javascript
import { useEffect, useRef, useState } from "react";
import { Autocomplete, TextField, Button, Stack, CircularProgress, Alert } from "@mui/material";
import { api } from "../lib/apiClient";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 8; // ~15s

export default function GroupPicker({ onSelect, label = "Escolher grupo" }) {
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const attemptsRef = useRef(0);

    async function poll() {
        try {
            const res = await api.getGroupDiscovery();
            if (res.status === "ready") {
                setGroups(res.groups || []);
                setLoading(false);
                setError("");
                return;
            }
            attemptsRef.current += 1;
            if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
                setLoading(false);
                setError("Ainda buscando grupos no WhatsApp — tente Sync novamente em instantes.");
                return;
            }
            setTimeout(poll, POLL_INTERVAL_MS);
        } catch (err) {
            setLoading(false);
            setError(err?.message || "Erro ao buscar grupos");
        }
    }

    function fetchGroups() {
        attemptsRef.current = 0;
        setLoading(true);
        setError("");
        poll();
    }

    useEffect(() => {
        fetchGroups();
    }, []);

    async function handleSync() {
        attemptsRef.current = 0;
        setLoading(true);
        setError("");
        try {
            await api.syncGroupDiscovery();
            poll();
        } catch (err) {
            setLoading(false);
            setError(err?.message || "Erro ao sincronizar");
        }
    }

    return (
        <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
                <Autocomplete
                    sx={{ flex: 1 }}
                    options={groups}
                    getOptionLabel={(g) => `${g.subject || "(sem nome)"} — ${g.id}`}
                    loading={loading}
                    onChange={(_, value) => value && onSelect(value)}
                    renderInput={(params) => (
                        <TextField
                            {...params}
                            label={label}
                            size="small"
                            InputProps={{
                                ...params.InputProps,
                                endAdornment: (
                                    <>
                                        {loading ? <CircularProgress size={16} /> : null}
                                        {params.InputProps.endAdornment}
                                    </>
                                ),
                            }}
                        />
                    )}
                />
                <Button variant="outlined" size="small" onClick={handleSync} disabled={loading}>
                    Sync
                </Button>
            </Stack>
            {error && <Alert severity="warning">{error}</Alert>}
        </Stack>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/GroupPicker.js
git commit -m "feat: add shared GroupPicker component for group selection"
```

---

### Task 20: `pages/groups.js` — Groups admin screen

**Files:**
- Create: `pages/groups.js`

**Interfaces:**
- Consumes: `GroupPicker` (Task 19), `api.getGroups/createGroup/updateGroup/deleteGroup` (Task 17).

- [ ] **Step 1: Implement the page**

Follows the `pages/admin.js` super_admin gate pattern exactly (lines 29-36 of that file):

```javascript
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import {
    Card,
    CardContent,
    Grid,
    Typography,
    Alert,
    Stack,
    Switch,
    FormControlLabel,
    LinearProgress,
    Button,
    TextField,
} from "@mui/material";
import Layout from "../components/Layout";
import { useAuth } from "../lib/auth";
import { api } from "../lib/apiClient";
import GroupPicker from "../components/GroupPicker";

const FEATURES = [
    { key: "pokemonEnabled", label: "Pokémon" },
    { key: "confessionsEnabled", label: "Confissões" },
    { key: "scheduledGreetingsEnabled", label: "Saudações agendadas" },
    { key: "triggersEnabled", label: "Triggers" },
    { key: "contextSyncEnabled", label: "Sync de contexto" },
];

export default function GroupsPage() {
    const { user, loading, hasRole } = useAuth();
    const router = useRouter();
    const [groups, setGroups] = useState([]);
    const [loadingGroups, setLoadingGroups] = useState(false);
    const [error, setError] = useState("");
    const [newName, setNewName] = useState("");
    const [picked, setPicked] = useState(null);

    useEffect(() => {
        if (!loading && user && !hasRole("super_admin")) {
            router.replace("/403");
        }
        if (!loading && !user) {
            router.replace("/login");
        }
    }, [loading, user, hasRole, router]);

    function refresh() {
        setLoadingGroups(true);
        api.getGroups()
            .then((data) => setGroups(data || []))
            .catch((err) => setError(err?.message || "Erro ao carregar grupos"))
            .finally(() => setLoadingGroups(false));
    }

    useEffect(() => {
        if (!user || !hasRole("super_admin")) return;
        refresh();
    }, [user]);

    async function handleToggle(group, key) {
        await api.updateGroup(group.id, { [key]: !group[key] });
        setGroups((prev) =>
            prev.map((g) => (g.id === group.id ? { ...g, [key]: !g[key] } : g))
        );
    }

    async function handleDelete(id) {
        await api.deleteGroup(id);
        setGroups((prev) => prev.filter((g) => g.id !== id));
    }

    async function handleAdd() {
        if (!picked) return;
        const created = await api.createGroup({
            id: picked.id,
            name: newName.trim() || picked.subject || picked.id,
        });
        setGroups((prev) => [...prev, created]);
        setPicked(null);
        setNewName("");
    }

    if (loading || !user) return null;

    return (
        <Layout title="Gerenciar Grupos">
            <Grid container spacing={3}>
                <Grid item xs={12}>
                    {loadingGroups && <LinearProgress sx={{ mb: 2 }} />}
                    {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

                    <Card variant="outlined" sx={{ mb: 3 }}>
                        <CardContent>
                            <Typography variant="subtitle1" fontWeight={700} mb={1.5}>
                                Adicionar grupo
                            </Typography>
                            <Stack spacing={1.5}>
                                <GroupPicker onSelect={setPicked} label="Grupo do WhatsApp" />
                                <TextField
                                    label="Nome de exibição (opcional)"
                                    size="small"
                                    value={newName}
                                    onChange={(e) => setNewName(e.target.value)}
                                />
                                <Button variant="contained" onClick={handleAdd} disabled={!picked}>
                                    Adicionar
                                </Button>
                            </Stack>
                        </CardContent>
                    </Card>

                    <Stack spacing={2}>
                        {groups.map((g) => (
                            <Card key={g.id} variant="outlined">
                                <CardContent>
                                    <Stack
                                        direction={{ xs: "column", sm: "row" }}
                                        spacing={2}
                                        justifyContent="space-between"
                                    >
                                        <Stack spacing={0.5}>
                                            <Typography fontWeight={700}>{g.name}</Typography>
                                            <Typography variant="body2" color="text.secondary">
                                                {g.id}
                                            </Typography>
                                        </Stack>
                                        <Stack direction="row" flexWrap="wrap" spacing={1}>
                                            {FEATURES.map((f) => (
                                                <FormControlLabel
                                                    key={f.key}
                                                    control={
                                                        <Switch
                                                            checked={!!g[f.key]}
                                                            onChange={() => handleToggle(g, f.key)}
                                                            size="small"
                                                        />
                                                    }
                                                    label={f.label}
                                                />
                                            ))}
                                        </Stack>
                                        <Button color="error" size="small" onClick={() => handleDelete(g.id)}>
                                            Remover
                                        </Button>
                                    </Stack>
                                </CardContent>
                            </Card>
                        ))}
                        {!loadingGroups && groups.length === 0 && (
                            <Typography color="text.secondary">Nenhum grupo cadastrado.</Typography>
                        )}
                    </Stack>
                </Grid>
            </Grid>
        </Layout>
    );
}
```

- [ ] **Step 2: Add a nav link**

Find where `components/Layout.js` lists admin links (search for the existing `/admin` link) and add a `/groups` entry right next to it, using the same label/icon pattern already present for the admin link.

- [ ] **Step 3: Manual verification**

Start the frontend dev server, log in as a `super_admin` user, visit `/groups`, confirm the seeded main group is listed with all 5 switches on, and that the "Adicionar grupo" picker's Sync button triggers a request (network tab shows `POST /api/groups/discover/sync`).

- [ ] **Step 4: Commit**

```bash
git add pages/groups.js components/Layout.js
git commit -m "feat: add Groups admin screen for managing per-group feature toggles"
```

---

### Task 21: `pages/triggers.js` — group picker on the trigger form

**Files:**
- Modify: `pages/triggers.js`

- [ ] **Step 1: Add `groupId` to `emptyForm`**

In `pages/triggers.js`, add `groupId: "",` to the `emptyForm` object (after `name: "",` on line 38).

- [ ] **Step 2: Add the field to `TriggerForm`**

In the `TriggerForm` function (starting line 345), add a `GroupPicker` right after the `TextField label="Nome (opcional)"` block (after line 366, before the `{/* ── Gatilho ─── */}` comment):

```jsx
            <GroupPicker
                onSelect={(g) => setForm((p) => ({ ...p, groupId: g.id }))}
                label={form.groupId ? `Grupo: ${form.groupId}` : "Escolher grupo"}
            />
```

Add the import at the top of `pages/triggers.js` (after `import Layout from "../components/Layout";`):

```javascript
import GroupPicker from "../components/GroupPicker";
```

- [ ] **Step 3: Include `groupId` in `handleEdit`**

In `handleEdit` (starting line 1091), add `groupId: trigger.groupId || "",` right after `name: trigger.name || "",` (line 1094).

- [ ] **Step 4: Typecheck / build**

Run: `cd como-ja-e-dia-frontend && npm run build`
Expected: build succeeds with no type/lint errors.

- [ ] **Step 5: Manual verification**

Open `/triggers`, create a new trigger, confirm the `GroupPicker` requires a selection before the form can be usefully submitted (submitting without one hits the backend's `400 groupId é obrigatório` from Task 9 — surfaced via the existing `status.type === "error"` UI). Edit an existing (backfilled) trigger, confirm its group shows as pre-selected.

- [ ] **Step 6: Commit**

```bash
git add pages/triggers.js
git commit -m "feat: add group selection to the trigger create/edit form"
```

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-30-group-management-design.md` maps to a task — data model (Task 1), gating/fan-out for all 6 files (Tasks 3–8, 10), discovery+cache (Tasks 11, 12, 14), Group CRUD (Task 12), trigger scoping (Tasks 1, 8, 9, 21), frontend Groups screen (Tasks 17–20), mute-all (Tasks 11, 13, 14, 15, 16).
- **Type consistency:** `Group` field names (`pokemonEnabled`, `confessionsEnabled`, `scheduledGreetingsEnabled`, `triggersEnabled`, `contextSyncEnabled`) are identical across the Prisma schema (Task 1), `groupService.ts` (Task 2), all gating call sites (Tasks 4–10), the CRUD route (Task 12), and the frontend `FEATURES` array (Task 20). `muteAllGroups(sock)` signature and `ONE_WEEK_MS` export (Task 13) are reused verbatim in Tasks 14 and 15.
- **Ordering:** Task 1 (schema) must land before Task 2 (which imports `prisma.group`), which must land before every task that imports `groupService.js` (Tasks 4–10, 12). Task 11 (queues) must land before Task 12 (routes, which import them) and Tasks 14/15 (worker processors, which the queues dispatch to). Frontend Task 17 (apiClient) must land before Task 18 (proxy pages aren't strictly dependent, but) before Tasks 19–21 which call `api.*`.
