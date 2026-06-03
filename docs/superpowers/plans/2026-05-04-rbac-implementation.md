# RBAC MVP 0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Role-Based Access Control — replace the `UserStatus` enum with an `active` boolean, introduce `Role` and `UserRole` tables, and gate existing routes behind roles (`bom_dia_admin`, `super_admin`).

**Architecture:** All authorization is enforced on the backend via `requireRole()` middleware. The frontend does role-based nav hiding for UX only — the backend is always authoritative. Roles are stored in the DB and included in the JWT payload (array of slugs) so the frontend can gate navigation without an extra request.

**Tech Stack:** Backend — TypeScript, Express, Prisma 7.x, PostgreSQL, Vitest. Frontend — Next.js (Pages Router), JavaScript, Material UI.

**Spec:** `docs/superpowers/specs/2026-05-04-rbac-design.md`

---

## File Map

### Backend — modified
- `prisma/schema.prisma` — add `Role`, `UserRole`, change `User.status → User.active`, remove `UserStatus` enum
- `prisma/migrations/<timestamp>_rbac/migration.sql` — DDL + data migration (approved → active=true)
- `prisma/seed.js` — create 3 roles, assign `super_admin` to known admin email
- `services/authService.ts` — update `authenticateUser` (active check + roles in JWT), `getUserById` (include roles), `listUsers` (include roles), add `setUserActive`, `assignRole`, `removeRole`, `listRoles`; remove `setUserStatus`
- `middleware/auth.ts` — add `requireRole(...slugs)` factory, update `requireAuth` to include roles on `req.user`
- `routes/auth.ts` — remove inline `requireAuth`, import from middleware, remove `approve`/`block` routes, add `PATCH /:id/active`, `POST /:id/roles/:slug`, `DELETE /:id/roles/:slug`, `GET /auth/roles`; update login/me/users responses to include roles + active
- `routes/triggers.ts`, `routes/schedules.ts`, `routes/persona.ts`, `routes/logs.ts`, `routes/media.ts`, `routes/events.ts`, `routes/confessions.ts` — add `requireRole("bom_dia_admin")` to each admin-only handler alongside existing `requireAuth`

### Backend — new
- `__tests__/authService.test.ts` — unit tests for the new/changed authService functions
- `__tests__/requireRole.test.ts` — unit tests for `requireRole` middleware

### Frontend — modified
- `lib/apiClient.js` — replace `approveUser`/`blockUser` with `setUserActive`, add `assignRole`, `removeRole`, `listRoles`; update `me()` shape
- `lib/auth.js` — surface `roles` from `user` state, add `hasRole(slug)` to context
- `pages/admin.js` — add super_admin gate (redirect `/403`), replace approve/block UI with active toggle + role checkboxes, fetch available roles
- `components/Layout.js` — filter `protectedLinks` by role using `hasRole`

### Frontend — new
- `pages/403.js` — "Sem permissão" error page
- `pages/api/auth/users/[id]/active.js` — proxy PATCH → backend `PATCH /auth/users/:id/active`
- `pages/api/auth/users/[id]/roles/[slug].js` — proxy POST/DELETE → backend role endpoints
- `pages/api/auth/roles.js` — proxy GET → backend `GET /auth/roles`

### Frontend — deleted
- `pages/api/auth/users/[id]/approve.js` — replaced by active toggle
- `pages/api/auth/users/[id]/block.js` — replaced by active toggle

---

## Task 1: Update Prisma Schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Edit schema.prisma — remove `UserStatus` enum, update `User`, add `Role` and `UserRole`**

Replace the entire content of `prisma/schema.prisma` with:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model User {
  id           String     @id @default(cuid())
  email        String     @unique
  name         String     @default("")
  passwordHash String
  active       Boolean    @default(false)
  createdAt    DateTime   @default(now())
  roles        UserRole[]
}

model Role {
  id        String     @id @default(cuid())
  name      String
  slug      String     @unique
  createdAt DateTime   @default(now())
  users     UserRole[]
}

