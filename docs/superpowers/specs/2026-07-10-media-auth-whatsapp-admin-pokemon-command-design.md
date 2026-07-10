# Design: Public media upload fix, WhatsApp QR to super-admin, `!pokemon <nome>` command

Date: 2026-07-10

## 1. Public "Mensagem do Dia" media/text routes

**Problem:** the public page `/` (index.js, listed under `publicLinks` in `Layout.js`, no login required) lets any visitor submit a text (`POST /frases`) or a media file (`POST /media`) for the daily "bom dia" group message. `POST /frases` already has no auth. `POST /media` requires `requireAuth, requireRole("bom_dia_admin")`, so anonymous visitors get a 401 when uploading media — inconsistent with the page's public intent.

**Change:** in `routes/media.ts`, remove `requireAuth, requireRole("bom_dia_admin")` from the `POST /media` handler. It becomes public, matching `POST /frases`.

**Out of scope:** `GET /media`, `GET /media/:type/:filename` (already public), and `DELETE /media/:type/:filename` (stays `requireWorkerOrRole("bom_dia_admin")` — deletion is not a "receiving" route and isn't part of this request).

## 2. Move WhatsApp QR login to super-admin only

**Problem:** `WhatsAppStatus` (shows the WhatsApp pairing QR code when the bot session is disconnected) is rendered on the public `/` page. The backend `GET /whatsapp-qr` has no auth. Anyone visiting the public site can see the QR code needed to link a device to the bot's WhatsApp account — a hijack risk.

**Change:**
- Backend (`routes/whatsappQr.ts`): add `requireAuth, requireRole("super_admin")` to `GET /whatsapp-qr`. `POST /whatsapp-qr` (used by the worker to publish a new QR, authenticated via `x-ingest-token`/`LOG_INGEST_TOKEN`) is unchanged.
- Frontend: remove `<WhatsAppStatus />` from `pages/index.js`. Add a "WhatsApp" section at the top of `pages/admin.js` (already gated to `super_admin` via the existing `useEffect` redirect), rendering `WhatsAppStatus`.
- `lib/apiClient.js`: add `api.getWhatsAppQr()` following the existing `handleHeaders()` + `credentials: include` pattern so the request carries the bearer token.
- `components/WhatsAppStatus.js`: switch its SWR fetcher from a raw unauthenticated `fetch('/api/whatsapp-qr')` to `api.getWhatsAppQr()`.

## 3. `!pokemon <nome>` command

**Problem:** there's no way to look up a specific Pokémon's info by name. `!pokemon` / `!pokemons` (no argument) already means "show my captured collection" (`CommandType.Pokemons`) — that behavior must be preserved.

**Change:**
- `types.ts`: add `CommandType.PokemonInfo = "pokemon_info"`.
- `handlers/commands.ts` `parseCommand`: when the message is `!pokemon <arg>` (i.e. `!pokemon` followed by a non-empty argument), return `{ type: PokemonInfo, name: arg }`. Bare `!pokemon` / `!pokemons` keep returning `CommandType.Pokemons` (unchanged).
- New `handlePokemonInfoCommand(msg, name)`:
  1. Try `fetchAndCachePokemon` treating `name` as a PokeAPI identifier (lowercased; PokeAPI's `/pokemon/{id or name}` accepts either the English slug or numeric id). This also transparently caches it in `PokemonCache`/Redis for next time, reusing existing infra.
  2. If that lookup fails (404 or the trimmed input isn't a plausible slug/id), fall back to searching the local `PokemonCache` table by name in pt-BR, case- and accent-insensitive (reusing the existing `removeAccents` helper), the same way `resolveOwnedDrops` matches names today.
  3. If neither resolves, reply: `❌ Pokémon não encontrado: *<nome>*`.
  4. On success, send an image message (`type: "image"`) with `imageUrl`, name, types, and capture rate — same shape as the per-item message in `handleGaleriaCommand`.
- No ownership check: any Pokémon can be looked up regardless of whether it has been captured — this is a Pokédex lookup, not a personal-collection query.
- Dispatcher wiring in `processCommand`: add `if (cmd.type === CommandType.PokemonInfo) { await handlePokemonInfoCommand(msg, cmd.name); return; }`, gated the same as other non-Miru commands (goes through the existing `isFromAllowedGroup` check).

## Testing

- `__tests__/miruCommands.test.ts` and existing command tests show the pattern for testing `parseCommand`/handlers — add cases for: `!pokemon` (unchanged, returns `Pokemons`), `!pokemon pikachu` (English slug hit), `!pokemon <ptBRNameInCache>` (fallback hit), `!pokemon doesnotexist` (not found reply).
- No new tests needed for the auth changes beyond manually verifying `POST /media` succeeds unauthenticated and `GET /whatsapp-qr` returns 401 unauthenticated / 200 for a `super_admin` token.
