# Group-scoped Content — Events, Schedules, Persona, Triggers (sub-project 2 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Events, Schedules, and Persona group-aware (one group, several, or — `super_admin` only — every group), fix `Trigger`'s routes to check the resource's own group instead of the global `bom_dia_admin` role, and retire the legacy global `bom_dia_admin` role once every dependent route has migrated.

**Architecture:** Nullable `groupId` on `Event`/`Schedule`/`PersonaConfig` (null = every group, reachable only via `requireGroupAdmin`'s `super_admin` bypass). Mutating routes switch from `requireRole("bom_dia_admin")` to `requireGroupAdmin`. List routes switch to `requireAuth` + a Prisma `OR` filter (super_admin sees everything; anyone else sees their own groups' rows plus global ones). A new `GET /groups/mine` backs every frontend picker. `processScheduleJob`'s AI-caption generation moves from "once per run" to "once per target group, or once per unique persona bucket when nothing group-varying is being announced."

**Tech Stack:** TypeScript, Express, Prisma 7 (adapter-pg), PostgreSQL, Vitest, Next.js (pages router), MUI.

## Global Constraints

- Design specs: `docs/superpowers/specs/2026-08-04-group-scoped-admin-design.md` (sub-project 1, merged) and `docs/superpowers/specs/2026-08-05-group-scoped-content-design.md` (this sub-project).
- **The backend never trusts a client-submitted `groupId` just because the client's own UI only offered valid-looking options.** Every route accepting a `groupId` re-validates it server-side via `requireGroupAdmin` (single-resource routes) or an explicit flag/membership check (list/bulk flows). There is no bulk-create endpoint that accepts an array of `groupId`s and loops over them without per-item authorization — "apply to N of my groups" in the UI means N independent requests, each independently authorized.
- Backend tests run with `npm test` (vitest) from `como-ja-e-dia-backend/`. Frontend has no test runner; frontend tasks are verified with `npm run build`.
- Follow existing patterns: `register*Routes(app, deps?)` functions in `routes/`, Prisma via the shared `prisma` client in `services/db.ts`, vitest with `vi.mock()` module mocks (see `__tests__/groupAdminRoutes.test.ts`, `__tests__/requireGroupAdmin.test.ts` from sub-project 1 for the established style).
- Migrations are committed as SQL files under `prisma/migrations/`, applied automatically via `prisma db push --accept-data-loss` in `entrypoint.sh` — no live database is available while executing this plan; verify migration SQL by inspection against `schema.prisma`, not execution.
- Do not touch `routes/confessions.ts`, `routes/media.ts`, `routes/whatsappQr.ts`, `handlers/commands.ts`'s pokemon/miru logic, or anything about `miru_cadastro`/`super_admin` role definitions — out of scope for this sub-project.

---

### Task 1: Schema — `groupId` on Event/Schedule/PersonaConfig, `eventsEnabled` on Group

**Files:**
- Modify: `como-ja-e-dia-backend/prisma/schema.prisma`
- Create: `como-ja-e-dia-backend/prisma/migrations/20260805090000_group_scoped_content/migration.sql`
- Modify: `como-ja-e-dia-backend/services/groupService.ts` (`ensureGroupSeeded`)
- Modify: `como-ja-e-dia-backend/__tests__/groupService.test.ts`

**Interfaces:**
- Produces: `Event.groupId String?`, `Schedule.groupId String?`, `PersonaConfig.groupId String? @unique`, `Group.eventsEnabled Boolean`. Consumed by every later task in this plan.

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, change the `Event` model:

```prisma
model Event {
  id          String    @id @default(cuid())
  name        String
  date        DateTime
  groupId     String?
  createdAt   DateTime  @default(now())
  announced   Boolean   @default(false)
  announcedAt DateTime?
  claimedBy   String?
  claimedAt   DateTime?
}
```

Change the `Schedule` model — add `groupId` right after `id`:

```prisma
model Schedule {
  id                String    @id @default(cuid())
  groupId           String?
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
```

Change the `PersonaConfig` model:

```prisma
model PersonaConfig {
  id        Int      @id @default(autoincrement())
  groupId   String?  @unique
  prompt    String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

In the `Group` model, add `eventsEnabled` next to the other five flags (keep alphabetical-by-feature-area position, right after `contextSyncEnabled` is fine — order doesn't matter functionally):

```prisma
model Group {
  id                        String       @id
  name                      String
  pokemonEnabled            Boolean      @default(false)
  confessionsEnabled        Boolean      @default(false)
  scheduledGreetingsEnabled Boolean      @default(false)
  triggersEnabled           Boolean      @default(false)
  contextSyncEnabled        Boolean      @default(false)
  eventsEnabled             Boolean      @default(false)
  createdAt                 DateTime     @default(now())
  updatedAt                 DateTime     @updatedAt
  admins                    GroupAdmin[]
}
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260805090000_group_scoped_content/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Event" ADD COLUMN "groupId" TEXT;

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN "groupId" TEXT;

-- AlterTable
ALTER TABLE "PersonaConfig" ADD COLUMN "groupId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PersonaConfig_groupId_key" ON "PersonaConfig"("groupId");

-- AlterTable
ALTER TABLE "Group" ADD COLUMN "eventsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing Events and Schedules to the main seeded group (zero-downtime, matches 20260730164008_add_group_table's convention)
UPDATE "Event" SET "groupId" = COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us') WHERE "groupId" IS NULL;
UPDATE "Schedule" SET "groupId" = COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us') WHERE "groupId" IS NULL;

-- The existing PersonaConfig row stays groupId = NULL deliberately: it keeps acting as the fallback
-- persona for any group without its own override, exactly as it does today. No backfill here.

-- Enable the new eventsEnabled flag for the main group (matches the other five flags there)
UPDATE "Group" SET "eventsEnabled" = true WHERE "id" = COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us');
```

Self-review this SQL by inspection (no live database available): column names/types match the schema edit above; `PersonaConfig_groupId_key` is the unique index Prisma would generate from `@unique` on `groupId`; the `Event`/`Schedule` backfill mirrors `20260730164008_add_group_table/migration.sql`'s existing `COALESCE(NULLIF(current_setting(...))...)` pattern exactly (same fallback literal `'120363339314665620@g.us'`); the `PersonaConfig` row is correctly left untouched (no `UPDATE` statement for it).

- [ ] **Step 3: Update `ensureGroupSeeded` to set the new flag**

In `services/groupService.ts`, `ensureGroupSeeded`'s `create` block currently sets five flags to `true`. Add the sixth:

```ts
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
      eventsEnabled: true,
    },
  });
}
```

- [ ] **Step 4: Update the existing `ensureGroupSeeded` test**

In `__tests__/groupService.test.ts`, the test `'ensureGroupSeeded upserts with the given id and name, all toggles left untouched on conflict'` asserts the exact `create` payload — add `eventsEnabled: true` to its expected object:

```ts
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
        eventsEnabled: true,
      },
    })
  })