model UserRole {
  id     String @id @default(cuid())
  userId String
  roleId String
  user   User   @relation(fields: [userId], references: [id])
  role   Role   @relation(fields: [roleId], references: [id])

  @@unique([userId, roleId])
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

model PokemonCache {
  id          Int      @id
  name        String
  imageUrl    String
  types       String[]
  captureRate Int
  aiCaption   String?
  cachedAt    DateTime @default(now())
}

model PokemonDrop {
  id         String    @id @default(cuid())
  groupId    String
  pokemonId  Int
  messageId  String?
  droppedAt  DateTime  @default(now())
  capturedBy String?
  capturedAt DateTime?
}
```

- [ ] **Step 2: Create migration skeleton (do NOT run migrate yet)**

```bash
cd como-ja-e-dia-backend
npx prisma migrate dev --create-only --name rbac
```

Expected: Prisma creates `prisma/migrations/<timestamp>_rbac/migration.sql` with generated DDL.

---

## Task 2: Write Migration SQL (Data Migration Included)

**Files:**
- Modify: `prisma/migrations/<timestamp>_rbac/migration.sql` (file created in Task 1 Step 2)

- [ ] **Step 1: Replace the generated migration.sql with the full DDL + data migration**

Open `prisma/migrations/<timestamp>_rbac/migration.sql` and replace its contents with:

```sql
-- Drop enum dependency first, then the column
ALTER TABLE "User" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false;
UPDATE "User" SET "active" = true WHERE "status" = 'approved';
ALTER TABLE "User" DROP COLUMN "status";
DROP TYPE IF EXISTS "UserStatus";

-- CreateTable Role
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable UserRole
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "Role_slug_key" ON "Role"("slug");
CREATE UNIQUE INDEX "UserRole_userId_roleId_key" ON "UserRole"("userId", "roleId");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 2: Apply migration and regenerate Prisma client**

```bash
cd como-ja-e-dia-backend
npx prisma migrate dev
npx prisma generate
```

Expected output: Migration applied successfully. No errors.

- [ ] **Step 3: Verify schema in DB**

```bash
cd como-ja-e-dia-backend
npx prisma studio
```

Confirm: `User` table has `active` column (no `status`). `Role` and `UserRole` tables exist.
Close Prisma Studio after confirming.

- [ ] **Step 4: Commit**

```bash
cd como-ja-e-dia-backend
git add prisma/schema.prisma prisma/migrations/
git commit -m "chore: rbac schema — Role/UserRole tables, User.status → User.active"
```

---

## Task 3: Update seed.js

**Files:**
- Modify: `prisma/seed.js`

- [ ] **Step 1: Replace seed.js with role-aware version**

```js
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const ROLES = [
  { name: 'Super Admin', slug: 'super_admin' },
  { name: 'Bom Dia Admin', slug: 'bom_dia_admin' },
  { name: 'Miru Cadastro', slug: 'miru_cadastro' },
]
const ADMIN_EMAIL = 'felipegrego23@outlook.com'

async function main() {
  // Upsert roles
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { slug: r.slug },
      update: { name: r.name },
      create: { name: r.name, slug: r.slug },
    })
  }
  console.log('Seed: roles upserted')

  // Create initial admin user if no users exist
  const count = await prisma.user.count()
  if (count === 0) {
    const password = randomBytes(12).toString('base64url')
    const passwordHash = await bcrypt.hash(password, 10)
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: 'Felipe Struchel',
        passwordHash,
        active: true,
      },
    })
    console.log(`Seed: usuário criado — email: ${ADMIN_EMAIL} | senha: ${password}`)
  }

  // Assign super_admin to admin email
  const adminUser = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } })
  if (adminUser) {
    const superAdminRole = await prisma.role.findUnique({ where: { slug: 'super_admin' } })
    if (superAdminRole) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: adminUser.id, roleId: superAdminRole.id } },
        update: {},
        create: { userId: adminUser.id, roleId: superAdminRole.id },
      })
      console.log(`Seed: super_admin atribuído a ${ADMIN_EMAIL}`)
    }
  }
}

main()
  .catch((e) => { console.error('Seed error:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Run seed**

```bash
cd como-ja-e-dia-backend
npx prisma db seed
```

Expected: "Seed: roles upserted" and "Seed: super_admin atribuído a felipegrego23@outlook.com".

- [ ] **Step 3: Commit**

```bash
cd como-ja-e-dia-backend
git add prisma/seed.js
git commit -m "chore: seed — upsert roles, assign super_admin to admin user"
```

---

## Task 4: Write Failing Tests for authService (TDD Red Phase)

**Files:**
- Create: `__tests__/authService.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the db module before importing authService
vi.mock('../services/db.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    role: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    userRole: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}))

import bcrypt from 'bcryptjs'
import { prisma } from '../services/db.js'
import {
  authenticateUser,
  getUserById,
  listUsers,
  setUserActive,
  assignRole,
  removeRole,
  listRoles,
} from '../services/authService.js'

const mockRole = { id: 'role-1', name: 'Super Admin', slug: 'super_admin', createdAt: new Date() }
const mockUserRole = { id: 'ur-1', userId: 'user-1', roleId: 'role-1', role: mockRole }
const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test',
  passwordHash: 'hashed',
  active: true,
  createdAt: new Date(),
  roles: [mockUserRole],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('authenticateUser', () => {
  it('throws "Conta inativa" when user.active is false', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...mockUser, active: false } as any)
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never)
    await expect(authenticateUser({ email: 'test@example.com', password: 'pass' }))
      .rejects.toThrow('Conta inativa')
  })

  it('throws "Credenciais inválidas" when password is wrong', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never)
    await expect(authenticateUser({ email: 'test@example.com', password: 'wrong' }))
      .rejects.toThrow('Credenciais inválidas')
  })

  it('returns user and token with roles in JWT when credentials are valid', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never)
    const result = await authenticateUser({ email: 'test@example.com', password: 'pass' })
    expect(result.token).toBeTruthy()
    expect(result.user.id).toBe('user-1')
    // Verify JWT contains roles
    const { default: jwt } = await import('jsonwebtoken')
    const payload = jwt.decode(result.token) as Record<string, unknown>
    expect(payload.roles).toEqual(['super_admin'])
  })
})

