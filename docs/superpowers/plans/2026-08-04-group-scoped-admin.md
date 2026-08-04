# Group-scoped Admin (sub-project 1 of 4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the infrastructure for scoping `bom_dia_admin` access to specific WhatsApp groups (a `GroupAdmin` join table, a `requireGroupAdmin` middleware, and a `super_admin`-only UI to assign/revoke admins per group) without changing any existing route's authorization.

**Architecture:** New `GroupAdmin` table (userId, groupId), independent of the existing global `Role`/`UserRole` system so `super_admin` and `miru_cadastro` are untouched. New `requireGroupAdmin(getGroupId)` middleware mirrors the existing `requireRole`/`requireWorkerOrRole` shape in `middleware/auth.ts`. No existing route wires it up yet — that happens in sub-project 2.

**Tech Stack:** TypeScript, Express, Prisma 7 (adapter-pg), PostgreSQL, Vitest, Next.js (pages router), MUI.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-08-04-group-scoped-admin-design.md` — every task below implements one part of it.
- Backend tests run with `npm test` (vitest) from `como-ja-e-dia-backend/`. Frontend has no test runner; frontend tasks are verified with `npm run build` and manual reasoning.
- Follow existing patterns: Express route registration functions (`register*Routes(app)`), Prisma via the shared `prisma` client in `services/db.ts`, vitest with `vi.mock()` module mocks (see `__tests__/requireRole.test.ts`, `__tests__/mediaRoutes.test.ts`, `__tests__/groupService.test.ts`).
- **Do not** modify `routes/events.ts`, `routes/schedules.ts`, `routes/persona.ts`, or `routes/triggers.ts` — switching them to `requireGroupAdmin` is sub-project 2, out of scope here.
- **Do not** remove or alter existing `Role`/`UserRole` rows or the `requireRole`/`requireWorkerOrRole` functions — this sub-project is purely additive.
- Migrations in this repo are committed as SQL files under `prisma/migrations/` (see `prisma/migrations/20260730164008_add_group_table/migration.sql` for the exact style to match) but applied automatically via `prisma db push` in `entrypoint.sh` on deploy — you do not need a live database to complete this plan, only `npx prisma generate` (reads `schema.prisma` only).

---

### Task 1: `GroupAdmin` table

**Files:**
- Modify: `como-ja-e-dia-backend/prisma/schema.prisma`
- Create: `como-ja-e-dia-backend/prisma/migrations/20260804120000_add_group_admin/migration.sql`

**Interfaces:**
- Produces: Prisma model `GroupAdmin { id, userId, groupId, createdAt, user, group }` with `@@unique([userId, groupId])`, available on the generated client as `prisma.groupAdmin.*` for later tasks.

- [ ] **Step 1: Add the model to schema.prisma**

In `como-ja-e-dia-backend/prisma/schema.prisma`, add reverse relations to the existing `User` and `Group` models. Find:

```prisma
model User {
  id           String     @id @default(cuid())
  email        String     @unique
  name         String     @default("")
  passwordHash String
  active       Boolean    @default(false)
  createdAt    DateTime   @default(now())
  roles        UserRole[]
}
```

Change the last line to add a new relation field:

```prisma
model User {
  id           String       @id @default(cuid())
  email        String       @unique
  name         String       @default("")
  passwordHash String
  active       Boolean      @default(false)
  createdAt    DateTime     @default(now())
  roles        UserRole[]
  groupAdmins  GroupAdmin[]
}
```

Find the `Group` model:

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

Add a reverse relation field:

```prisma
model Group {
  id                        String       @id
  name                      String
  pokemonEnabled            Boolean      @default(false)
  confessionsEnabled        Boolean      @default(false)
  scheduledGreetingsEnabled Boolean      @default(false)
  triggersEnabled           Boolean      @default(false)
  contextSyncEnabled        Boolean      @default(false)
  createdAt                 DateTime     @default(now())
  updatedAt                 DateTime     @updatedAt
  admins                    GroupAdmin[]
}
```

Add the new model anywhere else in the file (e.g. right after the `Group` model):

```prisma
model GroupAdmin {
  id        String   @id @default(cuid())
  userId    String
  groupId   String
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  group     Group    @relation(fields: [groupId], references: [id], onDelete: Cascade)

  @@unique([userId, groupId])
}
```

- [ ] **Step 2: Write the migration SQL**

Create `como-ja-e-dia-backend/prisma/migrations/20260804120000_add_group_admin/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "GroupAdmin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupAdmin_userId_groupId_key" ON "GroupAdmin"("userId", "groupId");