```

- [ ] **Step 5: Regenerate the Prisma client and verify**

Run: `cd como-ja-e-dia-backend && npx prisma generate && npx vitest run __tests__/groupService.test.ts && npx tsc --noEmit`
Expected: client regenerates cleanly, the updated test passes, no type errors (later tasks will introduce new usages of `groupId` — this step only confirms today's code still compiles against the widened schema).

- [ ] **Step 6: Commit**

```bash
cd como-ja-e-dia-backend
git add prisma/schema.prisma prisma/migrations/20260805090000_group_scoped_content services/groupService.ts __tests__/groupService.test.ts
git commit -m "feat(db): add groupId to Event/Schedule/PersonaConfig, eventsEnabled to Group"
```

---

### Task 2: `requireGroupAdmin` — 400 → 403 for a null-resolved groupId

**Files:**
- Modify: `como-ja-e-dia-backend/middleware/auth.ts`
- Modify: `como-ja-e-dia-backend/__tests__/requireGroupAdmin.test.ts`

**Interfaces:**
- `requireGroupAdmin`'s exported signature is unchanged. Only its response for one branch changes: `400 {error: "groupId é obrigatório"}` → `403 {error: "Sem permissão para operar fora de um grupo específico"}`.

- [ ] **Step 1: Update the failing test**

In `__tests__/requireGroupAdmin.test.ts`, find the test `'returns 400 when getGroupId resolves to null'` and change it to expect 403:

```ts
  it('returns 403 when getGroupId resolves to null (only super_admin may operate outside a specific group)', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => null)(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/requireGroupAdmin.test.ts`
Expected: FAIL — the renamed test still hits the old `400` code path.

- [ ] **Step 3: Update the middleware**

In `middleware/auth.ts`, inside `requireGroupAdmin`, change:

```ts
        const groupId = await getGroupId(req);
        if (!groupId) {
          res.status(400).json({ error: "groupId é obrigatório" });
          return;
        }
```

to:

```ts
        const groupId = await getGroupId(req);
        if (!groupId) {
          res.status(403).json({ error: "Sem permissão para operar fora de um grupo específico" });
          return;
        }
```

- [ ] **Step 4: Run to verify it passes, then the full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/requireGroupAdmin.test.ts && npx vitest run __tests__ && npx tsc --noEmit`
Expected: all PASS (same pre-existing unrelated `anilistService.test.ts` failures as always — nothing new).

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add middleware/auth.ts __tests__/requireGroupAdmin.test.ts
git commit -m "fix: requireGroupAdmin returns 403 (not 400) when groupId resolves to null for a non-super_admin"
```

---

### Task 3: `GET /groups/mine`

**Files:**
- Modify: `como-ja-e-dia-backend/routes/groups.ts`
- Test: `como-ja-e-dia-backend/__tests__/groupAdminRoutes.test.ts` (extend)

**Interfaces:**
- Consumes: `getAdminGroupIds` (from `services/groupService.ts`, sub-project 1).
- Produces: `GET /groups/mine`, `requireAuth` only → `Array<{ id, name, pokemonEnabled, confessionsEnabled, scheduledGreetingsEnabled, triggersEnabled, contextSyncEnabled, eventsEnabled, createdAt, updatedAt }>` — every field of `Group`. `super_admin` gets every group; anyone else gets exactly the groups in their `adminGroupIds`. Consumed by Task 9 (frontend).

- [ ] **Step 1: Write the failing tests**

In `__tests__/groupAdminRoutes.test.ts`, add the `getAdminGroupIds` mock to the existing `vi.mock('../services/groupService.js', ...)` block (it currently only mocks `resetGroupCache`):

```ts
vi.mock('../services/groupService.js', () => ({
  resetGroupCache: vi.fn(),
  getAdminGroupIds: vi.fn(),
}))
```

Add the import alongside the existing ones:

```ts
import { resetGroupCache, getAdminGroupIds } from '../services/groupService.js'
```

Add a new describe block:

```ts
describe('GET /groups/mine', () => {
  it('returns every group for a super_admin', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['GET /groups/mine'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.group.findMany).mockResolvedValue([
      { id: 'a@g.us', name: 'A' },
      { id: 'b@g.us', name: 'B' },
    ] as any)
    const req = { user: { id: 'u1', roles: [{ role: { slug: 'super_admin' } }] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    expect(prisma.group.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'asc' } })
    expect(getAdminGroupIds).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith([
      { id: 'a@g.us', name: 'A' },
      { id: 'b@g.us', name: 'B' },
    ])
  })

  it('returns only the groups a scoped admin administers', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['GET /groups/mine'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getAdminGroupIds).mockResolvedValue(['a@g.us'])
    vi.mocked(prisma.group.findMany).mockResolvedValue([{ id: 'a@g.us', name: 'A' }] as any)
    const req = { user: { id: 'u1', roles: [{ role: { slug: 'bom_dia_admin' } }] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    expect(getAdminGroupIds).toHaveBeenCalledWith('u1')
    expect(prisma.group.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a@g.us'] } },
      orderBy: { createdAt: 'asc' },
    })
    expect(res.json).toHaveBeenCalledWith([{ id: 'a@g.us', name: 'A' }])
  })

  it('returns an empty array for a user administering nothing, not an error', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['GET /groups/mine'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getAdminGroupIds).mockResolvedValue([])
    vi.mocked(prisma.group.findMany).mockResolvedValue([] as any)
    const req = { user: { id: 'u1', roles: [] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    expect(prisma.group.findMany).toHaveBeenCalledWith({ where: { id: { in: [] } }, orderBy: { createdAt: 'asc' } })
    expect(res.json).toHaveBeenCalledWith([])
  })
})
```

Also add `'GET /groups/mine'` to the existing `'all routes require auth'`-style wiring assertion if one exists for `GET /groups`, or add a small standalone check that `routes['GET /groups/mine']` contains `requireAuth`. (Note: unlike the other `/groups*` routes, this one must NOT contain `requireRole` — check `requireRole` was not part of its handler chain.)

- [ ] **Step 2: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/groupAdminRoutes.test.ts`
Expected: FAIL — `GET /groups/mine` isn't registered yet.

- [ ] **Step 3: Implement the route**

In `routes/groups.ts`, add the import:

```ts
import { resetGroupCache, getAdminGroupIds } from "../services/groupService.js";
```

(This file already imports `resetGroupCache` from that module — extend the existing import line rather than adding a duplicate.)

Add the new route inside `registerGroupRoutes`, before the existing `app.get("/groups", ...)` route (order doesn't matter functionally, but keeping "mine" near the top keeps related list endpoints together):

```ts
  app.get("/groups/mine", requireAuth, async (req, res) => {
    try {
      const userSlugs = req.user?.roles?.map((ur) => ur.role.slug) ?? [];
      const isSuperAdmin = userSlugs.includes("super_admin");
      const where = isSuperAdmin
        ? {}
        : { id: { in: await getAdminGroupIds(req.user!.id) } };
      const groups = await prisma.group.findMany({ where, orderBy: { createdAt: "asc" } });
      res.json(groups);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar seus grupos";
      res.status(500).json({ error: msg });
    }
  });
```

Note this route only needs `requireAuth` — it's imported already in this file (used by every other route). Do not add `requireRole` to it.

- [ ] **Step 4: Run to verify it passes, then full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/groupAdminRoutes.test.ts && npx vitest run __tests__ && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/groups.ts __tests__/groupAdminRoutes.test.ts
git commit -m "feat: add GET /groups/mine for scoped-admin-aware group pickers"
```

---

### Task 4: Events — group-scoped backend

**Files:**
- Modify: `como-ja-e-dia-backend/routes/events.ts`
- Modify: `como-ja-e-dia-backend/services/scheduledJobs.ts` (`buildEventsContext` signature only — full fan-out rewrite is Task 5)
- Test: `como-ja-e-dia-backend/__tests__/events.test.ts` (new — this route file has no dedicated test today)

**Interfaces:**
- Produces: `POST /events` requires `groupId` in the body (or is omitted only by `super_admin`, per `requireGroupAdmin`); `DELETE /events/:id` uses the existing event's own `groupId`; `GET /events` requires auth and is filtered. `buildEventsContext(tz: string, groupId: string): Promise<EventsContext>` — signature gains a required second parameter. Consumed by Task 5 (`processScheduleJob` calls it per target group).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/events.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
  requireGroupAdmin: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/groupService.js', () => ({
  getAdminGroupIds: vi.fn(),
}))

import { requireAuth, requireGroupAdmin } from '../middleware/auth.js'
import { getAdminGroupIds } from '../services/groupService.js'
import { registerEventRoutes } from '../routes/events.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
    delete: (path: string, ...h: unknown[]) => { routes[`DELETE ${path}`] = h },
  }
  return { app: app as any, routes }
}

function makeDeps() {
  return {
    prisma: {
      event: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
    } as any,
    isDbConnected: () => true,
    tz: (d: any) => ({ isValid: () => true, isBefore: () => false, toDate: () => new Date(d) }) as any,
    moment: Object.assign((d: any) => ({ isValid: () => true, toDate: () => new Date(d) }), {}) as any,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('event routes wiring', () => {
  it('GET /events requires auth (no longer public)', () => {
    const { app, routes } = makeApp()
    registerEventRoutes(app, makeDeps())
    expect(routes['GET /events']).toContain(requireAuth)
  })

  it('POST and DELETE use requireGroupAdmin, not requireRole', () => {
    const { app, routes } = makeApp()
    registerEventRoutes(app, makeDeps())
    expect(routes['POST /events']).toContain(requireAuth)
    expect(routes['DELETE /events/:id']).toContain(requireAuth)
  })
})

describe('GET /events filtering', () => {
  it('super_admin sees every event', async () => {
    const { app, routes } = makeApp()
    const deps = makeDeps()
    registerEventRoutes(app, deps)
    const handler = routes['GET /events'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(deps.prisma.event.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [{ role: { slug: 'super_admin' } }] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(deps.prisma.event.findMany).mock.calls[0][0] as any
    expect(call.where.groupId).toBeUndefined()
    expect(getAdminGroupIds).not.toHaveBeenCalled()
  })

  it('a scoped admin sees only their groups plus global events', async () => {
    const { app, routes } = makeApp()
    const deps = makeDeps()
    registerEventRoutes(app, deps)
    const handler = routes['GET /events'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getAdminGroupIds).mockResolvedValue(['a@g.us'])
    vi.mocked(deps.prisma.event.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(deps.prisma.event.findMany).mock.calls[0][0] as any
    expect(call.where.OR).toEqual([{ groupId: null }, { groupId: { in: ['a@g.us'] } }])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/events.test.ts`
Expected: FAIL — current `routes/events.ts` still uses `requireRole`/no auth on GET, and doesn't filter.

- [ ] **Step 3: Implement**

Replace `routes/events.ts` in full:

```ts
import { Express } from "express";
import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import { requireAuth, requireGroupAdmin } from "../middleware/auth.js";
import { getAdminGroupIds } from "../services/groupService.js";

export function registerEventRoutes(
  app: Express,
  {
    prisma,
    isDbConnected,
    tz,
    moment: momentLib,
  }: {
    prisma: PrismaClient;
    isDbConnected: () => boolean;
    tz: typeof moment.tz;
    moment: typeof moment;
  }
) {
  app.get("/events", requireAuth, async (req, res) => {
    if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
    try {
      const userSlugs = req.user?.roles?.map((ur) => ur.role.slug) ?? [];
      const isSuperAdmin = userSlugs.includes("super_admin");
      const now = new Date();
      const scopeWhere = isSuperAdmin
        ? {}
        : { OR: [{ groupId: null }, { groupId: { in: await getAdminGroupIds(req.user!.id) } }] };
      const events = await prisma.event.findMany({
        where: { ...scopeWhere, announced: false, claimedBy: null, date: { gt: now } },
        orderBy: { date: "asc" },
      });
      res.json(events);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro";
      res.status(500).json({ error: msg });
    }
  });

  app.post(
    "/events",
    requireGroupAdmin((req) => ((req.body?.groupId as string) || "").trim() || null),
    async (req, res) => {
      if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
      try {
        const { name, date, groupId } = req.body;
        if (!name || !date)
          return res.status(400).json({ error: "name and date are required" });

        let m = tz(date, "America/Sao_Paulo");
        if (!m.isValid()) {
          m = momentLib(date);
          if (!m.isValid())
            return res.status(400).json({ error: "Invalid date format" });
        }

        const nowSP = tz("America/Sao_Paulo");
        if (m.isBefore(nowSP)) {
          return res.status(400).json({ error: "Cannot create event in the past" });
        }

        const ev = await prisma.event.create({
          data: { name, date: m.toDate(), groupId: (groupId as string) || null },
        });
        res.status(201).json(ev);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro";
        res.status(500).json({ error: msg });
      }
    }
  );

  app.delete(
    "/events/:id",
    requireGroupAdmin(async (req) => {
      const existing = await prisma.event.findUnique({ where: { id: req.params.id } });
      return existing?.groupId ?? null;
    }),
    async (req, res) => {
      if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
      try {
        await prisma.event.delete({ where: { id: req.params.id } });
        res.json({ success: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro";
        res.status(500).json({ error: msg });
      }
    }
  );
}
```

Note: `requireGroupAdmin` on `DELETE /events/:id` resolves `groupId` by looking the event up *before* the delete handler runs, so a non-super_admin deleting an event with `groupId = null` (a super_admin's global event) correctly gets `403` — if the lookup itself finds nothing (`existing` is `null`), `existing?.groupId ?? null` is also `null`, giving a `403` rather than the more accurate `404`; that's an acceptable, deliberately simple trade-off (a non-admin's request to delete a nonexistent event was never going to succeed either way, and `super_admin` still gets the correct `404` from the delete handler's own `P2025`-less current code path — note the existing handler has no P2025 catch today; leave that as-is, out of scope for this task).

In `services/scheduledJobs.ts`, change `buildEventsContext`'s signature and query — this task only changes the signature and query shape; Task 5 changes every call site:

```ts
async function buildEventsContext(tz: string, groupId: string) {
  const now = moment.tz(tz);
  const start = now.clone().startOf("day");
  const end = now.clone().endOf("day");

  const scope = { OR: [{ groupId: null }, { groupId }] };

  const eventsToday = await prisma.event.findMany({
    where: { ...scope, date: { gte: start.toDate(), lte: end.toDate() } },
    orderBy: { date: "asc" },
  });

  const nextEvents = await prisma.event.findMany({
    where: { ...scope, date: { gt: end.toDate() } },
    orderBy: { date: "asc" },
    take: 1,
  });
  // ... rest of the function body is unchanged
```

(Leave everything after `const nextEvent = nextEvents[0] || null;` untouched — only the two `findMany` calls above and the function signature change.)

- [ ] **Step 4: Run to verify it passes, then full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/events.test.ts && npx vitest run __tests__ && npx tsc --noEmit`
Expected: `events.test.ts` passes. The full suite and typecheck WILL show a new error: `processScheduleJob` still calls `buildEventsContext(schedule.timezone || ...)` with only one argument. That call site is intentionally fixed in Task 5, not here — confirm the typecheck failure is exactly that one call site in `services/scheduledJobs.ts` (the one inside `processScheduleJob`, not the function definition itself) and no other file, then proceed; do not silence or work around it.

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/events.ts services/scheduledJobs.ts __tests__/events.test.ts
git commit -m "feat: scope Events to groups (requireGroupAdmin, filtered list, per-group buildEventsContext signature)"
```

(The known, expected typecheck failure at the `processScheduleJob` call site is resolved in Task 5, in the same branch, before this branch is considered done.)

---

### Task 5: Schedules — group-scoped backend + per-group AI fan-out

**Files:**
- Modify: `como-ja-e-dia-backend/routes/schedules.ts`
- Modify: `como-ja-e-dia-backend/services/scheduledJobs.ts` (`processScheduleJob`, target-resolution, fan-out algorithm)
- Test: `como-ja-e-dia-backend/__tests__/scheduleRoutes.test.ts` (new)
- Test: `como-ja-e-dia-backend/__tests__/scheduledJobs.test.ts` (new)

**Interfaces:**
- Consumes: `buildEventsContext(tz, groupId)` (Task 4), `getPersonaPrompt(groupId)` (Task 7 — this task's fan-out algorithm calls it; implement Task 7's `groupId`-aware signature first, or stub it consistently — **do Task 7 before this task** if executing out of plan order; the plan's suggested order at the bottom already sequences this correctly).
- Produces: `POST/PUT /schedules` require `groupId` (or `super_admin`); `GET /schedules` filtered like Events; `processScheduleJob` resolves its target-group list from the schedule's own `groupId` (falling back to `getScheduledGreetingsEnabledGroupIds()` only when `groupId` is null) and generates captions per the announceEvents/persona-bucket algorithm from the spec.

- [ ] **Step 1: Write the failing route-wiring tests**

Create `__tests__/scheduleRoutes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
  requireGroupAdmin: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/groupService.js', () => ({
  getAdminGroupIds: vi.fn(),
}))

vi.mock('../services/scheduledJobs.js', () => ({
  clearRepeat: vi.fn(),
  registerRepeat: vi.fn(),
  resyncSchedules: vi.fn(),
}))

import { requireAuth } from '../middleware/auth.js'
import { getAdminGroupIds } from '../services/groupService.js'
import { registerScheduleRoutes } from '../routes/schedules.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
    put: (path: string, ...h: unknown[]) => { routes[`PUT ${path}`] = h },
    delete: (path: string, ...h: unknown[]) => { routes[`DELETE ${path}`] = h },
  }
  return { app: app as any, routes }
}

vi.mock('../services/db.js', () => ({
  prisma: { schedule: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() } },
}))

import { prisma } from '../services/db.js'

beforeEach(() => vi.clearAllMocks())

describe('schedule routes wiring', () => {
  it('GET /schedules requires auth only (no requireRole)', () => {
    const { app, routes } = makeApp()
    registerScheduleRoutes(app)
    expect(routes['GET /schedules']).toContain(requireAuth)
  })

  it('POST, PUT, DELETE, and resync use requireGroupAdmin-style gating (contain requireAuth, not a bare requireRole check)', () => {
    const { app, routes } = makeApp()
    registerScheduleRoutes(app)
    for (const key of ['POST /schedules', 'PUT /schedules/:id', 'DELETE /schedules/:id', 'POST /schedules/resync']) {
      expect(routes[key]).toContain(requireAuth)
    }
  })
})

describe('GET /schedules filtering', () => {
  it('super_admin sees every schedule', async () => {
    const { app, routes } = makeApp()
    registerScheduleRoutes(app)
    const handler = routes['GET /schedules'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [{ role: { slug: 'super_admin' } }] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(prisma.schedule.findMany).mock.calls[0][0] as any
    expect(call.where).toBeUndefined()
    expect(getAdminGroupIds).not.toHaveBeenCalled()
  })

  it('a scoped admin sees only their groups plus global schedules', async () => {
    const { app, routes } = makeApp()
    registerScheduleRoutes(app)
    const handler = routes['GET /schedules'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getAdminGroupIds).mockResolvedValue(['a@g.us'])
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(prisma.schedule.findMany).mock.calls[0][0] as any
    expect(call.where.OR).toEqual([{ groupId: null }, { groupId: { in: ['a@g.us'] } }])
  })
})

describe('POST /schedules/resync', () => {
  it('403s a non-super_admin (requireGroupAdmin(() => null) always fails the non-bypass branch)', async () => {
    const { app, routes } = makeApp()
    registerScheduleRoutes(app)
    // The real middleware is mocked as a pass-through above for wiring checks;
    // this test asserts the route is registered with requireGroupAdmin at all —
    // requireGroupAdmin's own behavior for a `() => null` resolver is already
    // covered by __tests__/requireGroupAdmin.test.ts (Task 2), not re-tested here.
    expect(routes['POST /schedules/resync']).toContain(requireAuth)
  })
})
```

`POST /schedules/resync` has no single resource to scope to — it resyncs every active schedule's BullMQ repeat jobs. Per the design, only `super_admin` should be able to trigger this (it affects every group's schedules at once), so it keeps a role check, but the global role is being retired — use `requireGroupAdmin(() => null)` is wrong (that always 403s for non-super_admin, which is actually the desired effect: only `super_admin` can ever pass, since `null` always fails the non-super_admin branch). Add one test: `POST /schedules/resync` requires auth and, for a non-super_admin, always 403s (verify by calling the handler with a non-super_admin `req.user` and asserting `res.status(403)` was called) — treat `requireGroupAdmin(() => null)` as the correct, intentional way to express "super_admin only" going forward without depending on the retired `bom_dia_admin`/`super_admin`-via-`requireRole` pattern (the middleware's own `super_admin` bypass still makes `super_admin` succeed; nobody else can ever supply a satisfying `groupId` since the function always returns `null`).

- [ ] **Step 2: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/scheduleRoutes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the route changes**

In `routes/schedules.ts`:
- Change the import: `import { requireAuth, requireGroupAdmin } from "../middleware/auth.js";` and add `import { getAdminGroupIds } from "../services/groupService.js";`.
- `parseSchedule` gains one more field at the top: `safe.groupId = ((body.groupId || "") as string).toString().trim() || null;`
- `GET /schedules`: change to `requireAuth` only, and filter:

```ts
  app.get("/schedules", requireAuth, async (req, res) => {
    try {
      const userSlugs = req.user?.roles?.map((ur) => ur.role.slug) ?? [];
      const isSuperAdmin = userSlugs.includes("super_admin");
      const where = isSuperAdmin
        ? {}
        : { OR: [{ groupId: null }, { groupId: { in: await getAdminGroupIds(req.user!.id) } }] };
      const list = await prisma.schedule.findMany({ where, orderBy: { createdAt: "desc" } });
      res.json(list);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar schedules";
      res.status(500).json({ error: msg });
    }
  });
```

- `POST /schedules`: replace `requireAuth, requireRole("bom_dia_admin")` with `requireGroupAdmin((req) => ((req.body?.groupId as string) || "").trim() || null)`. The handler body is otherwise unchanged (it already calls `parseSchedule`, which now includes `groupId` in its output).
- `PUT /schedules/:id`: replace with `requireGroupAdmin(async (req) => { const existing = await prisma.schedule.findUnique({ where: { id: req.params.id } }); return existing?.groupId ?? null; })`. Handler body unchanged.
- `DELETE /schedules/:id`: same `requireGroupAdmin` resolver as `PUT`. Handler body unchanged.
- `POST /schedules/resync`: replace `requireAuth, requireRole("bom_dia_admin")` with `requireGroupAdmin(() => null)` (see Step 1's reasoning — this makes it `super_admin`-only via the middleware's existing bypass, with no dependency on the retired role).

- [ ] **Step 4: Run route tests to verify they pass**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/scheduleRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing fan-out algorithm tests**

Create `__tests__/scheduledJobs.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    schedule: { findUnique: vi.fn() },
    event: { findMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('../services/ai.js', () => ({ generateAICaption: vi.fn().mockResolvedValue('caption') }))
vi.mock('../services/sendQueue.js', () => ({ enqueueSendMessage: vi.fn() }))
vi.mock('../services/logger.js', () => ({ log: vi.fn() }))
vi.mock('../mediaManager.js', () => ({ getRandomMedia: vi.fn().mockResolvedValue(null) }))
vi.mock('../services/groupService.js', () => ({
  getScheduledGreetingsEnabledGroupIds: vi.fn(),
  isTriggersEnabledForGroup: vi.fn(),
}))
vi.mock('../services/personaConfig.js', () => ({ getPersonaPrompt: vi.fn() }))
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
}))

import { prisma } from '../services/db.js'
import { generateAICaption } from '../services/ai.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { getPersonaPrompt } from '../services/personaConfig.js'
import { getScheduledGreetingsEnabledGroupIds } from '../services/groupService.js'

// processScheduleJob is not exported today — export it from services/scheduledJobs.ts
// as part of this task (add `export` to its existing declaration; no behavior change).
import { processScheduleJob } from '../services/scheduledJobs.js'

beforeEach(() => vi.clearAllMocks())

function baseSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', active: true, groupId: 'a@g.us', timezone: 'America/Sao_Paulo',
    type: 'text', textContent: 'oi', captionMode: 'none', announceEvents: false,
    personaPrompt: '', includeRandomPool: false, includeIntro: false,
    startDate: null, endDate: null, daysOfWeek: [],
    ...overrides,
  }
}

describe('processScheduleJob target resolution', () => {
  it('a schedule with a specific groupId targets only that group', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(baseSchedule() as any)
    await processScheduleJob('s1')
    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)
    expect(enqueueSendMessage).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'a@g.us' }))
    expect(getScheduledGreetingsEnabledGroupIds).not.toHaveBeenCalled()
  })

  it('a schedule with groupId=null falls back to every scheduledGreetingsEnabled group', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(baseSchedule({ groupId: null }) as any)
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    await processScheduleJob('s1')
    expect(enqueueSendMessage).toHaveBeenCalledTimes(2)
  })
})

describe('processScheduleJob AI caption fan-out', () => {
  it('calls generateAICaption once per group when announceEvents is true', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: true, captionMode: 'auto', type: 'image', mediaUrl: 'x' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    vi.mocked(prisma.event.findMany).mockResolvedValue([])
    await processScheduleJob('s1')
    expect(generateAICaption).toHaveBeenCalledTimes(2)
  })

  it('calls generateAICaption once and reuses it for groups sharing the same resolved persona when announceEvents is false', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: false, captionMode: 'auto', type: 'image', mediaUrl: 'x' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    vi.mocked(getPersonaPrompt).mockResolvedValue('same persona for both')
    await processScheduleJob('s1')
    expect(generateAICaption).toHaveBeenCalledTimes(1)
    expect(enqueueSendMessage).toHaveBeenCalledTimes(2)
  })

  it('calls generateAICaption once per distinct persona bucket when groups resolve to different personas', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: false, captionMode: 'auto', type: 'image', mediaUrl: 'x' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    vi.mocked(getPersonaPrompt).mockImplementation(async (groupId?: string) =>
      groupId === 'a@g.us' ? 'persona A' : 'persona B'
    )
    await processScheduleJob('s1')
    expect(generateAICaption).toHaveBeenCalledTimes(2)
  })

  it('a schedule-level personaPrompt override puts every group in the same bucket without calling getPersonaPrompt', async () => {
    vi.mocked(prisma.schedule.findUnique).mockResolvedValue(
      baseSchedule({ groupId: null, announceEvents: false, captionMode: 'auto', type: 'image', mediaUrl: 'x', personaPrompt: 'override' }) as any
    )
    vi.mocked(getScheduledGreetingsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    await processScheduleJob('s1')
    expect(generateAICaption).toHaveBeenCalledTimes(1)
    expect(getPersonaPrompt).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/scheduledJobs.test.ts`
Expected: FAIL — `processScheduleJob` isn't exported, and the current implementation doesn't do per-group/bucketed generation.

- [ ] **Step 7: Rewrite `processScheduleJob`**

In `services/scheduledJobs.ts`:
- Export `processScheduleJob` (add the `export` keyword to its existing `async function processScheduleJob(...)` declaration — no other change to that line).
- Add the import: `import { getPersonaPrompt } from "./personaConfig.js";` (Task 7 must define `getPersonaPrompt(groupId?: string)` before this task runs — see the plan's suggested task order below).
- Replace the body from `const greetingHint = resolveGreeting(now);` through the `for (const groupId of groupIds) { ... }` caption/payload-building block (i.e., everything through the closing of that original loop, NOT the `includeRandomPool` block below it, which stays structurally the same but now needs to run once per group too — see below) with:

```ts
  const greetingHint = resolveGreeting(now);

  let groupIds: string[];
  if (schedule.groupId) {
    groupIds = [schedule.groupId];
  } else {
    groupIds = await getScheduledGreetingsEnabledGroupIds();
  }

  const payloads: Parameters<typeof enqueueSendMessage>[0][] = [];
  const mediaUrl = schedule.mediaUrl || "";

  if (groupIds.length) {
    if (schedule.captionMode !== "auto") {
      // No AI call needed — 'custom' and 'none' captions don't vary by group at all.
      let caption: string | null = null;
      if (schedule.captionMode === "custom") caption = schedule.customCaption || "";
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
    } else if (schedule.announceEvents) {
      // Events (and therefore the caption) can differ per group — one call per group, no bucketing.
      for (const groupId of groupIds) {
        const eventsContext = await buildEventsContext(schedule.timezone || "America/Sao_Paulo", groupId);
        let caption: string | null = null;
        try {
          caption = await generateAICaption({
            purpose: "greeting",
            names: eventsContext.names,
            timeStr: eventsContext.eventsTodayDetails,
            announceEvents: true,
            noEvents: !eventsContext.hasEvents,
            dayOfWeek: now.format("dddd"),
            todayDateStr: now.format("DD/MM/YYYY"),
            personaOverride: schedule.personaPrompt || (await getPersonaPrompt(groupId)),
            eventsTodayDetails: eventsContext.eventsTodayDetails,
            nearestDateStr: eventsContext.nearestDateStr,
            countdown: eventsContext.countdown,
            greetingHint,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Falha ao gerar caption auto para ${groupId}: ${msg}`, "warn");
        }
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
    } else {
      // No events to announce — the only thing that can vary by group is persona.
      // Bucket groups by resolved persona text so identical captions are generated once, not N times.
      const personaByGroup = new Map<string, string>();
      for (const groupId of groupIds) {
        personaByGroup.set(groupId, schedule.personaPrompt || (await getPersonaPrompt(groupId)));
      }
      const captionByPersona = new Map<string, string | null>();
      for (const persona of new Set(personaByGroup.values())) {
        try {
          captionByPersona.set(
            persona,
            await generateAICaption({
              purpose: "greeting",
              names: [],
              timeStr: null,
              announceEvents: false,
              noEvents: false,
              dayOfWeek: now.format("dddd"),
              todayDateStr: now.format("DD/MM/YYYY"),
              personaOverride: persona,
              eventsTodayDetails: null,
              nearestDateStr: null,
              countdown: null,
              greetingHint,
            })
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Falha ao gerar caption auto: ${msg}`, "warn");
          captionByPersona.set(persona, null);
        }
      }
      for (const groupId of groupIds) {
        const caption = captionByPersona.get(personaByGroup.get(groupId)!) ?? null;
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
    }
  }
```

This replaces the original single `shouldAnnounceEvents`/`eventsContext`/one-shot-`generateAICaption` block AND the original `for (const groupId of groupIds) { ...push payload... }` loop that followed it — both are now folded into the three-way branch above (`captionMode !== 'auto'`, `announceEvents`, else-bucketed). The `includeRandomPool` block immediately after (the `if (schedule.includeRandomPool !== false && groupIds.length) { ... }` section using `getRandomMedia`/random `Phrase`) is **unchanged** — it already loops `for (const groupId of groupIds)` and has no AI call, so it needs no modification; leave it exactly as-is, immediately following the block above.

Also delete the old top-of-function lines that are now superseded (the original `const shouldAnnounceEvents = !!schedule.announceEvents;`, the original `const eventsContext = shouldAnnounceEvents ? await buildEventsContext(...) : {...}` block, and the original single `let caption: string | null = null; if (schedule.captionMode === "custom") ... else if (schedule.captionMode === "auto") { ... }` block, and the original `const groupIds = await getScheduledGreetingsEnabledGroupIds();` line) — all of that logic is now inside the branch above.

- [ ] **Step 8: Run to verify tests pass, then full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/scheduledJobs.test.ts && npx vitest run __tests__ && npx tsc --noEmit`
Expected: all PASS, no type errors (this is also where Task 4's expected `buildEventsContext` call-site typecheck failure gets resolved, since this task's rewrite calls it with two arguments).

- [ ] **Step 9: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/schedules.ts services/scheduledJobs.ts __tests__/scheduleRoutes.test.ts __tests__/scheduledJobs.test.ts
git commit -m "feat: scope Schedules to groups; generate AI captions per-group or per-persona-bucket instead of once for every recipient"
```

---

### Task 6: Triggers — auth fix + list filtering

**Files:**
- Modify: `como-ja-e-dia-backend/routes/triggers.ts`
- Test: `como-ja-e-dia-backend/__tests__/triggerRoutes.test.ts` (new — this route file has no dedicated route test today, only `__tests__/triggers.test.ts` which tests the *message-handling* side in `handlers/triggers.ts`, a different file)

**Interfaces:**
- Produces: same auth pattern as Events/Schedules — `GET /triggers` filtered via `requireAuth`; `POST /triggers` via `requireGroupAdmin` reading `req.body.groupId`; `PUT/DELETE /triggers/:id` via `requireGroupAdmin` looking up the existing trigger's `groupId`. No schema change (Trigger's `groupId` is already required/non-null) and no "global trigger" concept — `requireGroupAdmin`'s `getGroupId` for `POST` should reject an empty/missing `groupId` the same way validation already does (the existing `validateTriggerPayload` throws `"groupId é obrigatório"` if empty — that check stays; `requireGroupAdmin` runs *before* the handler, so an empty `groupId` on `POST` now fails at the `requireGroupAdmin` layer with `403` before `validateTriggerPayload` ever runs. That's fine — the existing validation becomes unreachable dead code for that one case but is not removed, since it's still the correct guard against a `super_admin` submitting an empty `groupId`, which `requireGroupAdmin` would NOT catch — the `super_admin` bypass never calls `getGroupId` at all).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/triggerRoutes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
  requireGroupAdmin: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/groupService.js', () => ({
  getAdminGroupIds: vi.fn(),
}))

vi.mock('../services/db.js', () => ({
  prisma: { trigger: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() } },
}))

import { requireAuth } from '../middleware/auth.js'
import { getAdminGroupIds } from '../services/groupService.js'
import { prisma } from '../services/db.js'
import { registerTriggerRoutes } from '../routes/triggers.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
    put: (path: string, ...h: unknown[]) => { routes[`PUT ${path}`] = h },
    delete: (path: string, ...h: unknown[]) => { routes[`DELETE ${path}`] = h },
  }
  return { app: app as any, routes }
}