describe('getUserById', () => {
  it('fetches user with roles relation included', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    const user = await getUserById('user-1')
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      include: { roles: { include: { role: true } } },
    })
    expect(user).toEqual(mockUser)
  })
})

describe('setUserActive', () => {
  it('calls prisma.user.update with active flag', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({ ...mockUser, active: false } as any)
    await setUserActive('user-1', false)
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { active: false },
    })
  })

  it('returns null when user not found (P2025)', async () => {
    const err = Object.assign(new Error('not found'), { code: 'P2025' })
    vi.mocked(prisma.user.update).mockRejectedValue(err)
    const result = await setUserActive('missing', true)
    expect(result).toBeNull()
  })
})

describe('assignRole', () => {
  it('creates a UserRole record for the given slug', async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue(mockRole as any)
    vi.mocked(prisma.userRole.create).mockResolvedValue({} as any)
    await assignRole('user-1', 'super_admin')
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', roleId: 'role-1' },
    })
  })

  it('throws when role slug does not exist', async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue(null)
    await expect(assignRole('user-1', 'nonexistent')).rejects.toThrow('Role não encontrada')
  })
})

describe('removeRole', () => {
  it('deletes UserRole record for the given slug', async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue(mockRole as any)
    vi.mocked(prisma.userRole.deleteMany).mockResolvedValue({ count: 1 } as any)
    await removeRole('user-1', 'super_admin')
    expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', roleId: 'role-1' },
    })
  })

  it('does nothing when role slug does not exist', async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue(null)
    await removeRole('user-1', 'nonexistent')
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled()
  })
})

