# Group-scoped confessions (sub-project 3 of 4) — Design

**Goal:** The public, anonymous confession form stops broadcasting to every `confessionsEnabled` group at once — the sender picks exactly one group, and only that group gets the message.

Sub-project 3 of 4 from `2026-08-04-group-scoped-admin-design.md`'s roadmap. Independent of sub-project 2 (different resource, no shared code beyond the existing `services/groupService.ts` helpers) — can ship in either order relative to it.

## Context

Today `POST /confessions` is a fully public, unauthenticated, anonymous endpoint. It takes no group information at all — it looks up every group with `confessionsEnabled = true` via `getConfessionsEnabledGroupIds()` and enqueues the same message to all of them. There's no admin/ownership concept here at all (unlike sub-project 2's resources) — this is purely "let an anonymous visitor pick which of the eligible groups gets their message," gated by the same `confessionsEnabled` flag that already exists.

## Decisions from brainstorming

**A picker is required, not optional.** A random visitor has no way to know a WhatsApp group's JID (the `groupId` format, e.g. `120363339314665620@g.us`) — expecting them to supply one is a non-starter. The picker shows group display names, submits the underlying `groupId`.

**New public endpoint, not the existing admin `GroupPicker`.** The frontend's existing `components/GroupPicker.js` calls `api.getGroupDiscovery()` → backend `GET /groups/discover`, which is `requireAuth, requireRole("super_admin")` and drives a live WhatsApp-group-discovery/polling flow meant for admins adding new groups to the system. None of that applies to an anonymous confession submitter, and it must not be exposed to the public. New, separate, minimal public route: `GET /confessions/groups` (in `routes/confessions.ts`, no auth) returns `Array<{ id: string; name: string }>` — the `id`/`name` of every group with `confessionsEnabled = true`, straight from `prisma.group.findMany({ where: { confessionsEnabled: true }, select: { id: true, name: true } })`. Nothing else about a group (feature flags, admin list, etc.) is exposed.

**Server-side re-validation, not trust in the picker.** `POST /confessions` now requires `groupId` in the body. The handler re-fetches `getConfessionsEnabledGroupIds()` (or an equivalent check) and rejects with `400` if the submitted `groupId` isn't in that set — the picker only showing eligible groups is a UX convenience, not the security boundary. A request forged with a `groupId` the sender was never shown (a group with `confessionsEnabled = false`, or a nonexistent id) is rejected the same way whether it came from stale UI state or a hand-crafted request.

**Cooldown becomes per `(IP, groupId)`, not per `IP` alone.** Today `lastConfessionByIp: Map<string, number>` keys purely on IP. Sending to group A no longer blocks sending to group B moments later — each group gets its own cooldown clock for that visitor. Key becomes `` `${ip}:${groupId}` ``.

**Message content and delivery are otherwise unchanged.** Still `` `Confissão anônima: ${message}` ``, still truncated to `MAX_MESSAGE_LENGTH`, still one `enqueueSendMessage` call — just to the one chosen `groupId` instead of a loop over every eligible group.

## Backend

**`routes/confessions.ts`:**
- New: `GET /confessions/groups` (public) → `[{ id, name }]` for `confessionsEnabled = true` groups.
- Changed: `POST /confessions` body gains a required `groupId: string`. Validation order: message non-empty and within length limit (unchanged) → `groupId` present and is one of the currently-`confessionsEnabled` groups (`400` otherwise, message: `"Grupo inválido"` — deliberately generic, doesn't distinguish "doesn't exist" from "flag is off," so it can't be used to enumerate groups) → cooldown check keyed by `` `${ip}:${groupId}` `` (`429` as today, same response shape) → send only to that `groupId`.

**`services/groupService.ts`:** no new function strictly required — `getConfessionsEnabledGroupIds()` already exists and is reused as-is for both the new public list endpoint's underlying query shape and the `POST` validation (call it fresh in each request handler; it's not on the hot path enough to need the 60s-cache treatment the single-group lookups get).

## Frontend

**`lib/apiClient.js`:**
- `getConfessionTargets: () => fetch("/api/confessions/groups", ...).then(handleResponse)` — no credentials needed (public), but goes through the same proxy pattern as every other backend call for consistency.
- `sendConfession(groupId, message)` — signature changes from `sendConfession(message)`; body becomes `{ groupId, message }`.

**`pages/api/confessions/groups.js`** (new proxy route): `GET` → `proxyJson(req, res, { path: "/confessions/groups", method: "GET" })`.

**`pages/confessions.js`:** fetches the target list once on mount (`api.getConfessionTargets()`), renders a simple `<Select>` (MUI) of group names above the message field — no need for the heavier `GroupPicker` component (no live-discovery polling, no "Sync" button, just a static list from one fetch). Submit is disabled until both a group is selected and the message is non-empty. On error (e.g. the list comes back empty — no group currently accepts confessions), show an explanatory message instead of an empty, unusable form.

## Testing

- `routes/confessions.ts` tests: `GET /confessions/groups` returns only `confessionsEnabled` groups, shape is exactly `{id, name}` (no flags leaked); `POST /confessions` rejects a `groupId` that isn't currently `confessionsEnabled` (`400`) even if it was valid moments ago (flag flipped mid-session — re-fetched fresh, not cached from an earlier request); cooldown blocks a second request to the *same* group within the window but allows one to a *different* group immediately; existing message-length/empty-message validation untouched.
- Manual/frontend: no test runner, verified via `npm run build`; the "empty list" UI state is the one behavior worth a deliberate look since it's easy to leave unhandled.