beforeEach(() => vi.clearAllMocks())

describe('trigger routes wiring', () => {
  it('GET /triggers requires auth only (no requireRole)', () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    expect(routes['GET /triggers']).toContain(requireAuth)
  })

  it('POST, PUT, and DELETE are gated (contain requireAuth via requireGroupAdmin)', () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    for (const key of ['POST /triggers', 'PUT /triggers/:id', 'DELETE /triggers/:id']) {
      expect(routes[key]).toContain(requireAuth)
    }
  })
})

describe('GET /triggers filtering', () => {
  it('super_admin sees every trigger', async () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    const handler = routes['GET /triggers'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [{ role: { slug: 'super_admin' } }] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(prisma.trigger.findMany).mock.calls[0][0] as any
    expect(call.where).toBeUndefined()
    expect(getAdminGroupIds).not.toHaveBeenCalled()
  })

  it('a scoped admin sees only their groups (plus the always-empty-in-practice global branch)', async () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    const handler = routes['GET /triggers'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getAdminGroupIds).mockResolvedValue(['a@g.us'])
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([])
    const req = { user: { id: 'u1', roles: [] } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    const call = vi.mocked(prisma.trigger.findMany).mock.calls[0][0] as any
    expect(call.where.OR).toEqual([{ groupId: null }, { groupId: { in: ['a@g.us'] } }])
  })
})
```

(Trigger has no `groupId: null` rows in practice since the column is `NOT NULL`, but the query shape stays identical to Events/Schedules for consistency and because it's harmless — a `groupId: null` branch that never matches any row is not a bug.)

- [ ] **Step 2: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/triggerRoutes.test.ts`