describe('listRoles', () => {
  it('returns all roles ordered by name', async () => {
    const roles = [mockRole]
    vi.mocked(prisma.role.findMany).mockResolvedValue(roles as any)
    const result = await listRoles()
    expect(prisma.role.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } })
    expect(result).toEqual(roles)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail (red)**

```bash
cd como-ja-e-dia-backend
npx vitest run __tests__/authService.test.ts
```

Expected: Tests fail with import errors (functions not yet exported from authService).

---

## Task 5: Implement authService Changes (TDD Green Phase)

**Files:**
- Modify: `services/authService.ts`

- [ ] **Step 1: Replace authService.ts with updated implementation**

```typescript
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

const DEFAULT_JWT_TTL = "7d";

function getJwtSecret(): string {
  return process.env.JWT_SECRET || "dev-secret-change-me";
}

const userWithRoles = {
  include: { roles: { include: { role: true } } },
} as const;

export async function registerUser({
  email,
  password,
  name,
}: {
  email: string;
  password: string;
  name?: string;
}) {
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
    data: { email: normalized, name: name || "", passwordHash, active: false },
  });
}

export async function authenticateUser({
  email,
  password,
}: {
  email: string;
  password: string;
}) {
  const normalized = String(email || "").toLowerCase().trim();
  const user = await prisma.user.findUnique({
    where: { email: normalized },
    ...userWithRoles,
  });
  if (!user) throw new Error("Credenciais inválidas");
  const ok = await bcrypt.compare(password || "", user.passwordHash);
  if (!ok) throw new Error("Credenciais inválidas");
  if (!user.active) throw new Error("Conta inativa");
  const roles = user.roles.map((ur) => ur.role.slug);
  const token = jwt.sign(
    { sub: user.id, email: user.email, roles },
    getJwtSecret(),
    { expiresIn: process.env.JWT_TTL || DEFAULT_JWT_TTL } as jwt.SignOptions
  );
  return { user, token };
}

export function verifyToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
}

export async function getUserById(id: string) {
  return prisma.user.findUnique({
    where: { id },
    ...userWithRoles,
  });
}

export async function listUsers() {
  return prisma.user.findMany({
    ...userWithRoles,
    orderBy: { createdAt: "desc" },
  });
}

export async function setUserActive(id: string, active: boolean) {
  try {
    return await prisma.user.update({ where: { id }, data: { active } });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2025") return null;
    throw err;
  }
}

export async function assignRole(userId: string, roleSlug: string) {
  const role = await prisma.role.findUnique({ where: { slug: roleSlug } });
  if (!role) throw new Error("Role não encontrada");
  await prisma.userRole.create({ data: { userId, roleId: role.id } });
}

export async function removeRole(userId: string, roleSlug: string) {
  const role = await prisma.role.findUnique({ where: { slug: roleSlug } });
  if (!role) return;
  await prisma.userRole.deleteMany({ where: { userId, roleId: role.id } });
}

export async function listRoles() {
  return prisma.role.findMany({ orderBy: { name: "asc" } });
}
```

- [ ] **Step 2: Run tests to confirm they pass (green)**

```bash
cd como-ja-e-dia-backend
npx vitest run __tests__/authService.test.ts
```

Expected: All authService tests pass.

- [ ] **Step 3: Run full typecheck**

```bash
cd como-ja-e-dia-backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd como-ja-e-dia-backend
git add services/authService.ts __tests__/authService.test.ts
git commit -m "feat: authService — active-based auth, roles in JWT, assignRole/removeRole/setUserActive"
```

---

## Task 6: Write Failing Tests for requireRole Middleware (TDD Red Phase)

**Files:**
- Create: `__tests__/requireRole.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
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

import { verifyToken, getUserById } from '../services/authService.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

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

const mockRole = { id: 'role-1', name: 'Super Admin', slug: 'super_admin', createdAt: new Date() }
const mockUserRole = { id: 'ur-1', userId: 'u1', roleId: 'role-1', role: mockRole }
const mockUser = {
  id: 'u1',
  email: 'a@b.com',
  name: '',
  passwordHash: '',
  active: true,
  createdAt: new Date(),
  roles: [mockUserRole],
}

beforeEach(() => vi.clearAllMocks())

describe('requireRole', () => {
  it('returns 403 when user has none of the required roles', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue({
      ...mockUser,
      roles: [{ ...mockUserRole, role: { ...mockRole, slug: 'bom_dia_admin' } }],
    } as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireAuth(req, res, next)
    vi.clearAllMocks() // clear next call from requireAuth

    const { req: req2, res: res2, next: next2 } = { req, res, next: vi.fn() }
    await requireRole('super_admin')(req2, res2, next2)
    expect(res2.status).toHaveBeenCalledWith(403)
    expect(res2.json).toHaveBeenCalledWith({ error: 'Sem permissão' })
    expect(next2).not.toHaveBeenCalled()
  })

  it('calls next() when user has the required role', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any)
    const { req, res, next } = makeReqRes('valid-token')
    await requireAuth(req, res, next)

    const next2 = vi.fn()
    await requireRole('super_admin')(req, res, next2)
    expect(next2).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalledWith(403)
  })

  it('calls next() when user has super_admin regardless of required role', async () => {
    vi.mocked(verifyToken).mockReturnValue({ sub: 'u1' } as any)
    vi.mocked(getUserById).mockResolvedValue(mockUser as any) // mockUser has super_admin
    const { req, res, next } = makeReqRes('valid-token')
    await requireAuth(req, res, next)

    const next2 = vi.fn()
    await requireRole('bom_dia_admin')(req, res, next2)
    expect(next2).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to confirm they fail (red)**

```bash
cd como-ja-e-dia-backend
npx vitest run __tests__/requireRole.test.ts
```

Expected: Tests fail — `requireRole` not exported from middleware/auth.ts.

---

## Task 7: Implement requireRole Middleware (TDD Green Phase)

**Files:**
- Modify: `middleware/auth.ts`

- [ ] **Step 1: Update middleware/auth.ts**

```typescript
import { Request, Response, NextFunction } from "express";
import { verifyToken, getUserById } from "../services/authService.js";

type UserWithRoles = Awaited<ReturnType<typeof getUserById>>;

declare global {
  namespace Express {
    interface Request {
      user?: UserWithRoles;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "Token ausente" });
      return;
    }
    const payload = verifyToken(token);
    const user = await getUserById(payload.sub as string);
    if (!user) {
      res.status(401).json({ error: "Usuário não encontrado" });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}

export function requireRole(...slugs: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    const userSlugs = user.roles?.map((ur) => ur.role.slug) ?? [];
    const hasAccess =
      userSlugs.includes("super_admin") || slugs.some((s) => userSlugs.includes(s));
    if (!hasAccess) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    next();
  };
}
```

- [ ] **Step 2: Run tests to confirm they pass (green)**

```bash
cd como-ja-e-dia-backend
npx vitest run __tests__/requireRole.test.ts
```

Expected: All requireRole tests pass.

- [ ] **Step 3: Run full test suite**

```bash
cd como-ja-e-dia-backend
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 4: Typecheck**

```bash
cd como-ja-e-dia-backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add middleware/auth.ts __tests__/requireRole.test.ts
git commit -m "feat: requireRole middleware — role-based access control gate"
```

---

## Task 8: Update routes/auth.ts

**Files:**
- Modify: `routes/auth.ts`

Replace the entire file:

- [ ] **Step 1: Replace routes/auth.ts**

```typescript
import { Express } from "express";
import {
  registerUser,
  authenticateUser,
  getUserById,
  listUsers,
  setUserActive,
  assignRole,
  removeRole,
  listRoles,
  verifyToken,
} from "../services/authService.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

function serializeUser(u: NonNullable<Awaited<ReturnType<typeof getUserById>>>) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    active: u.active,
    createdAt: u.createdAt,
    roles: u.roles.map((ur) => ur.role.slug),
  };
}

export function registerAuthRoutes(app: Express) {
  app.post("/auth/register", async (req, res) => {
    try {
      const { email, password, name } = req.body || {};
      await registerUser({ email, password, name });
      res.status(201).json({ message: "Cadastro realizado. Aguarde aprovação." });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao registrar";
      res.status(400).json({ error: msg });
    }
  });

  app.post("/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const { user, token } = await authenticateUser({ email, password });
      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          active: user.active,
          roles: user.roles.map((ur) => ur.role.slug),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Credenciais inválidas";
      res.status(401).json({ error: msg });
    }
  });

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

  // --- User management (super_admin only) ---

  app.get("/auth/users", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const users = await listUsers();
      res.json(users.map(serializeUser));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar usuários";
      res.status(500).json({ error: msg });
    }
  });

  app.patch("/auth/users/:id/active", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const { active } = req.body || {};
      if (typeof active !== "boolean") {
        return res.status(400).json({ error: "Campo 'active' deve ser boolean" });
      }
      const updated = await setUserActive(req.params.id, active);
      if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });
      res.json({ message: "Status atualizado" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao atualizar";
      res.status(400).json({ error: msg });
    }
  });

  app.post("/auth/users/:id/roles/:slug", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      await assignRole(req.params.id, req.params.slug);
      res.json({ message: "Role atribuída" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao atribuir role";
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/auth/users/:id/roles/:slug", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      await removeRole(req.params.id, req.params.slug);
      res.json({ message: "Role removida" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao remover role";
      res.status(400).json({ error: msg });
    }
  });

  app.get("/auth/roles", requireAuth, requireRole("super_admin"), async (_req, res) => {
    try {
      const roles = await listRoles();
      res.json(roles);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar roles";
      res.status(500).json({ error: msg });
    }
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
cd como-ja-e-dia-backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/auth.ts
git commit -m "feat: auth routes — active toggle, role assignment, remove approve/block"
```

---

## Task 9: Add requireRole to Protected Route Files

**Files:**
- Modify: `routes/triggers.ts`, `routes/schedules.ts`, `routes/persona.ts`, `routes/logs.ts`, `routes/media.ts`

Each file already imports `requireAuth` from `"../middleware/auth.js"`. The change for each file is:

1. Add `requireRole` to the import.
2. Add `requireRole("bom_dia_admin")` as the second middleware argument on every `app.get/post/put/patch/delete` call that already has `requireAuth`.

- [ ] **Step 1: Update routes/triggers.ts import and all handlers**

At the top of `routes/triggers.ts`, change:
```typescript
import { requireAuth } from "../middleware/auth.js";
```
to:
```typescript
import { requireAuth, requireRole } from "../middleware/auth.js";
```

Then for every route handler in `registerTriggerRoutes`, add `requireRole("bom_dia_admin")` immediately after `requireAuth`. Example — every occurrence of this pattern:
```typescript
app.get("/triggers", requireAuth, async (req, res) => {
```
becomes:
```typescript
app.get("/triggers", requireAuth, requireRole("bom_dia_admin"), async (req, res) => {
```

Apply the same transformation to every route in the file (`GET /triggers`, `GET /triggers/:id`, `POST /triggers`, `PUT /triggers/:id`, `DELETE /triggers/:id`).

- [ ] **Step 2: Update routes/schedules.ts import and all handlers**

Same change: add `requireRole` to import, add `requireRole("bom_dia_admin")` after `requireAuth` on every handler.

- [ ] **Step 3: Update routes/persona.ts import and all handlers**

Same change.

- [ ] **Step 4: Update routes/logs.ts import and all handlers**

Same import change, but use `requireRole("super_admin")` instead of `"bom_dia_admin"` — logs are restricted to super admins only.

- [ ] **Step 5: Update routes/media.ts import and all handlers**

Same change.

- [ ] **Step 6: Update routes/events.ts — add requireRole to admin-only handlers**

`routes/events.ts` has a mix of public and admin operations. Add `requireRole` to import, then add `requireRole("bom_dia_admin")` only on handlers that already call `requireAuth`. Do NOT add it to the public `GET /events` handler (used by the public events page — if it has no `requireAuth`, leave it alone).

Pattern: any `app.post`, `app.put`, `app.patch`, `app.delete` in this file that has `requireAuth` gets `requireRole("bom_dia_admin")` added after it.

- [ ] **Step 7: Update routes/confessions.ts — add requireRole to admin-only handlers**

`routes/confessions.ts` has a public submission endpoint (`POST /confessions`) used by anyone. Add `requireRole` to import, then add `requireRole("bom_dia_admin")` only on handlers that already have `requireAuth`. The public submission handler stays unchanged.

- [ ] **Step 8: Typecheck**

```bash
cd como-ja-e-dia-backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 9: Run full test suite**

```bash
cd como-ja-e-dia-backend
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/triggers.ts routes/schedules.ts routes/persona.ts routes/logs.ts routes/media.ts routes/events.ts routes/confessions.ts
git commit -m "feat: gate bom_dia_admin routes behind requireRole middleware"
```

---

## Task 10: Frontend — Add New API Proxy Routes

**Files:**
- Create: `pages/api/auth/users/[id]/active.js`
- Create: `pages/api/auth/users/[id]/roles/[slug].js`
- Create: `pages/api/auth/roles.js`
- Delete: `pages/api/auth/users/[id]/approve.js`
- Delete: `pages/api/auth/users/[id]/block.js`

- [ ] **Step 1: Create pages/api/auth/users/[id]/active.js**

```javascript
import { proxyJson } from "../../../../../lib/backendApi";

export default async function handler(req, res) {
  if (req.method !== "PATCH") {
    res.setHeader("Allow", ["PATCH"]);
    return res.status(405).end("Method Not Allowed");
  }
  const { id } = req.query;
  return proxyJson(req, res, { path: `/auth/users/${id}/active`, method: "PATCH" });
}
```

- [ ] **Step 2: Create pages/api/auth/users/[id]/roles/[slug].js**

```javascript
import { proxyJson } from "../../../../../../lib/backendApi";

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "DELETE") {
    res.setHeader("Allow", ["POST", "DELETE"]);
    return res.status(405).end("Method Not Allowed");
  }
  const { id, slug } = req.query;
  return proxyJson(req, res, {
    path: `/auth/users/${id}/roles/${slug}`,
    method: req.method,
  });
}
```

- [ ] **Step 3: Create pages/api/auth/roles.js**

```javascript
import { proxyJson } from "../../../lib/backendApi";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end("Method Not Allowed");
  }
  return proxyJson(req, res, { path: "/auth/roles", method: "GET" });
}
```

- [ ] **Step 4: Delete old approve and block proxy files**

```bash
cd como-ja-e-dia-frontend
rm pages/api/auth/users/\[id\]/approve.js
rm pages/api/auth/users/\[id\]/block.js
```

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-frontend
git add pages/api/auth/users/\[id\]/active.js \
        pages/api/auth/users/\[id\]/roles/ \
        pages/api/auth/roles.js
git rm pages/api/auth/users/\[id\]/approve.js \
       pages/api/auth/users/\[id\]/block.js
git commit -m "feat: frontend proxy — active toggle, role assign/remove, list roles"
```

