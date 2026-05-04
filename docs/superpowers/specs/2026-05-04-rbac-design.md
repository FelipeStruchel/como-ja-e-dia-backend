# MVP 0 — RBAC: Role-Based Access Control

**Date:** 2026-05-04  
**Status:** Approved  
**Repos affected:** backend, frontend (worker: no changes expected — confirm before branching)  
**Branches:** `feature/rbac` in backend and frontend

---

## Context

Today the frontend has a single admin gate: any user with `status = approved` can access everything. With the Miru character system coming, we need granular permissions — some users should manage characters without accessing user management, and user management itself should be restricted to a trusted root role.

The current `UserStatus` enum (`pending`, `approved`, `blocked`) conflates authentication approval with authorization. This MVP separates those concerns.

---

## Database Changes

### New tables

**`Role`**
```
id        String  @id @default(cuid())
name      String  — display name ("Super Admin", "Bom Dia Admin", "Miru Cadastro")
slug      String  @unique — machine key ("super_admin", "bom_dia_admin", "miru_cadastro")
createdAt DateTime @default(now())
```

**`UserRole`** (many-to-many join)
```
id     String @id @default(cuid())
userId String → User
roleId String → Role
@@unique([userId, roleId])
```

### Changes to `User`

Remove `status` field (`UserStatus` enum). Replace with:

```
active Boolean @default(false)
```

`active = false` is the equivalent of `pending` — user cannot log in. Super Admin activates accounts and assigns roles via the admin screen. `blocked` is folded into `active = false`.

### Migration strategy

1. Prisma migration drops `UserStatus` enum and `status` column, adds `active` column.
2. Data migration in the same migration file: all users with `status = approved` get `active = true`; all others get `active = false`.
3. Seed: create the three initial roles (`super_admin`, `bom_dia_admin`, `miru_cadastro`).
4. Manual step post-deploy: Super Admin user is assigned `super_admin` role via a seed/script targeting the known admin email.

---

## Authorization Model

**Super Admin** — implicit access to everything. No need to check individual routes; if user has `super_admin` role, all middleware passes.

**Other roles** — checked per route group:
- `bom_dia_admin` — schedules, triggers, persona, events, confessions, logs, media
- `miru_cadastro` — character CRUD routes (MVP 1)

A user can hold multiple roles simultaneously.

---

## Backend Changes

### `authService.ts`

- `authenticateUser`: check `active` instead of `status`. Blocked/pending message: "Conta inativa".
- `getUserById`: include `roles` (via `UserRole → Role`) in the returned object.
- New: `listUsers()` — include roles.
- New: `assignRole(userId, roleSlug)` / `removeRole(userId, roleSlug)`.
- New: `setUserActive(userId, active: boolean)` — replaces `setUserStatus`.

### `middleware/auth.ts`

- `requireAuth` — unchanged in structure; attach `user` with roles to `req`.
- New: `requireRole(...slugs: string[])` middleware factory — checks that `req.user` has at least one of the given role slugs, or has `super_admin`. Returns 403 if not.

### Route protection

Apply `requireRole` to existing route groups:

| Route group | Required role |
|---|---|
| `/schedules`, `/triggers`, `/persona`, `/events`, `/confessions`, `/logs`, `/media` | `bom_dia_admin` |
| `/auth/users/*` (user management) | `super_admin` |
| `/characters/*` (MVP 1) | `miru_cadastro` |

Public routes remain unchanged: `/auth/login`, `/auth/register`, `/health`.

---

## Frontend Changes

### User management screen (`/users`)

- Currently shows user list with approve/block buttons.
- New: shows `active` toggle instead of status buttons.
- New: role assignment UI — per user, checkboxes or multi-select for available roles.
- Access: `super_admin` only. Users without this role see 403 page.

### Existing admin pages

No layout changes. Add a frontend auth check: if API returns 403, redirect to a "Sem permissão" page. The sidebar can hide items the user doesn't have access to (derived from roles returned in the auth token or a `/auth/me` endpoint).

### Auth token / session

Include roles in the JWT payload (as an array of slugs) so the frontend can gate navigation without an extra request. The `requireRole` middleware on the backend is the authoritative check — frontend gating is UX only.

---

## Future Implementations

The following are explicitly out of scope for MVP 0 and should be tracked for future work:

- Dynamic role creation via UI (roles are seeded, not created at runtime for now)
- Permission granularity below role level (e.g., per-resource ACLs)
- Role inheritance / hierarchies beyond the `super_admin` implicit root
- Audit log for role assignments
- Additional roles beyond the initial three