- [ ] **Step 3: Implement**

In `routes/triggers.ts`:
- Change the import: `import { requireAuth, requireGroupAdmin } from "../middleware/auth.js";` and add `import { getAdminGroupIds } from "../services/groupService.js";`.
- `GET /triggers`:

```ts
  app.get("/triggers", requireAuth, async (req, res) => {
    try {
      const userSlugs = req.user?.roles?.map((ur) => ur.role.slug) ?? [];
      const isSuperAdmin = userSlugs.includes("super_admin");
      const where = isSuperAdmin
        ? {}
        : { OR: [{ groupId: null }, { groupId: { in: await getAdminGroupIds(req.user!.id) } }] };
      const list = await prisma.trigger.findMany({ where, orderBy: { createdAt: "desc" } });
      res.json(list);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar triggers";
      res.status(500).json({ error: msg });
    }
  });
```

- `POST /triggers`: replace `requireAuth, requireRole("bom_dia_admin")` with `requireGroupAdmin((req) => ((req.body?.groupId as string) || "").trim() || null)`.
- `PUT /triggers/:id` and `DELETE /triggers/:id`: replace with `requireGroupAdmin(async (req) => { const existing = await prisma.trigger.findUnique({ where: { id: req.params.id } }); return existing?.groupId ?? null; })`.