---

## Task 11: Frontend — Update apiClient.js

**Files:**
- Modify: `lib/apiClient.js`

- [ ] **Step 1: Replace the user-management methods in apiClient.js**

Find and replace the block that currently has `listUsers`, `approveUser`, `blockUser` with:

```javascript
listUsers: () =>
    fetch("/api/auth/users", { ...withCreds, headers: handleHeaders() }).then(handleResponse),

setUserActive: (id, active) =>
    fetch(`/api/auth/users/${id}/active`, {
        method: "PATCH",
        credentials: "include",
        headers: handleHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ active }),
    }).then(handleResponse),

assignRole: (id, slug) =>
    fetch(`/api/auth/users/${id}/roles/${slug}`, {
        method: "POST",
        credentials: "include",
        headers: handleHeaders(),
    }).then(handleResponse),

removeRole: (id, slug) =>
    fetch(`/api/auth/users/${id}/roles/${slug}`, {
        method: "DELETE",
        credentials: "include",
        headers: handleHeaders(),
    }).then(handleResponse),

listRoles: () =>
    fetch("/api/auth/roles", { ...withCreds, headers: handleHeaders() }).then(handleResponse),
```

- [ ] **Step 2: Commit**

```bash
cd como-ja-e-dia-frontend
git add lib/apiClient.js
git commit -m "feat: apiClient — setUserActive, assignRole, removeRole, listRoles"
```

