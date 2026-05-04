# MVP 1 — Miru: Character Drop & Collection System

**Date:** 2026-05-04  
**Status:** Approved  
**Repos affected:** backend, frontend, worker  
**Branches:** `feature/miru` in backend, frontend, and worker  
**Prerequisite:** MVP 0 (RBAC) must be deployed first

---

## Context

Miru is a character collection system for the WhatsApp bot — distinct from the Pokémon drop system. Users roll for characters from anime, series, movies, and content creators. Each character exists only once per group (unique ownership). To avoid polluting the main group, all gameplay happens in a dedicated linked group created automatically per main group.

The system is named **Miru** and operates as its own branded subsystem within the bot.

---

## Database Schema

### `Character` — global catalog

```
id              String   @id @default(cuid())
name            String
series          String
category        CharacterCategory  — ANIME | SERIES | MOVIE | STREAMER
imageUrl        String
rarity          CharacterRarity    — COMMON | RARE | EPIC | LEGENDARY
popularityScore Float    — normalized 0–100, source-agnostic
coinValue       Int      — computed from formula at creation/update
active          Boolean  @default(true)
createdAt       DateTime @default(now())
updatedAt       DateTime @updatedAt
```

### `CharacterOwnership` — per-group ownership

```
id             String   @id @default(cuid())
characterId    String   → Character
groupId        String   — the gameGroupId where capture happened
ownerJid       String   — WhatsApp JID of owner
capturedAt     DateTime @default(now())
rollMessageId  String?  — WhatsApp message ID of the drop message

@@unique([characterId, groupId])  — one owner per character per group
```

### `LinkedGroup` — main ↔ game group binding

```
id           String   @id @default(cuid())
mainGroupId  String   @unique
gameGroupId  String   @unique
createdAt    DateTime @default(now())
```

---

## Rarity & Value Formula

### Rarity thresholds (auto-assigned from popularityScore)

| popularityScore | Rarity | Approx. share |
|---|---|---|
| ≥ 90 | LEGENDARY | ~5% |
| ≥ 70 | EPIC | ~15% |
| ≥ 40 | RARE | ~35% |
| < 40 | COMMON | ~45% |

Admin can override rarity manually at character creation.

### Coin value

```
coinValue = floor(popularityScore * rarityMultiplier)

rarityMultiplier:
  COMMON    = 1
  RARE      = 2
  EPIC      = 4
  LEGENDARY = 8
```

This value is stored at creation time. It will be used by the future economy system (skill purchases, trading, selling).

---

## Linked Group Architecture

The game group is a separate WhatsApp group created by the bot and linked to the main group.

### `!jogo` command (main group only)

1. Look up `LinkedGroup` by `mainGroupId`.
2. If no linked group exists: create a new WhatsApp group via Baileys `groupCreate`, save to `LinkedGroup`, add the requesting user.
3. If linked group exists: add the requesting user to the game group (if not already a member).
4. Bot replies in the main group with a link/invite to the game group.

The bot attempts to set the group description to indicate it's the Miru game group for the main group. Notification settings cannot be forced off by the bot — the message to new members should instruct them to mute manually if desired.

### Cross-group commands

`!album` and `!top` resolve the `gameGroupId` from `LinkedGroup` regardless of which group they are sent in — users can run collection queries from either the main group or the game group.

---

## Roll Mechanic

### Allowance

Each user has **10 rolls per hour** per game group. The allowance resets exactly 1 hour after the first roll of the current window (rolling window, not wall-clock reset).

Redis key: `miru:rolls:{gameGroupId}:{jid}` — stores `{ used: number, windowStart: number }`, TTL 3600s.

### Commands

| Command | Behavior |
|---|---|
| `!miru` | Drop 1 character, use 1 roll |
| `!miru <n>` | Drop n characters in sequence, use n rolls |
| `!miru all` | Drop all remaining rolls in sequence |

If `n` exceeds remaining rolls, the bot drops only what remains and reports the shortfall.

All commands are **game group only**. In the main group, `!miru` is ignored (or bot replies pointing to the game group).

### Drop sequence

For a batch of n drops:
1. Check and decrement roll allowance atomically in Redis.
2. For each character to drop (sequentially, ~3s apart):
   a. Select a random character from the pool: `active = true`, not owned in this group (no entry in `CharacterOwnership` for this `groupId`).
   b. Weighted selection by rarity: LEGENDARY 5%, EPIC 15%, RARE 35%, COMMON 45% — independent of remaining pool distribution.
   c. Create a pending `CharacterOwnership` record with `ownerJid = null`.
   d. Set Redis key `miru:drop:active:{gameGroupId}:{dropId}` with TTL 15s and payload `{ characterId, rolledBy }`.
   e. Send drop message: character image + name + series + rarity indicator + "React to capture!".
3. After all drops, send summary: "X rolls used, Y remaining. Resets in Z minutes."

### Capture

Worker listens for reactions on messages in the game group. On reaction:
1. Look up `miru:drop:active:{gameGroupId}:{dropId}` — if missing (expired or already captured), ignore.
2. GETDEL atomically to claim the drop.
3. Update `CharacterOwnership` record: set `ownerJid`, `capturedAt`, `rollMessageId`.
4. Send capture confirmation message tagging the winner.

If the drop expires without a reaction, the pending `CharacterOwnership` record is deleted and the character returns to the pool.

### Pool exhaustion

If all active characters for the group are owned, `!miru` responds: "Todos os personagens já foram capturados neste grupo! Novos personagens em breve."

---

## Collection Commands

### `!album` / `!album @pessoa`

Displays the collection of the requesting user (or mentioned user). Resolves to the game group linked to whichever group the command was sent in.

Format: list of characters with name, series, rarity, and coin value. If the collection is empty, bot replies with an onboarding message.

### `!top`

Ranking of users in the game group by number of characters owned. Top 10, with ties broken by total coinValue.

---

## Frontend — Character Management

### Public listing (no auth required)

Route: `/characters`  
Read-only list of all active characters with filters: category, rarity, search by name/series. Pagination. This page is accessible to anyone — intended as a reference so group members don't need to ask in chat.

### Admin CRUD (requires `miru_cadastro` role)

Same `/characters` page gains edit controls when the user is authenticated and has the role.

**Create / Edit form fields:**
- Name (required)
- Series (required)
- Category: ANIME | SERIES | MOVIE | STREAMER (required)
- Image URL (required)
- Popularity Score 0–100 (required) — rarity and coinValue auto-compute on input, displayed as preview
- Rarity override (optional — leave blank to use auto threshold)
- Active toggle

**Delete:** soft-delete via `active = false`. Characters already owned are not affected.

---

## Future Implementations

The following are explicitly out of scope for MVP 1. Track in the future implementations doc.

- **Wishlist system** — `!wishlist add <name>`, notify user when their wishlist character is rolled
- **Trading** — `!trocar @pessoa <character>`, bilateral trade with confirmation flow
- **Automatic event drops** — admin-triggered group-wide drops via frontend
- **Classes & skills** — Thief class (5s capture lock), Hunter class, Collector class, and the economy to buy/upgrade skills with coinValue
- **AniList / TMDB integration** — automated character import with popularity score sync
- **Streamer/YouTuber sourcing** — manual catalog with auto-image fetch from social APIs
- **Roll allowance nerfs** — reduce baseline rolls once classes exist to make skill upgrades meaningful
- **Notifications opt-in** — per-user setting to receive DM when a wishlist character drops
- **Sell system** — convert owned characters to coins
- **Coin economy** — buy rolls, buy skill upgrades, buy cosmetic effects