Handler bodies for all four routes are otherwise unchanged.

- [ ] **Step 4: Run to verify it passes, then full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/triggerRoutes.test.ts && npx vitest run __tests__ && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/triggers.ts __tests__/triggerRoutes.test.ts
git commit -m "fix: scope Trigger routes to the trigger's own group instead of the global bom_dia_admin role"
```

---

### Task 7: Persona — per-group resolution and routes

**Files:**
- Modify: `como-ja-e-dia-backend/services/personaConfig.ts`
- Modify: `como-ja-e-dia-backend/routes/persona.ts`
- Modify: `como-ja-e-dia-backend/services/ai.ts` (two call sites of `getPersonaPrompt`)
- Test: `como-ja-e-dia-backend/__tests__/personaConfig.test.ts` (new)
- Test: `como-ja-e-dia-backend/__tests__/personaRoutes.test.ts` (new)

**Interfaces:**
- Produces: `getPersonaPrompt(groupId?: string): Promise<string>` — signature widens from `(force = false)`. Resolution order: `PersonaConfig` row for `groupId` → `PersonaConfig` row where `groupId IS NULL` → hardcoded `AI_PERSONA_DEFAULT`. Consumed by Task 5 (already written against this signature) and `services/ai.ts`'s two call sites.
- **Breaking, deliberate change to `getPersonaPrompt`'s cache:** the existing single-slot in-memory cache (`{prompt, loadedAt}`, one global value) cannot represent "one cached value per group." This task removes that cache — `getPersonaPrompt` becomes a plain `await prisma.personaConfig.findUnique(...)` on every call, no memoization. `getPersonaCache()` (exported for `GET /persona`'s response, used by the frontend to show "last computed value") is removed along with it — `GET /persona` calls `getPersonaPrompt(groupId)` directly and returns its result inline; there is no separate cache to expose. **Confirm no other caller of `getPersonaCache` exists before deleting it** (grep the codebase — `routes/persona.ts` is its only known consumer today).

- [ ] **Step 1: Write the failing tests for `personaConfig.ts`**

Create `__tests__/personaConfig.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: { personaConfig: { findUnique: vi.fn(), upsert: vi.fn() } },
}))
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: vi.fn().mockResolvedValue({ text: 'ok' }) },
  })),
}))
vi.mock('../services/logger.js', () => ({ log: vi.fn() }))