---

## Task 12: Frontend — Update auth.js with Roles Support

**Files:**
- Modify: `lib/auth.js`

- [ ] **Step 1: Replace lib/auth.js**

```javascript
import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./apiClient";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let active = true;
        api.me()
            .then((res) => {
                if (active) setUser(res.user || null);
            })
            .catch(() => {
                if (active) setUser(null);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, []);

    const login = async (email, password) => {
        const res = await api.login({ email, password });
        if (typeof window !== "undefined" && res?.token) {
            window.localStorage.setItem("auth_token", res.token);
        }
        setUser(res.user || null);
        return res;
    };

    const logout = async () => {
        try {
            await api.logout();
        } catch {
            // ignore
        }
        if (typeof window !== "undefined") {
            window.localStorage.removeItem("auth_token");
        }
        setUser(null);
    };

    function hasRole(slug) {
        if (!user?.roles) return false;
        return user.roles.includes("super_admin") || user.roles.includes(slug);
    }

    return (
        <AuthContext.Provider value={{ user, loading, login, logout, hasRole }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    return useContext(AuthContext);
}
```

- [ ] **Step 2: Commit**

```bash
cd como-ja-e-dia-frontend
git add lib/auth.js
git commit -m "feat: auth context — expose roles and hasRole helper"
```

