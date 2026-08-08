# Trigger echo-replace response — Design

## Context

Triggers today respond with a fixed canned text/image/video whenever a configured phrase matches (`matchType`: `exact` | `contains` | `regex`). There's no way to build a response that reuses part of the user's own message — e.g. a trigger on "bom dia" that replies "boa noite" but keeps whatever else the person wrote ("bom dia galera!!" → "boa noite galera!!"). The request is for a general, reusable mechanism for this kind of substitution, not a one-off special case.

## Decisions from brainstorming

- **Mechanism:** a new response mode echoes the original message back, replacing only the substring that matched the trigger with a configured replacement. Everything else in the message is preserved as-is.
- **Scope by matchType:** only available for `contains` and `regex`. `exact` means the whole message equals the trigger phrase, so there'd be nothing left to echo — the mode is not offered for `exact` triggers.
- **One pair per trigger:** each trigger still matches on its existing `phrases`/pattern and produces exactly one replacement text, same as today's one-trigger-one-response shape. Multiple independent word-swaps require multiple triggers, not one trigger with a list of pairs.
- **Regex replacement is not capture-group-aware (v1):** the replacement text is used verbatim, no `$1`/`$2` interpolation of regex capture groups. The matched substring (whatever the regex matched, not sub-groups) is what gets replaced.
- **Multiple occurrences in one message:** only the first occurrence of the matched substring is replaced.

## Backend

**`services`/schema:** no migration. Reuses the existing `responseType` enum (`text | image | video`) by adding a fourth value: `echo`. When `responseType === "echo"`, the existing `responseText` field is reinterpreted as the *replacement snippet* rather than the full reply body; `responseMediaUrl` is unused.

**`routes/triggers.ts`:** `parseTriggerPayload` accepts `"echo"` as a valid `responseType`. `validateTriggerPayload` gains a rule: `responseType === "echo"` requires `matchType` to be `"contains"` or `"regex"` — otherwise a 400 (`"O modo eco só funciona com matchType 'contains' ou 'regex'"`).

**`handlers/triggers.ts`:** `buildMatcher` currently returns `(text: string) => boolean`. It changes to return match position info as well (e.g. `{ matched: boolean; start?: number; end?: number }`) for `contains`/`regex`, using the existing normalized-text search (respecting `caseSensitive`/`normalizeAccents`/`wholeWord`) to locate the *first* occurrence.

In `processTrigger`, when `trig.responseType === "echo"`: take the matched `start`/`end` (found against the normalized text) and splice `trig.responseText` into the **original, non-normalized** `msg.body` at that same range, producing the full reply text. Known, accepted limitation: this assumes normalization (accent-stripping via NFD + combining-mark removal, lowercasing) doesn't change the string's character length, which holds for common Portuguese text and ASCII but could misalign on unusual Unicode (rare multi-codepoint emoji, etc.) — not worth the complexity to guard against for this use case.

Other `matchType`/`responseType` combinations and existing behavior (text/image/video canned responses) are unchanged.

## Frontend

**`pages/triggers.js`:** the "Tipo de resposta" select gains a fourth option, "Eco (troca trecho)", value `echo`. It's disabled/hidden whenever the form's `matchType` is `exact` (mirroring the backend rule — never let the UI offer a combination the backend will reject). When `responseType === "echo"` is selected, the response-text field's label/helper text changes to make clear it's the replacement snippet, not the full reply (e.g. "Texto que substitui o trecho encontrado" instead of "Resposta de texto").

## Testing

- `__tests__/triggers.test.ts` (message-handling side): `contains` with text on both sides of the match replaced correctly; `regex` with a dynamic pattern; only the first of multiple occurrences is replaced; `caseSensitive`/`normalizeAccents` combinations still locate the right substring in the original text.
- `__tests__/triggerRoutes.test.ts` (or wherever `validateTriggerPayload` is covered): `responseType: "echo"` + `matchType: "exact"` is rejected with 400; `echo` + `contains`/`regex` is accepted.
- Frontend: manual verification via `npm run build` (no test runner) — confirm the option is hidden for `exact` and the label swap renders.

## Out of scope

- Regex capture-group interpolation (`$1`, `$2`) in the replacement text.
- Multiple phrase→replacement pairs within a single trigger.
- Replacing every occurrence of the matched substring (only the first is replaced).
