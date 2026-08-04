# Group-scoped admin — Design

**Goal:** Let `bom_dia_admin` be scoped to specific groups instead of granting access to everything, while `super_admin` keeps global reach. This is the foundation sub-project for a larger effort to make Events, Schedules, Persona, Confessions, and `!ajuda` fully group-aware.

## Roadmap (this doc covers only sub-project 1)

1. **Group-scoped admin foundation** (this doc) — data model, middleware, assignment UI. Does not touch any existing route's authorization yet.
2. **Events + Schedules + Persona become group-scoped** — add `groupId`, backfill existing rows to the main seed group, switch each route from `requireRole("bom_dia_admin")` to `requireGroupAdmin`. Also fixes the existing gap where `Trigger` already has `groupId` but its routes still check the global role. Legacy global `bom_dia_admin` `UserRole` assignments are removed only at the end of this sub-project, once every route that depended on them has migrated — avoids a window where nobody can manage daily content.
3. **Confessions become group-scoped** — the public submission form gets a group picker, filtered to groups with `confessionsEnabled = true` (same filtering pattern should be reused by any future public group-picker).
4. **`!ajuda` filters by the sending group's enabled features** — independent, smallest piece.

Each sub-project gets its own spec + plan before implementation starts.

## Context

Today, `bom_dia_admin` is a single global `Role` (via `UserRole`) — anyone holding it can manage events, schedules, persona, and triggers across every WhatsApp group the bot is in. With multiple groups now in play (see `2026-07-30-group-management-design.md`), that's too broad: an admin promoted for one community shouldn't be able to touch another group's content. `super_admin` should remain the only fully-global role.

## Decisions from brainstorming

- **A `bom_dia_admin` can administer multiple groups** (N:N), not just one.
- **`groupId = null` on a group-scoped resource means "all groups"** — but only `super_admin` is allowed to create resources that way. A group-scoped `bom_dia_admin` always attaches a resource to one or more of their own groups explicitly (never `null`); "apply to all my groups" in the UI creates one row per group they administer, not a null row. (This rule applies starting sub-project 2, where resources gain `groupId` — noted here since it shapes the admin model this doc introduces.)
- **`miru_cadastro` stays global** — not in scope for group-scoping.
- **Existing `bom_dia_admin` holders are not auto-migrated to their current groups** — after the cutover (end of sub-project 2), they start with zero group assignments and `super_admin` reassigns manually.
- **Existing resource data (events/schedules/persona) migrates to the main seed group** when sub-project 2 adds `groupId` to those tables — avoids orphaning history.
- **No lockout window**: sub-project 1 ships pure infrastructure (schema, middleware, assignment UI). No existing route's authorization changes. The legacy global `bom_dia_admin` `UserRole` rows are only removed once sub-project 2 has migrated every route that used to check them.

## Data model

New table, independent of the existing `Role`/`UserRole` system so `super_admin` and `miru_cadastro` are untouched:

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

Add reverse relations: `User.groupAdmins GroupAdmin[]`, `Group.admins GroupAdmin[]`. `onDelete: Cascade` on both sides so deleting a user or a group cleans up assignments automatically.

## Backend

**`services/groupService.ts`** — two new functions, following the existing 60s-cache pattern used by `isPokemonEnabled` etc.:
- `isGroupAdminOf(userId: string, groupId: string): Promise<boolean>`
- `getAdminGroupIds(userId: string): Promise<string[]>`

**`middleware/auth.ts`** — new `requireGroupAdmin(getGroupId: (req) => string | null | Promise<string | null>)`:
- Requires auth first (401 if not logged in).
- `super_admin` bypasses (matches existing `requireRole` behavior).
- Otherwise resolves `groupId` via the supplied function (route-specific: from `req.body.groupId` on create, from a looked-up resource's own `groupId` on update/delete) and checks `isGroupAdminOf`. Missing/unresolvable `groupId` → 400. Not an admin of that group → 403.

**New routes**, `super_admin` only (in `routes/groups.ts`):
- `GET /groups/:groupId/admins` — list users administering a group
- `POST /groups/:groupId/admins` `{ userId }` — assign
- `DELETE /groups/:groupId/admins/:userId` — revoke

**`routes/auth.ts`** — `GET /auth/me` response gains `adminGroupIds: string[]`, so the frontend knows which groups the logged-in user manages.

No existing route's `requireRole("bom_dia_admin")` changes in this sub-project.

## Frontend

The `/groups` page (already lists each group with feature toggles) gets an "Admins" section per group card: list of current admins, an email input + "add" button, remove buttons per admin. Reuses the existing card layout/pattern on that page.

## Testing

- `groupService.test.ts`: `isGroupAdminOf` / `getAdminGroupIds` — cache hit/miss cases, same shape as existing `isPokemonEnabled` tests.
- New `requireGroupAdmin.test.ts`: super_admin bypasses; group-admin of the right group passes; admin of a *different* group gets 403; unauthenticated gets 401; unresolvable groupId gets 400.
- New tests for `/groups/:groupId/admins` CRUD (list/assign/revoke), `super_admin`-only.

## Out of scope (future sub-projects)

- Adding `groupId` to `Event`, `Schedule`, `PersonaConfig`.
- Switching `Trigger`, `Event`, `Schedule`, `Persona` routes to `requireGroupAdmin`.
- Confessions group picker + `confessionsEnabled` filtering.
- `!ajuda` filtering by group feature flags.
- Removing legacy global `bom_dia_admin` `UserRole` assignments (happens at the end of sub-project 2).
