# `!ajuda` filtered by group permissions (sub-project 4 of 4) — Design

**Goal:** `!ajuda` stops listing commands a group can't actually use.

Sub-project 4 of 4 from `2026-08-04-group-scoped-admin-design.md`'s roadmap — the smallest of the four, independent of sub-projects 2 and 3 (touches only `handleAjudaCommand` in `handlers/commands.ts`).

## Context

`handleAjudaCommand` (`handlers/commands.ts:872`) sends one hardcoded block of text listing every command, unconditionally, to whichever group asked. It's reachable through the same `isFromAllowedGroup` gate as every other non-Miru command, so by the time it runs, `msg.from` is a known, allowed group — but "allowed" doesn't mean "has every feature turned on."

## What actually needs filtering — mapped against the real `Group` flags

Walking the existing help text section by section against the six `Group` boolean flags (`pokemonEnabled, confessionsEnabled, scheduledGreetingsEnabled, triggersEnabled, contextSyncEnabled, eventsEnabled`):

- **`!pokemons`, `!galeria`, `!forcespawn`, `!give`, `!trade`, `!aceitar`, `!confirmar`, `!recusar`, `!cancelar`** — every one of these is already gated at dispatch time by `POKEMON_COMMAND_TYPES` + `isPokemonEnabled(msg.from)` (see `handlers/commands.ts:1203-1215`, from the earlier `!pokemon <nome>` fix). They should only appear in `!ajuda` when `isPokemonEnabled(msg.from)` is `true` — otherwise the help text is actively misleading, listing commands that silently do nothing if typed.
- **`!analise`, `!all`** — general-purpose, gated by nothing (`!all` has its own separate "restricted to this group's admins" check unrelated to `Group` flags; `!analise` has none). No `Group` flag exists for either. Stay unconditional.
- **Miru section (`!miru help` and, by extension, the whole Miru command family)** — Miru commands are explicitly exempted from `isFromAllowedGroup` entirely (`isMiruCmd` bypass, `handlers/commands.ts:1201`), meaning they already work in *any* group, registered or not, independent of any `Group` row or flag. There is no `miruEnabled` flag, and — per sub-project 1's explicit decision — `miru_cadastro` and Miru's group behavior are staying untouched by this whole group-scoping effort. No change here.
- **`!pokemon <nome>` (the Pokédex-lookup command added earlier this session)** — gated by the same `pokemonEnabled` check as the rest of the pokemon family (confirmed: it was added to `POKEMON_COMMAND_TYPES` specifically to fix an inconsistency where it bypassed the flag). It's currently **missing from the help text entirely** — a pre-existing gap, not something this sub-project's filtering logic introduces. Since it shares the exact section and flag being touched, add the one missing line while here rather than leaving a command that works silently undocumented.

**Net scope: one conditional around the pokemon-related block (three of the help text's four sections), a documentation fix for one missing line, everything else untouched.** No new `Group` flag is introduced — `!analise`/`!all`/Miru simply have nothing to gate on today.

## Decision

`handleAjudaCommand` becomes `async` in its internal composition (it already is `async` at the function-signature level) and calls the existing `isPokemonEnabled(msg.from)` (already imported in this file, used one call away at line 1215) before deciding whether to include the `🎁 Transferência`, `🔄 Troca`, and the pokemon-specific half of `📋 Geral` (`!pokemons`, `!galeria`, `!forcespawn`, and the new `!pokemon <nome>` line). `!analise` and `!all` stay in `📋 Geral` unconditionally. `🎴 Miru` stays unconditional. When pokemon features are off for the group, the message ends with a short note rather than silently omitting three whole sections without explanation — something like `_Recursos de Pokémon estão desativados neste grupo._` so the omission isn't mistaken for a bug report waiting to happen.

## Testing

- `handlers/commands.ts` / whichever test file already covers `!ajuda` dispatch (if none exists, a new focused test): `isPokemonEnabled(msg.from) === true` → full text, including the pokemon sections and `!pokemon <nome>`; `=== false` → pokemon sections and the new line omitted, `!analise`/`!all`/Miru still present, the "desativado" note present.