import { prisma } from '../services/db.js'
import { getPersonaPrompt, savePersonaPrompt } from '../services/personaConfig.js'
import { AI_PERSONA_DEFAULT, AI_PERSONA_GUARDS } from '../services/personaConstants.js'

beforeEach(() => vi.clearAllMocks())

describe('getPersonaPrompt', () => {
  it('uses the group-specific row when one exists', async () => {
    vi.mocked(prisma.personaConfig.findUnique).mockResolvedValueOnce({ prompt: 'grupo A tone' } as any)
    const result = await getPersonaPrompt('a@g.us')
    expect(prisma.personaConfig.findUnique).toHaveBeenCalledWith({ where: { groupId: 'a@g.us' } })
    expect(result).toBe(`${AI_PERSONA_GUARDS.trim()}\n\ngrupo A tone`)
  })

  it('falls back to the groupId=null row when the group has none of its own', async () => {
    vi.mocked(prisma.personaConfig.findUnique)
      .mockResolvedValueOnce(null) // group-specific lookup
      .mockResolvedValueOnce({ prompt: 'global fallback tone' } as any) // groupId: null lookup
    const result = await getPersonaPrompt('a@g.us')
    expect(prisma.personaConfig.findUnique).toHaveBeenNthCalledWith(1, { where: { groupId: 'a@g.us' } })
    expect(prisma.personaConfig.findUnique).toHaveBeenNthCalledWith(2, { where: { groupId: null } })
    expect(result).toBe(`${AI_PERSONA_GUARDS.trim()}\n\nglobal fallback tone`)
  })

  it('falls back to the hardcoded default when neither row exists', async () => {
    vi.mocked(prisma.personaConfig.findUnique).mockResolvedValue(null)
    const result = await getPersonaPrompt('a@g.us')
    expect(result).toBe(`${AI_PERSONA_GUARDS.trim()}\n\n${AI_PERSONA_DEFAULT.trim()}`)
  })

  it('with no groupId argument, goes straight to the groupId=null row', async () => {
    vi.mocked(prisma.personaConfig.findUnique).mockResolvedValueOnce({ prompt: 'global' } as any)
    await getPersonaPrompt()
    expect(prisma.personaConfig.findUnique).toHaveBeenCalledTimes(1)
    expect(prisma.personaConfig.findUnique).toHaveBeenCalledWith({ where: { groupId: null } })
  })
})

describe('savePersonaPrompt', () => {
  it('upserts keyed by groupId, not by the old fixed id:1', async () => {
    process.env.GEMINI_API_KEY = 'test'
    vi.mocked(prisma.personaConfig.upsert).mockResolvedValue({ prompt: 'new tone' } as any)
    await savePersonaPrompt('a@g.us', 'new tone')
    expect(prisma.personaConfig.upsert).toHaveBeenCalledWith({
      where: { groupId: 'a@g.us' },
      update: { prompt: 'new tone' },
      create: { groupId: 'a@g.us', prompt: 'new tone' },
    })
  })

  it('groupId=null upserts the global fallback row', async () => {
    process.env.GEMINI_API_KEY = 'test'
    vi.mocked(prisma.personaConfig.upsert).mockResolvedValue({ prompt: 'new global' } as any)
    await savePersonaPrompt(null, 'new global')
    expect(prisma.personaConfig.upsert).toHaveBeenCalledWith({
      where: { groupId: null },
      update: { prompt: 'new global' },
      create: { groupId: null, prompt: 'new global' },
    })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/personaConfig.test.ts`

- [ ] **Step 3: Rewrite `services/personaConfig.ts`**

Replace the file in full:

```ts
import { prisma } from "./db.js";
import { GoogleGenAI } from "@google/genai";
import { AI_PERSONA_DEFAULT, AI_PERSONA_GUARDS } from "./personaConstants.js";
import { log } from "./logger.js";

function buildPersonaPrompt(userPrompt?: string | null): string {
  const tone = (userPrompt || AI_PERSONA_DEFAULT).trim();
  return `${AI_PERSONA_GUARDS.trim()}\n\n${tone}`;
}

export async function getPersonaPrompt(groupId?: string | null): Promise<string> {
  if (groupId) {
    const own = await prisma.personaConfig.findUnique({ where: { groupId } });
    if (own) return buildPersonaPrompt(own.prompt);
  }
  const fallback = await prisma.personaConfig.findUnique({ where: { groupId: null } });
  return buildPersonaPrompt(fallback?.prompt);
}

async function validatePersonaPrompt(prompt: string): Promise<string> {
  const systemPrompt = buildPersonaPrompt(prompt);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY nao configurada para validar persona");
  }
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-preview";
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Gere uma frase de teste de bom dia sarcastica, curta, com ate 2 frases. Nao use labels ou listas.",
            },
          ],
        },
      ],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 100,
      },
    });
    const text = response.text?.trim();
    if (!text) throw new Error("Resposta vazia");
    return text;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Validação da persona falhou: ${msg}`, "warning");
    throw new Error(
      "A Gemini recusou ou retornou vazio com esse prompt. Ajuste o texto da persona."
    );
  }
}

export async function savePersonaPrompt(groupId: string | null, prompt: string): Promise<string> {
  await validatePersonaPrompt(prompt);
  const doc = await prisma.personaConfig.upsert({
    where: { groupId },
    update: { prompt },
    create: { groupId, prompt },
  });
  return buildPersonaPrompt(doc.prompt);
}
```

(`getPersonaCache` is deleted — confirmed its only consumer is `routes/persona.ts`, updated in Step 5 below.)

- [ ] **Step 4: Run to verify `personaConfig.test.ts` passes**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/personaConfig.test.ts`
Expected: PASS. (Full-suite verification happens after Step 6, once `routes/persona.ts` and `services/ai.ts` are updated to match the new signature — running the full suite now would show expected, not-yet-fixed type errors at those call sites; that's fine, don't stop to investigate them yet.)

- [ ] **Step 5: Update `services/ai.ts`'s two call sites**

In `services/ai.ts`, `generateAICaption` currently does `: await getPersonaPrompt();` when no `personaOverride` is given — this call site does NOT have a `groupId` in scope (it's a pure function taking only the fields the caller passes in). Leave `generateAICaption`'s own body as `await getPersonaPrompt()` unchanged — **this is correct**, since Task 5's rewrite of `processScheduleJob` never calls `generateAICaption` without resolving persona itself first (every call site in the new `processScheduleJob` code passes an explicit `personaOverride`, either the schedule's own override or the group-resolved one) — `generateAICaption`'s internal fallback is now unreachable from `processScheduleJob` but remains correct as a defensive default for any future caller that doesn't supply one.

`generateAIAnalysis` (used by `!analise`) currently does `const personaPrompt = await getPersonaPrompt();` unconditionally — this one DOES need a `groupId`, since `!analise` is issued from within a specific WhatsApp group. Check `generateAIAnalysis`'s current signature and where it's called from (`handlers/commands.ts`'s `handleAnaliseCommand(msg, cmd.n)`, which has `msg.from` — the group JID — in scope). Add a `groupId` parameter to `generateAIAnalysis` and thread `msg.from` through from `handleAnaliseCommand`:

```ts
// services/ai.ts — change the signature line (keep every other existing parameter in place, this only adds one):
export async function generateAIAnalysis(
  groupId: string | null,
  // ...the function's existing parameters, unchanged...
) {
  // ...
  const personaPrompt = await getPersonaPrompt(groupId);
  // ...rest unchanged
}
```

In `handlers/commands.ts`, `handleAnaliseCommand` calls `analysisFn(...)` (the injected `generateAIAnalysis`) — add `msg.from` as the new first argument at that call site, matching the new signature. Read the current call site's exact argument list before editing (it is not reproduced here since it wasn't captured verbatim during design — locate it with `grep -n "analysisFn(" handlers/commands.ts` and add the `msg.from ?? null` argument in the position matching `generateAIAnalysis`'s new first parameter).

- [ ] **Step 6: Update `routes/persona.ts`**

Replace the file in full:

```ts
import { Express } from "express";
import { requireAuth, requireGroupAdmin } from "../middleware/auth.js";
import { getPersonaPrompt, savePersonaPrompt } from "../services/personaConfig.js";
import { AI_PERSONA_DEFAULT } from "../services/personaConstants.js";
import { prisma } from "../services/db.js";