---

## Task 13: Frontend — Create pages/403.js

**Files:**
- Create: `pages/403.js`

- [ ] **Step 1: Create the 403 page**

```javascript
import { Box, Typography, Button } from "@mui/material";
import Link from "next/link";
import Layout from "../components/Layout";

export default function ForbiddenPage() {
    return (
        <Layout title="Sem permissão">
            <Box sx={{ textAlign: "center", py: 6 }}>
                <Typography variant="h1" sx={{ fontSize: "4rem", fontWeight: 700, mb: 1 }}>
                    403
                </Typography>
                <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
                    Você não tem permissão para acessar esta página.
                </Typography>
                <Button variant="contained" component={Link} href="/">
                    Voltar para o início
                </Button>
            </Box>
        </Layout>
    );
}
```

- [ ] **Step 2: Commit**

```bash
cd como-ja-e-dia-frontend
git add pages/403.js
git commit -m "feat: add 403 Sem permissão page"
```

---

## Task 14: Frontend — Update admin.js (Role UI + super_admin Gate)

**Files:**
- Modify: `pages/admin.js`

- [ ] **Step 1: Replace pages/admin.js**

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
    Checkbox,
    FormGroup,
    LinearProgress,
    Chip,
} from "@mui/material";
import Layout from "../components/Layout";
import { useAuth } from "../lib/auth";
import { api } from "../lib/apiClient";

export default function AdminPage() {
    const { user, loading, hasRole } = useAuth();
    const router = useRouter();
    const [users, setUsers] = useState([]);
    const [availableRoles, setAvailableRoles] = useState([]);
    const [loadingUsers, setLoadingUsers] = useState(false);
    const [userError, setUserError] = useState("");

    // Redirect non-super_admin users
    useEffect(() => {
        if (!loading && user && !hasRole("super_admin")) {
            router.replace("/403");
        }
        if (!loading && !user) {
            router.replace("/login");
        }
    }, [loading, user, hasRole, router]);

    useEffect(() => {
        if (!user || !hasRole("super_admin")) return;
        setLoadingUsers(true);
        Promise.all([api.listUsers(), api.listRoles()])
            .then(([usersData, rolesData]) => {
                setUsers(usersData || []);
                setAvailableRoles(rolesData || []);
                setUserError("");
            })
            .catch((err) => setUserError(err?.message || "Erro ao carregar dados"))
            .finally(() => setLoadingUsers(false));
    }, [user]);

    async function handleActiveToggle(id, currentActive) {
        const newActive = !currentActive;
        await api.setUserActive(id, newActive);
        setUsers((prev) =>
            prev.map((u) => (u.id === id ? { ...u, active: newActive } : u))
        );
    }

    async function handleRoleToggle(userId, slug, currentlyHas) {
        if (currentlyHas) {
            await api.removeRole(userId, slug);
            setUsers((prev) =>
                prev.map((u) =>
                    u.id === userId
                        ? { ...u, roles: u.roles.filter((r) => r !== slug) }
                        : u
                )
            );
        } else {
            await api.assignRole(userId, slug);
            setUsers((prev) =>
                prev.map((u) =>
                    u.id === userId ? { ...u, roles: [...u.roles, slug] } : u
                )
            );
        }
    }

    if (loading || !user) return null;

    return (
        <Layout title="Gerenciar Usuários">
            <Grid container spacing={3}>
                <Grid item xs={12}>
                    {loadingUsers && <LinearProgress sx={{ mb: 2 }} />}
                    {userError && (
                        <Alert severity="error" sx={{ mb: 2 }}>
                            {userError}
                        </Alert>
                    )}
                    <Stack spacing={2}>
                        {users.map((u) => (
                            <Card key={u.id} variant="outlined">
                                <CardContent>
                                    <Stack
                                        direction={{ xs: "column", sm: "row" }}
                                        spacing={2}
                                        alignItems={{ sm: "flex-start" }}
                                        justifyContent="space-between"
                                    >
                                        <Stack spacing={0.5}>
                                            <Typography variant="body1" sx={{ fontWeight: 700 }}>
                                                {u.email}
                                            </Typography>
                                            <Typography variant="body2" color="text.secondary">
                                                {u.name || "Sem nome"}
                                            </Typography>
                                            <Chip
                                                label={u.active ? "ativo" : "inativo"}
                                                color={u.active ? "success" : "default"}
                                                variant="outlined"
                                                size="small"
                                                sx={{ width: "fit-content" }}
                                            />
                                        </Stack>
                                        <Stack spacing={1}>
                                            <FormControlLabel
                                                control={
                                                    <Switch
                                                        checked={u.active}
                                                        onChange={() => handleActiveToggle(u.id, u.active)}
                                                        size="small"
                                                    />
                                                }
                                                label="Conta ativa"
                                            />
                                            <FormGroup>
                                                {availableRoles.map((role) => (
                                                    <FormControlLabel
                                                        key={role.slug}
                                                        control={
                                                            <Checkbox
                                                                checked={u.roles.includes(role.slug)}
                                                                onChange={() =>
                                                                    handleRoleToggle(
                                                                        u.id,
                                                                        role.slug,
                                                                        u.roles.includes(role.slug)
                                                                    )
                                                                }
                                                                size="small"
                                                            />
                                                        }
                                                        label={role.name}
                                                    />
                                                ))}
                                            </FormGroup>
                                        </Stack>
                                    </Stack>
                                </CardContent>
                            </Card>
                        ))}
                        {!loadingUsers && users.length === 0 && (
                            <Typography color="text.secondary">
                                Nenhum usuário cadastrado.
                            </Typography>
                        )}
                    </Stack>
                </Grid>
            </Grid>
        </Layout>
    );
}
```

- [ ] **Step 2: Commit**

```bash
cd como-ja-e-dia-frontend
git add pages/admin.js
git commit -m "feat: admin page — super_admin gate, active toggle, role checkboxes"
```

---

## Task 15: Frontend — Update Layout.js for Role-Based Navigation

**Files:**
- Modify: `components/Layout.js`

- [ ] **Step 1: Update Layout.js to filter nav links by role**

Add `hasRole` to the `useAuth()` destructure and update the `protectedLinks` array to include a `role` property. Then filter the links before rendering.

Replace the top of `Layout.js` through the `navLinks` line:

```javascript
import { useState } from "react";
import Link from "next/link";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Drawer from "@mui/material/Drawer";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import MenuIcon from "@mui/icons-material/Menu";
import CloseIcon from "@mui/icons-material/Close";
import { useAuth } from "../lib/auth";

