# Design: Multi-group support with admin-managed group toggles

Date: 2026-07-30

## Problem

The bot currently supports exactly one WhatsApp group, hardcoded via the `GROUP_ID`/`ALLOWED_PING_GROUP` env var (fallback `120363339314665620@g.us`). This env var is read independently, with duplicated fallback logic, in at least 6 places across two repos:

- `handlers/commands.ts:66` (`isFromAllowedGroup` — gates every non-Miru command)
- `services/dropScheduler.ts:21-24` (which group gets the automatic Pokémon-drop cron check)
- `services/dropService.ts:89-93` (bug: `excludeIds` for drop rarity is computed **without** a `groupId` filter — captures in one group would incorrectly deplete availability in every other group)
- `services/scheduledJobs.ts:218-219` (target group for scheduled greeting broadcasts)
- `routes/confessions.ts:51-52` (target group for anonymous confession broadcasts)
- `handlers/triggers.ts:103-104` (which group's incoming messages get checked against trigger phrases)

The user wants to add the bot to a second WhatsApp group (Pokémon only, unrelated to the not-yet-shipped Miru anime-character game, which stays untouched) and, going forward, manage which groups have which features enabled from the admin frontend instead of editing env vars and redeploying.

## Goals

- Replace the single hardcoded group with a `Group` table; each row is independently toggleable per feature.
- Fix the drop-exclusion group-scoping bug as part of this work (it directly causes cross-group mixing once a second group exists).
- Let a super_admin add/remove groups and flip feature toggles from the frontend, without redeploying.
- Let a super_admin pick which specific group a `Trigger` belongs to, using the same group-picker UI/endpoint as adding a group.
- Zero-downtime migration: the current production group keeps working exactly as it does today.

## Out of scope

- Miru (anime character game) — not production-ready, not touched.
- Per-group customization beyond the 5 boolean toggles below (e.g. per-group persona, per-group drop rate) — not requested.
- Multi-tenant billing/ownership concepts — this is a single operator managing several communities, not multiple customers.

## Data model

New Prisma model in `como-ja-e-dia-backend/prisma/schema.prisma`:

```prisma
model Group {
  id                        String   @id                      // WhatsApp group JID, e.g. 123456789@g.us
  name                      String                             // display name (from Baileys subject, or typed manually)
  pokemonEnabled            Boolean  @default(false)
  confessionsEnabled        Boolean  @default(false)
  scheduledGreetingsEnabled Boolean  @default(false)
  triggersEnabled           Boolean  @default(false)
  contextSyncEnabled        Boolean  @default(false)
  createdAt                 DateTime @default(now())
  updatedAt                 DateTime @updatedAt
}
```

`Trigger` gains a required scoping field:

```prisma
model Trigger {
  // ...existing fields...
  groupId String   // which group this trigger fires in
}
```

**Migration:** insert one `Group` row seeded from `process.env.GROUP_ID || process.env.ALLOWED_PING_GROUP || '120363339314665620@g.us'`, `name: "Grupo principal"`, all 5 booleans `true`. Backfill existing `Trigger` rows' `groupId` with that same seeded JID.

No hard foreign key from `Trigger.groupId` (or `PokemonDrop.groupId`, `CharacterOwnership.groupId`, etc.) to `Group.id` — consistent with how `groupId` is already used elsewhere in this schema as a plain string, not a relation.

## Semantics of the 5 toggles

- **`pokemonEnabled`** — gates: `!pokemon(s)`, `!galeria`, `!give`, `!trade`, `!aceitar`, `!recusar`, `!confirmar`, `!cancelar`, `!forcespawn`, and whether the group participates in the automatic drop-spawn cron check.
- **`triggersEnabled`** — master kill switch: incoming messages in this group are checked against trigger phrases at all. Independent of and in addition to each `Trigger.groupId` — a trigger only fires if its own `groupId` matches **and** that group's `triggersEnabled` is true.
- **`confessionsEnabled`** — this group is a broadcast target when an anonymous confession is submitted via the public site.
- **`scheduledGreetingsEnabled`** — this group is a broadcast target for scheduled/cron greeting messages.
- **`contextSyncEnabled`** — this group's member list is periodically synced (`GroupContext`) for AI context.

Commands not covered by the 5 toggles (`!ajuda`/`!help`, `!all`/`!everyone`) remain gated only by "does a `Group` row exist for this JID" (any registration at all), independent of the specific feature flags — they're general utility, not tied to one feature.

## Backend changes (como-ja-e-dia-backend)

### Gating and fan-out refactor

Replace env-var reads with `Group` lookups in each of the 6 files listed in Problem:

- `handlers/commands.ts` `isFromAllowedGroup`: replace with `Group.findUnique({ where: { id: msg.from } })` existence check (cache with the same 60s TTL pattern already used for `linkedGroupCache`). Pokémon-specific commands additionally require `pokemonEnabled`.
- `services/dropScheduler.ts`: keep the single repeatable `check-drop` cron job (no change to job scheduling), but inside the processor, query `Group.findMany({ where: { pokemonEnabled: true } })` fresh on every tick and run the activity/roll check per group. This means turning a group's Pokémon toggle on/off takes effect on the very next tick, with no job-reconciliation logic needed.
- `services/dropService.ts`: fix `excludeIds` query in `executeDrop` to filter `capturedBy: { not: null }, groupId` (scoped to the group the drop is being computed for).
- `services/scheduledJobs.ts`: replace the single `groupId` computed at line 218-219 with a loop over `Group.findMany({ where: { scheduledGreetingsEnabled: true } })`, enqueueing the same payload per group.
- `routes/confessions.ts`: replace the single `targetGroupId` with a loop over `Group.findMany({ where: { confessionsEnabled: true } })`, enqueueing the confession broadcast per group.
- `handlers/triggers.ts`: the trigger cache/match now also filters candidate triggers by `trigger.groupId === msg.from`, and short-circuits entirely if that group's `triggersEnabled` is false.
- `routes/groupContext.ts` / periodic context sync: scope to groups where `contextSyncEnabled` is true instead of the single env-var group.

### Group discovery (cached)

Fetching the live list of WhatsApp groups the bot's number participates in requires round-tripping to the worker (Baileys), which is slow — so the result is cached.

- New Redis key `groups:discovered` (JSON array of `{ id, subject }`), `EX 86400` (1-day TTL).
- New queue `services/groupDiscoveryQueue.ts` (same shape as `groupContextQueue.ts`): `enqueueGroupDiscoveryJob()` takes no payload.
- New worker file `como-ja-e-dia-worker/src/groupDiscoveryProcessor.ts`: BullMQ worker on that queue, calls `sock.groupFetchAllParticipating()`, maps to `{ id, subject }[]`, POSTs the result to a new backend endpoint (worker-authenticated, `WORKER_API_SECRET`, same pattern as `requireWorkerOrRole`).
- New routes in `routes/groups.ts`:
  - `GET /groups/discover` (requireRole `super_admin`) — reads `groups:discovered` from Redis. If the key is missing/expired, enqueues a discovery job and returns a `{ status: "pending" }` response; frontend polls until the cache is populated.
  - `POST /groups/discover/sync` (requireRole `super_admin`) — deletes the `groups:discovered` Redis key and enqueues a discovery job immediately (the "Sync" button). Same polling contract as above.
  - `POST /groups/discover/ingest` (worker-authenticated) — worker's callback; writes the payload into `groups:discovered` with the 1-day `EX`.

### Group CRUD

- `GET /groups` (requireRole `super_admin`) — list all registered `Group` rows.
- `POST /groups` (requireRole `super_admin`) — body `{ id, name }`, creates a row with all 5 toggles `false`.
- `PATCH /groups/:id` (requireRole `super_admin`) — update `name` and/or any of the 5 booleans.
- `DELETE /groups/:id` (requireRole `super_admin`) — removes the row. No cascade: existing `PokemonDrop`/`Trigger` rows referencing that `groupId` are left as historical data (triggers pointing at a deleted group simply never match since `triggersEnabled` lookup fails the existence check).

### Trigger group scoping

- `routes/triggers.ts` `parseTriggerPayload`/`validateTriggerPayload`: add required `groupId` (string, non-empty) to the payload and validation.
- `handlers/triggers.ts`: match candidates additionally filtered by `groupId === msg.from`.

## Frontend changes (como-ja-e-dia-frontend)

### Groups admin screen

New section (super_admin only, same pattern as the WhatsApp QR section added to `pages/admin.js`):

- Table of registered groups: name, JID, 5 toggle switches (optimistic `PATCH /groups/:id` on change), delete button (`DELETE /groups/:id`).
- "Adicionar grupo" control: a shared `GroupPicker` component (see below) to pick an undiscovered/unregistered group, then `POST /groups` with `{ id, name: subject }`, all toggles off by default.

### Shared `GroupPicker` component

Reused by both the Groups admin screen and the trigger create/edit form (`pages/triggers.js`):

- Calls `GET /groups/discover`; while `status: "pending"`, polls every ~2s (small bounded number of retries, e.g. up to 15s, then shows a manual-retry message — the worker round-trip should be fast once Baileys responds).
- Renders a dropdown of `{ subject } (JID)` options.
- Includes a "Sync" button calling `POST /groups/discover/sync`, then resumes polling — used when a group was just added to WhatsApp and isn't in the up-to-24h-old cache yet.
- On the Groups screen, selecting an entry submits `POST /groups`. On the Trigger form, selecting an entry just sets the `groupId` field of the trigger being edited (existing groups already registered are also shown, sourced from the same discovery list, cross-referenced against `GET /groups` to label already-registered ones).

### `lib/apiClient.js`

Add `api.getGroups()`, `api.createGroup()`, `api.updateGroup()`, `api.deleteGroup()`, `api.getGroupDiscovery()`, `api.syncGroupDiscovery()`, following the existing `handleHeaders()` + `credentials: include` pattern.

## Mute-all groups (notification silencing)

**Problem:** the worker's WhatsApp session runs on a secondary phone/chip that's also the user's own device. That phone's WhatsApp app pushes a native notification for any message in any group that isn't muted — independent of anything the bot does. Every group the bot's number is a participant of needs to stay muted so the physical phone doesn't buzz.

**Change:**

- Baileys' `chatModify({ mute })` takes a duration in ms (not a "forever" sentinel) — `mute: 7 * 24 * 60 * 60 * 1000` (1 week, WhatsApp's own longest built-in option). Since it expires, it must be periodically reapplied.
- New shared worker helper `muteAllGroups(sock)` in `como-ja-e-dia-worker/src`: calls `sock.groupFetchAllParticipating()`, then `sock.chatModify({ mute: ONE_WEEK_MS }, jid)` for every group JID returned — **all** groups the account participates in, not just ones registered in the `Group` table (this is about the physical phone's notifications, unrelated to feature gating).
- Called from two places:
  1. `groupDiscoveryProcessor.ts` (the existing sync/discover job from the earlier section) — right after fetching the group list for the picker, so muting happens immediately whenever an admin hits "Sync" or a cache-miss fetch occurs.
  2. New repeatable BullMQ job, `services/muteSchedulerQueue.ts` (backend, same registration pattern as `dropScheduler.ts`/`scheduledJobs.ts`): `repeat: { every: 6 * 24 * 60 * 60 * 1000 }` (every 6 days — 1 day of margin before the 1-week mute would lapse), calling the same worker-side `muteAllGroups` via its own queue/processor pair. Runs independently of any admin action, so mute never lapses even if nobody opens the Groups screen for a long time.
- No unmute path in this design — muting is a permanent, self-renewing background behavior. If a manual unmute is ever needed, it'd be a manual Baileys call outside this system's scope.

## Testing

- Backend: unit tests for the gating helpers (`isFromAllowedGroup` replacement, trigger group-matching) and for `dropService.ts`'s fixed `excludeIds` query (two groups, capture in one must not exclude in the other) — mirrors the existing `__tests__/pokemonService.test.ts` / `reactionHandler.test.ts` structure.
- Backend: route tests for `routes/groups.ts` CRUD and the discover/sync cache behavior (mock Redis, assert `EX 86400` and cache-clear-on-sync).
- Worker: unit test for `groupDiscoveryProcessor.ts` mapping `groupFetchAllParticipating()` output to the POST payload, following the pattern in `contextProcessor.ts`'s tests.
- Manual verification: add bot to a second group, confirm `!pokemon` works there once `pokemonEnabled` is toggled on and not before; confirm a Pokémon captured in group A still drops normally in group B.
- Worker: unit test for `muteAllGroups` — mock `groupFetchAllParticipating` returning N groups, assert `chatModify` is called once per group with `mute: ONE_WEEK_MS`.
- Manual verification: trigger a Sync from the admin UI, confirm all groups (including ones not registered in `Group`) get muted on the phone; confirm the repeatable renewal job is registered with `getRepeatableJobs()` at a 6-day interval.