function resolveGroupIdParam(req: { query: Record<string, unknown> }): string | null {
  const raw = req.query.groupId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function registerPersonaRoutes(app: Express) {
  app.get(
    "/persona",
    requireGroupAdmin((req) => resolveGroupIdParam(req as any)),
    async (req, res) => {
      try {
        const groupId = resolveGroupIdParam(req);
        const doc = groupId ? await prisma.personaConfig.findUnique({ where: { groupId } }) : null;
        const prompt = doc?.prompt || (await getPersonaPrompt(groupId ?? undefined));
        res.json({ prompt, default: AI_PERSONA_DEFAULT.trim() });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro ao obter persona";
        res.status(500).json({ error: msg });
      }
    }
  );

  app.put(
    "/persona",
    requireGroupAdmin((req) => resolveGroupIdParam(req as any)),
    async (req, res) => {
      try {
        const prompt = (req.body?.prompt || "").toString();
        if (!prompt.trim()) {
          return res.status(400).json({ error: "Prompt não pode ser vazio" });
        }
        const groupId = resolveGroupIdParam(req);
        const saved = await savePersonaPrompt(groupId, prompt);
        res.json({ prompt: saved });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro ao salvar persona";
        res.status(400).json({ error: msg });
      }
    }
  );
}
```

Note `GET /persona` reads its intended `prompt` field slightly differently than a plain `getPersonaPrompt(groupId)` call would: it returns the **raw, unwrapped** `doc?.prompt` (or, if there's no row at all for that group, the fully-wrapped `getPersonaPrompt` result including the `AI_PERSONA_GUARDS` preamble) so the admin UI can show/edit the group's own custom text without the guard-rail boilerplate baked in — this matches today's existing behavior (`res.json({ prompt, ... })` in the pre-existing code also returns the raw `doc?.prompt || AI_PERSONA_DEFAULT.trim()`, not the guards-wrapped version) — do not accidentally return the guards-wrapped text as the editable `prompt` field.

`resolveGroupIdParam` reading from `req.query` (not `req.body`) applies to both `GET` and `PUT` — a query string groupId works for `GET` naturally; for `PUT`, the frontend sends it as `?groupId=...` in the URL alongside the JSON body (`{prompt}`), which Task 13 implements this way deliberately, to keep `requireGroupAdmin`'s resolver identical for both routes (reading `req.body` would work for `PUT` but not `GET`, which has no body).

- [ ] **Step 7: Write the failing route tests**

Create `__tests__/personaRoutes.test.ts` following the established wiring-test pattern: `GET`/`PUT /persona` both use `requireGroupAdmin`, not `requireRole`. Include one test per route confirming a `?groupId=` query string reaches `getPersonaPrompt`/`savePersonaPrompt` with that exact value, and one confirming an omitted `groupId` resolves to `null` (reachable only by `super_admin`, per `requireGroupAdmin`'s bypass).

- [ ] **Step 8: Run everything — full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__ && npx tsc --noEmit`
Expected: all PASS (the same pre-existing `anilistService.test.ts` failures, nothing new), no type errors. This is the point where Task 5's `getPersonaPrompt` usage inside `processScheduleJob` finally typechecks cleanly against this task's new signature — if Task 5 was executed before this task, its own step 8 would have shown a type error at that call site; confirm it's now resolved.

- [ ] **Step 9: Commit**

```bash
cd como-ja-e-dia-backend
git add services/personaConfig.ts services/ai.ts handlers/commands.ts routes/persona.ts __tests__/personaConfig.test.ts __tests__/personaRoutes.test.ts
git commit -m "feat: scope Persona to groups (per-group PersonaConfig row, groupId=null global fallback, requireGroupAdmin on routes)"
```

---

### Task 8: Retire the legacy global `bom_dia_admin` role

**Files:**
- Create: `como-ja-e-dia-backend/prisma/migrations/20260805100000_retire_global_bom_dia_admin/migration.sql`

**Interfaces:** none — data-only migration, no code change. This is the last task in this plan; do not run it until Tasks 2–7 are all merged (every route that used to depend on the global `bom_dia_admin` role must have migrated to `requireGroupAdmin` first, per the design's "no lockout window" rule).

- [ ] **Step 1: Write the migration**

Create `prisma/migrations/20260805100000_retire_global_bom_dia_admin/migration.sql`:

```sql
-- Remove global bom_dia_admin role assignments now that Events, Schedules,
-- Persona, and Triggers all check GroupAdmin membership per-resource instead
-- of this global role. The Role row itself is left in place (harmless,
-- unreferenced) in case the slug is ever reused. super_admin must manually
-- reassign each former bom_dia_admin to the specific group(s) they should
-- administer via POST /groups/:groupId/admins.
DELETE FROM "UserRole"
WHERE "roleId" IN (SELECT "id" FROM "Role" WHERE "slug" = 'bom_dia_admin');
```

Self-review by inspection: this only deletes `UserRole` join rows for the `bom_dia_admin` slug — it does not touch the `Role` row, any other role's assignments, or `super_admin`/`miru_cadastro` in any way.

- [ ] **Step 2: Commit**

```bash
cd como-ja-e-dia-backend
git add prisma/migrations/20260805100000_retire_global_bom_dia_admin
git commit -m "chore(db): remove legacy global bom_dia_admin role assignments"
```

---

### Task 9: Frontend — `GET /groups/mine` client + shared picker-eligibility helper

**Files:**
- Modify: `como-ja-e-dia-frontend/lib/apiClient.js`
- Create: `como-ja-e-dia-frontend/lib/groupPicker.js`

**Interfaces:**
- Produces: `api.getMyGroups(): Promise<Group[]>` (each `Group` has every flag field). `resolvePickerGroups(myGroups: Group[], isSuperAdmin: boolean, flagKey: string | null): Group[]` — filters `myGroups` by `flagKey` (if given; `null`/`undefined` means no flag filter, used by Persona) and returns the eligible list; the caller decides UI behavior from `eligible.length` (0/1/2+) per the design's rule. Consumed by Tasks 10–13.

- [ ] **Step 1: Add the API client method**

In `lib/apiClient.js`, add right after the existing `getGroups`/`createGroup`/etc. block:

```js
    getMyGroups: () =>
        fetch("/api/groups/mine", { ...withCreds, headers: handleHeaders() }).then(handleResponse),
```

Add the matching proxy route `pages/api/groups/mine.js`:

```js
import { proxyJson } from "../../../lib/backendApi";

export default async function handler(req, res) {
    if (req.method === "GET") {
        return proxyJson(req, res, { path: "/groups/mine", method: "GET" });
    }
    res.setHeader("Allow", ["GET"]);
    res.status(405).end("Method Not Allowed");
}
```

(Path depth check: `pages/api/groups/mine.js` sits at the same depth as `pages/api/groups/[id].js`, which uses `"../../../lib/backendApi"` — three `../`. Match that exactly.)

- [ ] **Step 2: Create the shared picker-eligibility helper**

Create `lib/groupPicker.js`:

```js
export function resolvePickerGroups(myGroups, isSuperAdmin, flagKey = null) {
    const filtered = flagKey ? myGroups.filter((g) => !!g[flagKey]) : myGroups;
    return {
        eligible: filtered,
        needsPicker: filtered.length > 1,
        singleGroupId: filtered.length === 1 ? filtered[0].id : null,
        canBroadcastGlobally: isSuperAdmin,
    };
}
```

- [ ] **Step 3: Verify with a production build**

Run: `cd como-ja-e-dia-frontend && npm run build`
Expected: build succeeds (this task adds no UI yet, just the data layer — Tasks 10–13 consume it).

- [ ] **Step 4: Commit**

```bash
cd como-ja-e-dia-frontend
git add lib/apiClient.js lib/groupPicker.js pages/api/groups/mine.js
git commit -m "feat: add getMyGroups API client method and shared group-picker eligibility helper"
```

---

### Task 10: Frontend — Events page group picker

**Files:**
- Modify: `como-ja-e-dia-frontend/pages/events.js`
- Modify: `como-ja-e-dia-frontend/lib/apiClient.js` (`createEvent` gains a `groupId` param)

**Interfaces:**
- Consumes: `api.getMyGroups`, `resolvePickerGroups` (Task 9).
- Produces: `api.createEvent({ name, date, groupId })` — signature widens (was `{name, date}`).

- [ ] **Step 1: Read the current file**

Read `pages/events.js` in full before editing — its exact current structure (state, the create form, the `fetcher`) wasn't reproduced verbatim during design and must be matched exactly rather than guessed at.

- [ ] **Step 2: Update the API client**

In `lib/apiClient.js`, change:

```js
    createEvent: ({ name, date }) =>
        fetch("/api/events", {
            method: "POST",
            headers: handleHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ name, date }),
            credentials: "include",
        }).then(handleResponse),
```

to:

```js
    createEvent: ({ name, date, groupId }) =>
        fetch("/api/events", {
            method: "POST",
            headers: handleHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ name, date, groupId }),
            credentials: "include",
        }).then(handleResponse),
```

- [ ] **Step 3: Add the picker to `pages/events.js`**

On mount (alongside whatever existing `useEffect` fetches events), also call `api.me()` (or reuse `useAuth()`'s `user` if this page already uses that hook — check) to determine `isSuperAdmin`, and `api.getMyGroups()` to get the group list. Compute `resolvePickerGroups(myGroups, isSuperAdmin, 'eventsEnabled')`. In the create-event form:
- If `needsPicker` is `false` and `eligible.length === 1`: no picker UI, submit with `groupId: singleGroupId`.
- If `needsPicker` is `false` and `eligible.length === 0`: disable the create form, show "Você não administra nenhum grupo com eventos habilitados."
- If `needsPicker` is `true`: render a `<Select>` (single-select is enough for Events — unlike Schedules/Triggers, an event is a single row, so "apply to N groups" would mean creating N separate events with the same name/date, one per group; support this as a multi-select where submitting issues one `api.createEvent` call per selected group, each independently — never a single call with an array). If `canBroadcastGlobally`, add a distinct "Todos os grupos (atual e futuros)" option in the `<Select>` that, when chosen, submits `groupId: null` in a single `createEvent` call instead of iterating per-group.

- [ ] **Step 4: Verify with a production build**

Run: `cd como-ja-e-dia-frontend && npm run build`

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-frontend
git add pages/events.js lib/apiClient.js
git commit -m "feat: add group picker to the Events admin page"
```

---

### Task 11: Frontend — Schedules page group picker

**Files:**
- Modify: `como-ja-e-dia-frontend/pages/schedules.js`
- Modify: `como-ja-e-dia-frontend/lib/apiClient.js` (`createSchedule`/`updateSchedule` payloads already pass through an object — confirm `groupId` flows through unchanged, since these methods already accept `(payload)`/`(id, payload)` generically; no signature change needed, only the frontend page needs to include `groupId` in the object it builds).

**Interfaces:**
- Consumes: `api.getMyGroups`, `resolvePickerGroups` (Task 9), same flag key `'scheduledGreetingsEnabled'`.

- [ ] **Step 1: Read the current file**

Read `pages/schedules.js` in full — it already calls `api.me()` in a `useEffect` (seen during design), so `isSuperAdmin` may already be derivable from existing state; check before adding a duplicate call.

- [ ] **Step 2: Add the picker**

Same pattern as Task 10, `flagKey = 'scheduledGreetingsEnabled'`. Unlike Events, "apply to N of my groups" for a Schedule is a meaningful, expected action (the same recurring greeting content going out to several groups) — support multi-select with "select all of mine," submitting one `api.createSchedule({...form, groupId})` call per selected group. `super_admin`'s distinct "broadcast to all groups" option submits a single call with `groupId: null`.

- [ ] **Step 3: Verify with a production build**

Run: `cd como-ja-e-dia-frontend && npm run build`

- [ ] **Step 4: Commit**

```bash
cd como-ja-e-dia-frontend
git add pages/schedules.js
git commit -m "feat: add group picker to the Schedules admin page"
```

---

### Task 12: Frontend — Triggers page group picker

**Files:**
- Modify: `como-ja-e-dia-frontend/pages/triggers.js`

**Interfaces:**
- Consumes: `api.getMyGroups`, `resolvePickerGroups` (Task 9), flag key `'triggersEnabled'`.

- [ ] **Step 1: Read the current file**

Read `pages/triggers.js` in full. Note: `Trigger` already has a required `groupId` today, so this page **already has some kind of group-selection UI** (the field is mandatory in `parseTriggerPayload`/`validateTriggerPayload` on the backend) — find out what it currently is (likely a raw text input for the group JID, since sub-project 1's `GroupPicker` component is `super_admin`-only and this page is `bom_dia_admin`-accessible today). This task's job is to **replace whatever that current input is** with the `resolvePickerGroups`-driven picker, not add a second one.

- [ ] **Step 2: Replace the group-selection UI**

Same pattern as Task 10/11. No "broadcast globally" option here — Trigger has no `groupId: null` concept (the column is `NOT NULL`), so even `super_admin` must pick one or more specific existing groups; there is no "all future groups too" action for Triggers. Multi-select ("apply to N of my groups") issues one `api.createTrigger({...form, groupId})` call per selected group, each independently authorized — same as Schedules.

- [ ] **Step 3: Verify with a production build**

Run: `cd como-ja-e-dia-frontend && npm run build`

- [ ] **Step 4: Commit**

```bash
cd como-ja-e-dia-frontend
git add pages/triggers.js
git commit -m "feat: replace the raw groupId input on the Triggers admin page with the group picker"
```

---

### Task 13: Frontend — Persona page group switcher

**Files:**
- Modify: `como-ja-e-dia-frontend/pages/persona.js`
- Modify: `como-ja-e-dia-frontend/lib/apiClient.js` (`getPersona`/`updatePersona` gain a `groupId` param)

**Interfaces:**
- Consumes: `api.getMyGroups`, `resolvePickerGroups` (Task 9), no flag filter (`flagKey = null`).
- Produces: `api.getPersona(groupId)` → `GET /api/persona?groupId=...`; `api.updatePersona(groupId, prompt)` → `PUT /api/persona?groupId=...` with `{prompt}` body.

- [ ] **Step 1: Read the current file**

Read `pages/persona.js` in full.

- [ ] **Step 2: Update the API client**

In `lib/apiClient.js`, change:

```js
    getPersona: () =>
        fetch("/api/persona", { ...withCreds, headers: handleHeaders() }).then(handleResponse),
    updatePersona: (prompt) =>
        fetch("/api/persona", {
            method: "PUT",
            credentials: "include",
            headers: handleHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ prompt }),
        }).then(handleResponse),
```

to:

```js
    getPersona: (groupId) =>
        fetch(`/api/persona${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ""}`, {
            ...withCreds,
            headers: handleHeaders(),
        }).then(handleResponse),
    updatePersona: (groupId, prompt) =>
        fetch(`/api/persona${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ""}`, {
            method: "PUT",
            credentials: "include",
            headers: handleHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ prompt }),
        }).then(handleResponse),