const publicLinks = [
    { href: "/", label: "Mensagem do Dia" },
    { href: "/events", label: "Eventos" },
    { href: "/confessions", label: "Confissões" },
];

const protectedLinks = [
    { href: "/triggers", label: "Triggers", role: "bom_dia_admin" },
    { href: "/logs", label: "Logs", role: "super_admin" },
    { href: "/admin", label: "Admin", role: "super_admin" },
    { href: "/persona", label: "Persona", role: "bom_dia_admin" },
    { href: "/schedules", label: "Agendamentos", role: "bom_dia_admin" },
];

export default function Layout({ children, title }) {
    const { user, loading, logout, hasRole } = useAuth();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down("md"));
    const [drawerOpen, setDrawerOpen] = useState(false);

    const navLinks = user
        ? [...publicLinks, ...protectedLinks.filter((link) => hasRole(link.role))]
        : publicLinks;
```

The rest of the component (`toggleDrawer`, `renderAuthActions`, JSX) stays unchanged.

- [ ] **Step 2: Commit**

```bash
cd como-ja-e-dia-frontend
git add components/Layout.js
git commit -m "feat: layout — filter nav links by role using hasRole"
```

---

## Task 16: End-to-End Verification

- [ ] **Step 1: Run backend tests + typecheck**

```bash
cd como-ja-e-dia-backend
npx vitest run && npx tsc --noEmit
```

Expected: All tests pass, no type errors.

- [ ] **Step 2: Start both services**

```bash
# Terminal 1
cd como-ja-e-dia-backend && npm start

# Terminal 2
cd como-ja-e-dia-frontend && npm run dev
```

- [ ] **Step 3: Verify login still works**

Visit `http://localhost:3001/login`. Log in with `felipegrego23@outlook.com`. Confirm login succeeds and the user is redirected to the admin area.

- [ ] **Step 4: Verify admin page shows users with role checkboxes**

Visit `http://localhost:3001/admin`. Confirm:
- User list loads
- Each user shows an active toggle (Switch) and role checkboxes
- The logged-in user has `super_admin` checked

- [ ] **Step 5: Verify a user without super_admin is redirected to /403**

Create a second user via register, activate them (toggle switch), assign only `bom_dia_admin`. Log in as that user. Visit `/admin`. Confirm redirect to `/403`.

- [ ] **Step 6: Verify 403 page shows for unauthorized API calls**

```bash
curl -X GET http://localhost:3000/auth/users
# Expected: 401 Token ausente

curl -X GET http://localhost:3000/auth/users \
  -H "Authorization: Bearer <bom_dia_admin_token>"
# Expected: 403 Sem permissão
```

- [ ] **Step 7: Verify bom_dia_admin can access triggers but not admin**

Log in as the `bom_dia_admin` user. Confirm Triggers, Logs, Persona, Agendamentos links appear in nav. Confirm Admin link does NOT appear. Navigating to `/admin` manually redirects to `/403`.

- [ ] **Step 8: Final commit (if any loose files)**

```bash
cd como-ja-e-dia-backend && git status
cd como-ja-e-dia-frontend && git status
```

Commit any remaining unstaged changes.