-- AddForeignKey
ALTER TABLE "GroupAdmin" ADD CONSTRAINT "GroupAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupAdmin" ADD CONSTRAINT "GroupAdmin_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 2b: Self-review the SQL (no live database available to test against)**

There is no database in this environment to run the migration against, so verify it by inspection instead of execution:
- Table/column names match the `GroupAdmin` model in `schema.prisma` exactly (`GroupAdmin`, `userId`, `groupId`, `createdAt`).
- The unique index covers `("userId", "groupId")` in that order, matching `@@unique([userId, groupId])` — this order determines the compound-key name (`userId_groupId`) that Task 4's `prisma.groupAdmin.delete({ where: { userId_groupId: ... } })` call relies on.
- Both foreign keys use `ON DELETE CASCADE`, matching the design's cascade requirement.
- Naming (`GroupAdmin_pkey`, `GroupAdmin_userId_groupId_key`, `GroupAdmin_userId_fkey`, `GroupAdmin_groupId_fkey`) follows the same convention as the existing `prisma/migrations/20260730164008_add_group_table/migration.sql`.

Applying this migration for real happens automatically in every environment via `prisma db push` in `entrypoint.sh` (dev and prod alike) — not part of this plan.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd como-ja-e-dia-backend && npx prisma generate`
Expected: `✔ Generated Prisma Client` — no errors. This makes `prisma.groupAdmin.*` available to TypeScript without needing a live database.

- [ ] **Step 4: Typecheck and run the existing suite to confirm nothing broke**

Run: `cd como-ja-e-dia-backend && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all existing tests still pass (this task adds no new behavior yet).

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add prisma/schema.prisma prisma/migrations/20260804120000_add_group_admin
git commit -m "feat(db): add GroupAdmin table for per-group admin scoping"
```

---

### Task 2: `groupService.ts` — `isGroupAdminOf` / `getAdminGroupIds`

**Files:**
- Modify: `como-ja-e-dia-backend/services/groupService.ts`
- Modify: `como-ja-e-dia-backend/__tests__/groupService.test.ts`

**Interfaces:**
- Consumes: `prisma.groupAdmin.count`, `prisma.groupAdmin.findMany` (from Task 1).
- Produces: `isGroupAdminOf(userId: string, groupId: string): Promise<boolean>` (cached 60s, same pattern as `isPokemonEnabled`), `getAdminGroupIds(userId: string): Promise<string[]>` (uncached, same pattern as `getPokemonEnabledGroupIds`). Both consumed by Task 3 and Task 5.

- [ ] **Step 1: Write the failing tests**

In `como-ja-e-dia-backend/__tests__/groupService.test.ts`, change the top mock to add `groupAdmin`:

```ts
vi.mock('../services/db.js', () => ({
  prisma: {
    group: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    groupAdmin: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))
```

Add `isGroupAdminOf` and `getAdminGroupIds` to the import list:

```ts
import {
  isGroupRegistered,
  isPokemonEnabled,
  isTriggersEnabledForGroup,
  getPokemonEnabledGroupIds,
  isContextSyncEnabled,
  resetGroupCache,
  ensureGroupSeeded,
  isGroupAdminOf,
  getAdminGroupIds,
} from '../services/groupService.js'
```

Add these tests at the end of the `describe('groupService', ...)` block, before the closing `})`:

```ts
  it('isGroupAdminOf returns true when a GroupAdmin row exists', async () => {
    vi.mocked(prisma.groupAdmin.count).mockResolvedValue(1)
    expect(await isGroupAdminOf('u1', 'g1@g.us')).toBe(true)
  })

  it('isGroupAdminOf returns false and caches the miss for 60s', async () => {
    vi.mocked(prisma.groupAdmin.count).mockResolvedValue(0)
    expect(await isGroupAdminOf('u1', 'g1@g.us')).toBe(false)
    expect(await isGroupAdminOf('u1', 'g1@g.us')).toBe(false)
    expect(prisma.groupAdmin.count).toHaveBeenCalledTimes(1)
  })

  it('getAdminGroupIds maps rows to groupIds', async () => {
    vi.mocked(prisma.groupAdmin.findMany).mockResolvedValue([
      { groupId: 'a@g.us' },
      { groupId: 'b@g.us' },
    ] as any)
    expect(await getAdminGroupIds('u1')).toEqual(['a@g.us', 'b@g.us'])
    expect(prisma.groupAdmin.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { groupId: true },
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/groupService.test.ts`
Expected: FAIL — `isGroupAdminOf` and `getAdminGroupIds` are not exported yet.

- [ ] **Step 3: Implement the functions**

In `como-ja-e-dia-backend/services/groupService.ts`, add a second cache map near the existing `cache` declaration (same `let` style as `cache`, since both get reassigned by `resetGroupCache`):

```ts
let adminCache = new Map<string, { isAdmin: boolean; fetchedAt: number }>()
```

Update `resetGroupCache` to clear both maps:

```ts
export function resetGroupCache(): void {
  cache = new Map()
  adminCache = new Map()
}
```

Add the two new functions anywhere after `fetchGroup` (e.g. right after `isContextSyncEnabled`):

```ts
export async function isGroupAdminOf(userId: string, groupId: string): Promise<boolean> {
  const key = `${userId}:${groupId}`
  const cached = adminCache.get(key)
  const now = Date.now()
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.isAdmin
  const count = await prisma.groupAdmin.count({ where: { userId, groupId } })
  const isAdmin = count > 0
  adminCache.set(key, { isAdmin, fetchedAt: now })
  return isAdmin
}

export async function getAdminGroupIds(userId: string): Promise<string[]> {
  const rows = await prisma.groupAdmin.findMany({ where: { userId }, select: { groupId: true } })
  return rows.map((r) => r.groupId)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/groupService.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add services/groupService.ts __tests__/groupService.test.ts
git commit -m "feat: add isGroupAdminOf and getAdminGroupIds to groupService"
```

---

### Task 3: `requireGroupAdmin` middleware

**Files:**
- Modify: `como-ja-e-dia-backend/middleware/auth.ts`
- Test: `como-ja-e-dia-backend/__tests__/requireGroupAdmin.test.ts` (new)

**Interfaces:**
- Consumes: `isGroupAdminOf` (Task 2), `requireAuth` (existing, unchanged).
- Produces: `requireGroupAdmin(getGroupId: (req: Request) => string | null | Promise<string | null>): RequestHandler` — exported from `middleware/auth.ts`. Not wired into any route yet (that's sub-project 2); this task only needs to work when called directly.

- [ ] **Step 1: Write the failing test**

Create `como-ja-e-dia-backend/__tests__/requireGroupAdmin.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

vi.mock('../services/db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}))

vi.mock('../services/authService.js', () => ({
  verifyToken: vi.fn(),
  getUserById: vi.fn(),
}))

vi.mock('../services/groupService.js', () => ({
  isGroupAdminOf: vi.fn(),
}))

import { verifyToken, getUserById } from '../services/authService.js'
import { isGroupAdminOf } from '../services/groupService.js'
import { requireGroupAdmin } from '../middleware/auth.js'

function makeReqRes(token?: string) {
  const req = {
    headers: { authorization: token ? `Bearer ${token}` : '' },
  } as unknown as Request
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response
  const next: NextFunction = vi.fn()
  return { req, res, next }
}

const mockRole = { id: 'role-1', name: 'Bom Dia Admin', slug: 'bom_dia_admin', createdAt: new Date() }
const mockUser = {
  id: 'u1', email: 'a@b.com', name: '', passwordHash: '', active: true, createdAt: new Date(),
  roles: [{ id: 'ur-1', userId: 'u1', roleId: 'role-1', role: mockRole }],
}
const superAdminUser = {
  ...mockUser,
  roles: [{ id: 'ur-2', userId: 'u1', roleId: 'role-2', role: { ...mockRole, id: 'role-2', slug: 'super_admin' } }],
}

beforeEach(() => vi.clearAllMocks())

describe('requireGroupAdmin', () => {
  it('returns 401 when not authenticated', async () => {
    const { req, res, next } = makeReqRes()
    await requireGroupAdmin(() => 'g1@g.us')(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('super_admin bypasses without checking isGroupAdminOf', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(superAdminUser as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => 'g1@g.us')(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(isGroupAdminOf).not.toHaveBeenCalled()
  })

  it('returns 400 when getGroupId resolves to null', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => null)(req, res, next)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(next).not.toHaveBeenCalled()
  })

  it('calls next() when the user administers the resolved group', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    vi.mocked(isGroupAdminOf).mockResolvedValue(true)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => 'g1@g.us')(req, res, next)
    expect(isGroupAdminOf).toHaveBeenCalledWith('u1', 'g1@g.us')
    expect(next).toHaveBeenCalled()
  })

  it('returns 403 when the user does not administer the resolved group', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    vi.mocked(isGroupAdminOf).mockResolvedValue(false)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(() => 'g1@g.us')(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('awaits an async getGroupId function', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    vi.mocked(isGroupAdminOf).mockResolvedValue(true)
    const { req, res, next } = makeReqRes('valid-token')
    await requireGroupAdmin(async () => 'g1@g.us')(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/requireGroupAdmin.test.ts`
Expected: FAIL — `requireGroupAdmin` is not exported from `middleware/auth.ts` yet.

- [ ] **Step 3: Implement the middleware**

In `como-ja-e-dia-backend/middleware/auth.ts`, add the import:

```ts
import { isGroupAdminOf } from "../services/groupService.js";
```

Add the new export at the end of the file, after `requireWorkerOrRole`:

```ts
export function requireGroupAdmin(
  getGroupId: (req: Request) => string | null | Promise<string | null>
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await requireAuth(req, res, async () => {
      const user = req.user!;
      const userSlugs = user.roles?.map((ur) => ur.role.slug) ?? [];
      if (userSlugs.includes("super_admin")) {
        next();
        return;
      }
      const groupId = await getGroupId(req);
      if (!groupId) {
        res.status(400).json({ error: "groupId é obrigatório" });
        return;
      }
      const isAdmin = await isGroupAdminOf(user.id, groupId);
      if (!isAdmin) {
        res.status(403).json({ error: "Sem permissão neste grupo" });
        return;
      }
      next();
    });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/requireGroupAdmin.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Run the full backend test suite and typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
cd como-ja-e-dia-backend
git add middleware/auth.ts __tests__/requireGroupAdmin.test.ts
git commit -m "feat: add requireGroupAdmin middleware"
```

---

### Task 4: `/groups/:groupId/admins` endpoints

**Files:**
- Modify: `como-ja-e-dia-backend/routes/groups.ts`
- Test: `como-ja-e-dia-backend/__tests__/groupAdminRoutes.test.ts` (new)

**Interfaces:**
- Consumes: `prisma.groupAdmin.findMany/create/delete`, `prisma.user.findUnique` (existing/Task 1), `resetGroupCache` (existing, already imported in this file).
- Produces: `GET /groups/:groupId/admins` → `Array<{ userId, email, name, createdAt }>`; `POST /groups/:groupId/admins` body `{ email }` → `201 { userId, email, name, createdAt }`; `DELETE /groups/:groupId/admins/:userId` → `{ success: true }`. All three `requireAuth, requireRole("super_admin")`. Consumed by Task 6 (frontend proxy routes).

- [ ] **Step 1: Write the failing tests**

Create `como-ja-e-dia-backend/__tests__/groupAdminRoutes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
  requireWorkerOrRole: vi.fn(() => vi.fn((req, res, next) => next())),
}))

vi.mock('../services/db.js', () => ({
  prisma: {
    group: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    groupAdmin: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}))

vi.mock('../services/redis.js', () => ({ getRedis: vi.fn() }))
vi.mock('../services/groupDiscoveryQueue.js', () => ({ enqueueGroupDiscoveryJob: vi.fn() }))
vi.mock('../services/groupService.js', () => ({ resetGroupCache: vi.fn() }))

import { requireAuth } from '../middleware/auth.js'
import { prisma } from '../services/db.js'
import { resetGroupCache } from '../services/groupService.js'
import { registerGroupRoutes } from '../routes/groups.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
    patch: (path: string, ...h: unknown[]) => { routes[`PATCH ${path}`] = h },
    delete: (path: string, ...h: unknown[]) => { routes[`DELETE ${path}`] = h },
  }
  return { app: app as any, routes }
}

function makeReqRes(body: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  const req = { body, params, query: {} } as any
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any
  return { req, res }
}

beforeEach(() => vi.clearAllMocks())

describe('group admin routes wiring', () => {
  it('all three admin routes require auth', () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    expect(routes['GET /groups/:groupId/admins']).toContain(requireAuth)
    expect(routes['POST /groups/:groupId/admins']).toContain(requireAuth)
    expect(routes['DELETE /groups/:groupId/admins/:userId']).toContain(requireAuth)
  })
})

describe('GET /groups/:groupId/admins', () => {
  it('lists admins with user info', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['GET /groups/:groupId/admins'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.groupAdmin.findMany).mockResolvedValue([
      { userId: 'u1', groupId: 'g1', createdAt: new Date('2026-01-01'), user: { id: 'u1', email: 'a@b.com', name: 'A' } },
    ] as any)
    const { req, res } = makeReqRes({}, { groupId: 'g1' })
    await handler(req, res)
    expect(prisma.groupAdmin.findMany).toHaveBeenCalledWith({
      where: { groupId: 'g1' },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    })
    expect(res.json).toHaveBeenCalledWith([
      { userId: 'u1', email: 'a@b.com', name: 'A', createdAt: new Date('2026-01-01') },
    ])
  })
})

describe('POST /groups/:groupId/admins', () => {
  it('adds the user found by email as a group admin', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['POST /groups/:groupId/admins'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A' } as any)
    vi.mocked(prisma.groupAdmin.create).mockResolvedValue({ createdAt: new Date('2026-01-01') } as any)
    const { req, res } = makeReqRes({ email: 'A@B.com' }, { groupId: 'g1' })
    await handler(req, res)
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'a@b.com' } })
    expect(prisma.groupAdmin.create).toHaveBeenCalledWith({ data: { userId: 'u1', groupId: 'g1' } })
    expect(resetGroupCache).toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
  })

  it('returns 404 when no user matches the email', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['POST /groups/:groupId/admins'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const { req, res } = makeReqRes({ email: 'nobody@b.com' }, { groupId: 'g1' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(404)
  })

  it('returns 409 when the user is already an admin of that group', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['POST /groups/:groupId/admins'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A' } as any)
    vi.mocked(prisma.groupAdmin.create).mockRejectedValue({ code: 'P2002' })
    const { req, res } = makeReqRes({ email: 'a@b.com' }, { groupId: 'g1' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(409)
  })
})

describe('DELETE /groups/:groupId/admins/:userId', () => {
  it('removes the admin', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['DELETE /groups/:groupId/admins/:userId'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.groupAdmin.delete).mockResolvedValue({} as any)
    const { req, res } = makeReqRes({}, { groupId: 'g1', userId: 'u1' })
    await handler(req, res)
    expect(prisma.groupAdmin.delete).toHaveBeenCalledWith({ where: { userId_groupId: { userId: 'u1', groupId: 'g1' } } })
    expect(resetGroupCache).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true })
  })

  it('returns 404 when the admin does not exist', async () => {
    const { app, routes } = makeApp()
    registerGroupRoutes(app)
    const handler = routes['DELETE /groups/:groupId/admins/:userId'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.groupAdmin.delete).mockRejectedValue({ code: 'P2025' })
    const { req, res } = makeReqRes({}, { groupId: 'g1', userId: 'u1' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/groupAdminRoutes.test.ts`
Expected: FAIL — none of the three routes are registered yet.

- [ ] **Step 3: Implement the routes**

In `como-ja-e-dia-backend/routes/groups.ts`, add these three route handlers inside `registerGroupRoutes`, right before the closing `}` of the function (after the existing `/groups/discover/ingest` handler):

```ts
  app.get("/groups/:groupId/admins", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const admins = await prisma.groupAdmin.findMany({
        where: { groupId: req.params.groupId },
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: "asc" },
      });
      res.json(
        admins.map((a) => ({
          userId: a.user.id,
          email: a.user.email,
          name: a.user.name,
          createdAt: a.createdAt,
        }))
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar admins do grupo";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/groups/:groupId/admins", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const email = ((req.body?.email || "") as string).trim().toLowerCase();
      if (!email) return res.status(400).json({ error: "email é obrigatório" });
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
      const created = await prisma.groupAdmin.create({
        data: { userId: user.id, groupId: req.params.groupId },
      });
      resetGroupCache();
      res.status(201).json({
        userId: user.id,
        email: user.email,
        name: user.name,
        createdAt: created.createdAt,
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2002") {
        return res.status(409).json({ error: "Usuário já é admin deste grupo" });
      }
      if ((err as { code?: string }).code === "P2003") {
        return res.status(404).json({ error: "Grupo não encontrado" });
      }
      const msg = err instanceof Error ? err.message : "Erro ao adicionar admin";
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/groups/:groupId/admins/:userId", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      await prisma.groupAdmin.delete({
        where: { userId_groupId: { userId: req.params.userId, groupId: req.params.groupId } },
      });
      resetGroupCache();
      res.json({ success: true });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2025") {
        return res.status(404).json({ error: "Admin não encontrado neste grupo" });
      }
      const msg = err instanceof Error ? err.message : "Erro ao remover admin";
      res.status(500).json({ error: msg });
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/groupAdminRoutes.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Run the full backend test suite and typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/groups.ts __tests__/groupAdminRoutes.test.ts
git commit -m "feat: add super_admin-only /groups/:groupId/admins endpoints"
```

---

### Task 5: `GET /auth/me` returns `adminGroupIds`

**Files:**
- Modify: `como-ja-e-dia-backend/routes/auth.ts`
- Test: `como-ja-e-dia-backend/__tests__/authMe.test.ts` (new)

**Interfaces:**
- Consumes: `getAdminGroupIds` (Task 2).
- Produces: `GET /auth/me` response shape becomes `{ user: {...}, adminGroupIds: string[] }` (was `{ user: {...} }`). Consumed by the frontend in a later sub-project — no frontend change needed in this task.

- [ ] **Step 1: Write the failing test**

Create `como-ja-e-dia-backend/__tests__/authMe.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/authService.js', () => ({
  registerUser: vi.fn(),
  authenticateUser: vi.fn(),
  getUserById: vi.fn(),
  listUsers: vi.fn(),
  setUserActive: vi.fn(),
  assignRole: vi.fn(),
  removeRole: vi.fn(),
  listRoles: vi.fn(),
  verifyToken: vi.fn(),
}))

vi.mock('../services/groupService.js', () => ({
  getAdminGroupIds: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireRole: vi.fn(() => vi.fn((req, res, next) => next())),
}))

import { verifyToken, getUserById } from '../services/authService.js'
import { getAdminGroupIds } from '../services/groupService.js'
import { registerAuthRoutes } from '../routes/auth.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
    patch: (path: string, ...h: unknown[]) => { routes[`PATCH ${path}`] = h },
    delete: (path: string, ...h: unknown[]) => { routes[`DELETE ${path}`] = h },
  }
  return { app: app as any, routes }
}

beforeEach(() => vi.clearAllMocks())

describe('GET /auth/me', () => {
  it('includes adminGroupIds alongside the serialized user', async () => {
    const { app, routes } = makeApp()
    registerAuthRoutes(app)
    const handler = routes['GET /auth/me'].at(-1) as (req: any, res: any) => Promise<void>

    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue({
      id: 'u1', email: 'a@b.com', name: 'A', active: true, createdAt: new Date('2026-01-01'), roles: [],
    } as any)
    vi.mocked(getAdminGroupIds).mockResolvedValue(['g1@g.us', 'g2@g.us'])

    const req = { headers: { authorization: 'Bearer valid-token' } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)

    expect(getAdminGroupIds).toHaveBeenCalledWith('u1')
    expect(res.json).toHaveBeenCalledWith({
      user: { id: 'u1', email: 'a@b.com', name: 'A', active: true, createdAt: new Date('2026-01-01'), roles: [] },
      adminGroupIds: ['g1@g.us', 'g2@g.us'],
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/authMe.test.ts`
Expected: FAIL — response currently has no `adminGroupIds` key.

- [ ] **Step 3: Implement**

In `como-ja-e-dia-backend/routes/auth.ts`, add the import:

```ts
import { getAdminGroupIds } from "../services/groupService.js";
```

Change the `/auth/me` handler from:

```ts
  app.get("/auth/me", async (req, res) => {
    try {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Token ausente" });
      const payload = verifyToken(token);
      const user = await getUserById(payload.sub as string);
      if (!user) return res.status(401).json({ error: "Usuário não encontrado" });
      res.json({ user: serializeUser(user) });
    } catch {
      res.status(401).json({ error: "Token inválido" });
    }
  });
```

to:

```ts
  app.get("/auth/me", async (req, res) => {
    try {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Token ausente" });
      const payload = verifyToken(token);
      const user = await getUserById(payload.sub as string);
      if (!user) return res.status(401).json({ error: "Usuário não encontrado" });
      const adminGroupIds = await getAdminGroupIds(user.id);
      res.json({ user: serializeUser(user), adminGroupIds });
    } catch {
      res.status(401).json({ error: "Token inválido" });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/authMe.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend test suite and typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/auth.ts __tests__/authMe.test.ts
git commit -m "feat: include adminGroupIds in GET /auth/me"
```

---

### Task 6: Frontend API client + proxy routes

**Files:**
- Modify: `como-ja-e-dia-frontend/lib/apiClient.js`
- Create: `como-ja-e-dia-frontend/pages/api/groups/[id]/admins/index.js`
- Create: `como-ja-e-dia-frontend/pages/api/groups/[id]/admins/[userId].js`

**Interfaces:**
- Consumes: backend `/groups/:groupId/admins` endpoints (Task 4).
- Produces: `api.getGroupAdmins(groupId)`, `api.addGroupAdmin(groupId, email)`, `api.removeGroupAdmin(groupId, userId)` on the `api` object exported from `lib/apiClient.js`. Consumed by Task 7.

- [ ] **Step 1: Add the proxy routes**

Create `como-ja-e-dia-frontend/pages/api/groups/[id]/admins/index.js`:

```js
import { proxyJson } from "../../../../../lib/backendApi";

export default async function handler(req, res) {
    const { id } = req.query;
    if (req.method === "GET") {
        return proxyJson(req, res, { path: `/groups/${id}/admins`, method: "GET" });
    }
    if (req.method === "POST") {
        return proxyJson(req, res, { path: `/groups/${id}/admins`, method: "POST" });
    }
    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).end("Method Not Allowed");
}
```

Create `como-ja-e-dia-frontend/pages/api/groups/[id]/admins/[userId].js`:

```js
import { proxyJson } from "../../../../../lib/backendApi";

export default async function handler(req, res) {
    const { id, userId } = req.query;
    if (req.method === "DELETE") {
        return proxyJson(req, res, { path: `/groups/${id}/admins/${userId}`, method: "DELETE" });
    }
    res.setHeader("Allow", ["DELETE"]);
    res.status(405).end("Method Not Allowed");
}
```

- [ ] **Step 2: Add the API client methods**

In `como-ja-e-dia-frontend/lib/apiClient.js`, add these methods right after `syncGroupDiscovery` (still inside the exported `api` object):

```js
    getGroupAdmins: (groupId) =>
        fetch(`/api/groups/${encodeURIComponent(groupId)}/admins`, { ...withCreds, headers: handleHeaders() }).then(handleResponse),
    addGroupAdmin: (groupId, email) =>
        fetch(`/api/groups/${encodeURIComponent(groupId)}/admins`, {
            method: "POST",
            headers: handleHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ email }),
            credentials: "include",
        }).then(handleResponse),
    removeGroupAdmin: (groupId, userId) =>
        fetch(`/api/groups/${encodeURIComponent(groupId)}/admins/${encodeURIComponent(userId)}`, {
            method: "DELETE",
            credentials: "include",
            headers: handleHeaders(),
        }).then(handleResponse),
```

- [ ] **Step 3: Verify with a production build**

Run: `cd como-ja-e-dia-frontend && npm run build`
Expected: build succeeds, no type/lint errors, and the two new routes appear in the route summary as `ƒ /api/groups/[id]/admins` and `ƒ /api/groups/[id]/admins/[userId]`.

- [ ] **Step 4: Commit**

```bash
cd como-ja-e-dia-frontend
git add lib/apiClient.js pages/api/groups/[id]/admins
git commit -m "feat: add API client methods and proxy routes for group admins"
```

---

### Task 7: `GroupAdmins` UI on the Groups page

**Files:**
- Create: `como-ja-e-dia-frontend/components/GroupAdmins.js`
- Modify: `como-ja-e-dia-frontend/pages/groups.js`

**Interfaces:**
- Consumes: `api.getGroupAdmins`, `api.addGroupAdmin`, `api.removeGroupAdmin` (Task 6).
- Produces: `<GroupAdmins groupId={string} />` component, rendered once per group card in `pages/groups.js` (already `super_admin`-gated at the page level, so no extra role check needed inside the component).

- [ ] **Step 1: Create the component**

Create `como-ja-e-dia-frontend/components/GroupAdmins.js`:

```jsx
import { useEffect, useState } from "react";
import { Stack, Chip, TextField, Button, Alert, Typography } from "@mui/material";
import { api } from "../lib/apiClient";

export default function GroupAdmins({ groupId }) {
    const [admins, setAdmins] = useState([]);
    const [loading, setLoading] = useState(true);
    const [email, setEmail] = useState("");
    const [error, setError] = useState("");

    function refresh() {
        setLoading(true);
        api.getGroupAdmins(groupId)
            .then((data) => {
                setAdmins(data || []);
                setError("");
            })
            .catch((err) => setError(err?.message || "Erro ao carregar admins"))
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        refresh();
    }, [groupId]);

    async function handleAdd() {
        if (!email.trim()) return;
        setError("");
        try {
            await api.addGroupAdmin(groupId, email.trim());
            setEmail("");
            refresh();
        } catch (err) {
            setError(err?.message || "Erro ao adicionar admin");
        }
    }

    async function handleRemove(userId) {
        setError("");
        try {
            await api.removeGroupAdmin(groupId, userId);
            setAdmins((prev) => prev.filter((a) => a.userId !== userId));
        } catch (err) {
            setError(err?.message || "Erro ao remover admin");
        }
    }

    return (
        <Stack spacing={1}>
            <Typography variant="subtitle2" fontWeight={700}>
                Admins
            </Typography>
            {error && <Alert severity="error">{error}</Alert>}
            <Stack direction="row" flexWrap="wrap" spacing={1}>
                {admins.map((a) => (
                    <Chip
                        key={a.userId}
                        label={a.name || a.email}
                        onDelete={() => handleRemove(a.userId)}
                        size="small"
                    />
                ))}
                {!loading && admins.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                        Nenhum admin específico.
                    </Typography>
                )}
            </Stack>
            <Stack direction="row" spacing={1}>
                <TextField
                    label="E-mail do admin"
                    size="small"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                />
                <Button variant="outlined" size="small" onClick={handleAdd} disabled={!email.trim()}>
                    Adicionar
                </Button>
            </Stack>
        </Stack>
    );
}
```

- [ ] **Step 2: Wire it into the Groups page**

In `como-ja-e-dia-frontend/pages/groups.js`, add imports:

```js
import Layout from "../components/Layout";
import { useAuth } from "../lib/auth";
import { api } from "../lib/apiClient";
import GroupPicker from "../components/GroupPicker";
import GroupAdmins from "../components/GroupAdmins";
```

and add `Divider` to the MUI import list:

```js
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
    Divider,
} from "@mui/material";
```

Find the group card's `CardContent`:

```jsx
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
```

Add `<Divider />` and `<GroupAdmins />` right before the closing `</CardContent>`:

```jsx
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
                                    <Divider sx={{ my: 1.5 }} />
                                    <GroupAdmins groupId={g.id} />
                                </CardContent>
                            </Card>
```

- [ ] **Step 3: Verify with a production build**

Run: `cd como-ja-e-dia-frontend && npm run build`
Expected: build succeeds, no type/lint errors.

- [ ] **Step 4: Manual check**

Start both dev servers (`npm run dev` in backend and frontend, valid `.env`), log in as `super_admin`, go to `/groups`, and confirm:
- Each group card shows an "Admins" section below the feature toggles.
- Adding a valid user email shows it as a chip; adding an unknown email shows an error.
- Removing a chip removes that admin.

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-frontend
git add components/GroupAdmins.js pages/groups.js
git commit -m "feat: add per-group admin management UI"
```

---

## Task Order & Independence

Tasks 1 → 2 → 3 are strictly sequential (schema → service → middleware, each consuming the previous). Task 4 depends only on Task 1 (needs `prisma.groupAdmin`) and can run in parallel with Task 3. Task 5 depends only on Task 2. Task 6 depends on Task 4's exact response shapes. Task 7 depends on Task 6. Suggested order: 1, 2, then (3 and 4 and 5 in parallel), then 6, then 7.