```

Check `pages/api/persona.js` (the Next.js proxy route) forwards `req.query`/the query string through to the backend — since `proxyJson` builds the upstream URL from a fixed `path` string, confirm whether the existing proxy route needs `?groupId=` appended from `req.query.groupId` (likely yes — read `pages/api/persona.js` and adjust it to include the query string in the forwarded `path` if it doesn't already forward one).

- [ ] **Step 3: Add the group switcher**

Unlike Events/Schedules/Triggers, this isn't a "which group(s) does this new item apply to" picker — it's "which group's persona am I currently viewing/editing," a single-select switcher (not multi-select, no "apply to all" bulk action, since there's exactly one `PersonaConfig` row per group to view at a time). Use `resolvePickerGroups(myGroups, isSuperAdmin, null)` (no flag filter — every group implicitly supports a persona). If `eligible.length === 0`, nothing to show. If `1`, no switcher, just load that group's persona. If `2+`, render a `<Select>` that, on change, re-fetches `api.getPersona(selectedGroupId)`. `super_admin` additionally sees an entry for "Padrão global (fallback)" in the switcher, which calls `api.getPersona(null)`/`api.updatePersona(null, prompt)` (the `groupId: null` row).

- [ ] **Step 4: Verify with a production build**

Run: `cd como-ja-e-dia-frontend && npm run build`

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-frontend
git add pages/persona.js lib/apiClient.js pages/api/persona.js
git commit -m "feat: add per-group switcher to the Persona admin page"
```

---

## Task Order & Independence

Strict order within the backend: **1 → 2 → 3**, all independent of each other except sharing Task 1's schema. **Task 4 (Events)** depends on 1. **Task 7 (Persona)** depends on 1, and **must run before Task 5 (Schedules)** — Task 5's `processScheduleJob` rewrite calls `getPersonaPrompt(groupId)` against Task 7's new signature. **Task 6 (Triggers)** depends only on the existing schema (no schema change of its own) and can run any time after Task 2. **Task 8** must be last of the backend tasks — it deletes data every other backend task's routes depend on being absent-of-lockout for. Frontend **Task 9** depends on backend Task 3. **Tasks 10–13** each depend on Task 9 and their respective backend task (10↔4, 11↔5, 12↔6, 13↔7) for the API shape they call, and are otherwise independent of each other.

Suggested sequential order: 1, 2, 3, 4, 7, 5, 6, 9, 10, 11, 12, 13, 8 (Task 8 pushed to the very end, after every consumer — backend and frontend — is confirmed working).
