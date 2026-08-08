# Trigger echo-replace response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth Trigger `responseType`, `"echo"`, that replies by echoing the original message back with only the matched substring replaced by a configured snippet (e.g. trigger "bom dia" → "boa noite" replies "boa noite galera!!" to "bom dia galera!!").

**Architecture:** No schema change — `responseType` gains a fourth enum value (`echo`) and `responseText` is reinterpreted as the replacement snippet when that value is used. `handlers/triggers.ts`'s matcher is extended to report *where* a trigger matched (not just whether it did), so `processTrigger` can splice the replacement into the original message at that position. `routes/triggers.ts` validates that `echo` is only combined with `matchType` `contains` or `regex` (never `exact`, since nothing would be left to echo). `pages/triggers.js` gets a fourth response-type card, hidden whenever `matchType` is `exact`.

**Tech Stack:** TypeScript, Express, Prisma 7, Vitest, Next.js (pages router), MUI.

## Global Constraints

- Design: `docs/superpowers/specs/2026-08-08-trigger-echo-response-design.md`.
- Only the first occurrence of the matched substring is replaced, even if it appears more than once in the message.
- No regex capture-group interpolation (`$1`, `$2`) in the replacement text — it's used verbatim.
- One trigger still produces exactly one phrase-match → one replacement; multiple independent word-swaps require multiple triggers.
- Backend tests run with `npm test` (vitest) from `como-ja-e-dia-backend/`. Frontend has no test runner; frontend tasks are verified with `npm run build`.

---

### Task 1: `handlers/triggers.ts` — echo response construction

**Files:**
- Modify: `como-ja-e-dia-backend/handlers/triggers.ts`
- Test: `como-ja-e-dia-backend/__tests__/triggers.test.ts` (extend)

**Interfaces:**
- `buildMatcher`'s return type changes from `(text: string) => boolean` to `(text: string) => MatchResult`, where `MatchResult = { matched: boolean; start?: number; end?: number }`. `start`/`end` are the matched substring's index range within the *normalized* text (same normalization `buildMatcher` already applies internally) for `contains`/`regex`; populated but unused for `exact`. This is internal to `handlers/triggers.ts` — no other file imports `buildMatcher`.
- Produces: when a trigger's `responseType` is `"echo"`, `processTrigger` builds the outgoing message by splicing `trig.responseText` into the incoming `msg.body` at the matched range, keeping everything before and after. For every other `responseType`, behavior is unchanged.

- [ ] **Step 1: Write the failing tests**

Open `__tests__/triggers.test.ts` and add this new `describe` block at the end of the file (after the existing `describe('createTriggerProcessor group scoping', ...)` block, same file, same imports — no new mocks needed):

```ts
describe('createTriggerProcessor echo response', () => {
  beforeEach(() => vi.clearAllMocks())

  it('replaces only the matched substring, keeping the rest of the message (contains)', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'contains',
        wholeWord: false,
        phrases: ['bom dia'],
        responseType: 'echo',
        responseText: 'boa noite',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'bom dia galera!!', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.type).toBe('text')
    expect(call.content).toBe('boa noite galera!!')
  })

  it('replaces the full regex match, keeping text on both sides', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'regex',
        phrases: ['bom d[ia]+'],
        responseType: 'echo',
        responseText: 'boa noite',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'eae bom diaaa pessoal', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.content).toBe('eae boa noite pessoal')
  })

  it('replaces only the first occurrence when the phrase appears more than once', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'contains',
        wholeWord: false,
        phrases: ['oi'],
        responseType: 'echo',
        responseText: 'tchau',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'oi galera oi', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.content).toBe('tchau galera oi')
  })

  it('splices into the original (non-normalized) text even when the match was found case/accent-insensitively', async () => {
    vi.mocked(prisma.trigger.findMany).mockResolvedValue([
      baseTrigger({
        matchType: 'contains',
        wholeWord: false,
        caseSensitive: false,
        normalizeAccents: true,
        phrases: ['cafe'],
        responseType: 'echo',
        responseText: 'com leite',
      }),
    ] as any)
    vi.mocked(isTriggersEnabledForGroup).mockResolvedValue(true)
    const processTrigger = createTriggerProcessor({ log: vi.fn() as any, isDbConnected: () => true })

    await processTrigger({ body: 'quero café gelado', from: 'groupA@g.us', author: 'u1', id: 'm1' })

    const call = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(call.content).toBe('quero com leite gelado')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/triggers.test.ts`
Expected: FAIL — today `responseType: 'echo'` falls through `processTrigger`'s payload-building `if/else` (which only special-cases `"text"`) into the media branch, sending `mediaUrl || trig.responseMediaUrl || ""` (empty string) as `content`, not the spliced text.

- [ ] **Step 3: Implement**

In `handlers/triggers.ts`, replace the `buildMatcher` function (currently the block starting `function buildMatcher(trigger: TriggerRecord): (text: string) => boolean {`) with:

```ts
interface MatchResult {
  matched: boolean;
  start?: number;
  end?: number;
}

function buildMatcher(trigger: TriggerRecord): (text: string) => MatchResult {
  const phrases = trigger.phrases || [];
  const flags = trigger.caseSensitive ? "" : "i";

  return (text: string) => {
    if (!text) return { matched: false };
    const normalizedText = normalize(text, trigger.normalizeAccents, trigger.caseSensitive);
    for (const phrase of phrases) {
      if (!phrase) continue;
      if (trigger.matchType === "regex") {
        const pattern = normalize(phrase, trigger.normalizeAccents, trigger.caseSensitive);
        try {
          const re = new RegExp(pattern, flags);
          const m = re.exec(normalizedText);
          if (m) return { matched: true, start: m.index, end: m.index + m[0].length };
        } catch {
          continue;
        }
      } else if (trigger.matchType === "exact") {
        const needle = normalize(phrase, trigger.normalizeAccents, trigger.caseSensitive);
        if (trigger.wholeWord) {
          const re = new RegExp(`\\b${escapeRegex(needle)}\\b`);
          const m = re.exec(normalizedText);
          if (m) return { matched: true, start: m.index, end: m.index + m[0].length };
        } else {
          if (normalizedText === needle) return { matched: true, start: 0, end: normalizedText.length };
        }
      } else if (trigger.matchType === "contains") {
        const needle = normalize(phrase, trigger.normalizeAccents, trigger.caseSensitive);
        if (trigger.wholeWord) {
          const re = new RegExp(`\\b${escapeRegex(needle)}\\b`);
          const m = re.exec(normalizedText);
          if (m) return { matched: true, start: m.index, end: m.index + m[0].length };
        } else {
          const idx = normalizedText.indexOf(needle);
          if (idx !== -1) return { matched: true, start: idx, end: idx + needle.length };
        }
      }
    }
    return { matched: false };
  };
}

function buildEchoContent(original: string, match: MatchResult, replacement: string): string {
  if (match.start === undefined || match.end === undefined) return replacement;
  return original.slice(0, match.start) + replacement + original.slice(match.end);
}
```

(`escapeRegex` and `normalize` above are unchanged, already defined earlier in the file — only `buildMatcher`'s body and return type change, plus the new `buildEchoContent` helper.)

Then, inside `processTrigger`, change:

```ts
        const matcher = buildMatcher(trig);
        if (!matcher(msg.body || "")) continue;
```

to:

```ts
        const matcher = buildMatcher(trig);
        const match = matcher(msg.body || "");
        if (!match.matched) continue;
```

And change the payload-building block:

```ts
        const payload: Parameters<typeof enqueueSendMessage>[0] = {
          groupId: msg.from,
          type: trig.responseType as "text" | "image" | "video",
          content:
            trig.responseType === "text"
              ? trig.responseText || "(sem texto configurado)"
              : mediaUrl || trig.responseMediaUrl || "",
          caption: trig.responseType === "text" ? undefined : trig.responseText || undefined,
          replyTo: trig.replyMode === "reply" ? msg.id : undefined,
          mentions: trig.mentionSender && msg.author ? [msg.author] : [],
        };
```

to:

```ts
        const isEcho = trig.responseType === "echo";
        const payload: Parameters<typeof enqueueSendMessage>[0] = {
          groupId: msg.from,
          type: (isEcho ? "text" : trig.responseType) as "text" | "image" | "video",
          content:
            trig.responseType === "text"
              ? trig.responseText || "(sem texto configurado)"
              : isEcho
                ? buildEchoContent(msg.body || "", match, trig.responseText || "")
                : mediaUrl || trig.responseMediaUrl || "",
          caption: trig.responseType === "text" || isEcho ? undefined : trig.responseText || undefined,
          replyTo: trig.replyMode === "reply" ? msg.id : undefined,
          mentions: trig.mentionSender && msg.author ? [msg.author] : [],
        };
```

Everything else in `processTrigger` (cooldowns, `chancePercent`, `allowedUsers`, `mediaUrl` resolution above this block) is unchanged — `mediaUrl` is simply not read for the `echo` branch, same as it already isn't for `"text"`.

- [ ] **Step 4: Run to verify it passes, then full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/triggers.test.ts && npx vitest run __tests__ && npx tsc --noEmit`
Expected: `triggers.test.ts` passes (7 tests: 3 existing group-scoping + 4 new echo ones). Full suite and typecheck clean (same pre-existing unrelated `anilistService.test.ts` failures as always, nothing new).

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add handlers/triggers.ts __tests__/triggers.test.ts
git commit -m "feat: add echo response mode to triggers (replaces matched text, keeps the rest)"
```

---

### Task 2: `routes/triggers.ts` — validate `responseType: "echo"`

**Files:**
- Modify: `como-ja-e-dia-backend/routes/triggers.ts`
- Test: `como-ja-e-dia-backend/__tests__/triggerRoutes.test.ts` (extend)

**Interfaces:**
- `parseTriggerPayload` accepts `"echo"` as a valid `responseType` (previously only `"text" | "image" | "video"`).
- `validateTriggerPayload` throws when `responseType === "echo"` and either `responseText` is blank or `matchType !== "contains" && matchType !== "regex"`. Consumed by both `POST /triggers` and `PUT /triggers/:id`, which already call `validateTriggerPayload` — no route-registration changes needed.

- [ ] **Step 1: Write the failing tests**

In `__tests__/triggerRoutes.test.ts`, add this new `describe` block after the existing `describe('PUT /triggers/:id', ...)` block:

```ts
describe('POST /triggers validation', () => {
  it('rejects responseType echo combined with matchType exact', async () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    const handler = routes['POST /triggers'].at(-1) as (req: any, res: any) => Promise<void>
    const req = {
      body: {
        groupId: 'a@g.us',
        phrases: ['bom dia'],
        matchType: 'exact',
        responseType: 'echo',
        responseText: 'boa noite',
      },
    } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(prisma.trigger.create).not.toHaveBeenCalled()
  })

  it('accepts responseType echo combined with matchType contains', async () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    const handler = routes['POST /triggers'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.trigger.create).mockResolvedValue({ id: 't1' } as any)
    const req = {
      body: {
        groupId: 'a@g.us',
        phrases: ['bom dia'],
        matchType: 'contains',
        responseType: 'echo',
        responseText: 'boa noite',
      },
    } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(201)
    const call = vi.mocked(prisma.trigger.create).mock.calls[0][0] as any
    expect(call.data.responseType).toBe('echo')
  })

  it('rejects responseType echo with a blank responseText', async () => {
    const { app, routes } = makeApp()
    registerTriggerRoutes(app)
    const handler = routes['POST /triggers'].at(-1) as (req: any, res: any) => Promise<void>
    const req = {
      body: {
        groupId: 'a@g.us',
        phrases: ['bom dia'],
        matchType: 'contains',
        responseType: 'echo',
        responseText: '   ',
      },
    } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(prisma.trigger.create).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/triggerRoutes.test.ts`
Expected: FAIL — `parseTriggerPayload` currently coerces an unrecognized `responseType` (`"echo"` isn't in today's `["text", "image", "video"]` list) down to `"text"`, so the first test's 400 never happens (it 201s with the wrong `responseType`) and the second test's `call.data.responseType` is `"text"`, not `"echo"`.

- [ ] **Step 3: Implement**

In `routes/triggers.ts`, change:

```ts
  safe.responseType = ["text", "image", "video"].includes(body.responseType as string)
    ? body.responseType
    : "text";
```

to:

```ts
  safe.responseType = ["text", "image", "video", "echo"].includes(body.responseType as string)
    ? body.responseType
    : "text";
```

Then, in `validateTriggerPayload`, right after the existing block:

```ts
  if (payload.responseType === "text" && !(payload.responseText as string).trim()) {
    throw new Error("Resposta de texto é obrigatória para responseType=text");
  }
```

add:

```ts
  if (payload.responseType === "echo" && !(payload.responseText as string).trim()) {
    throw new Error("Texto de substituição é obrigatório para responseType=echo");
  }
  if (payload.responseType === "echo" && payload.matchType !== "contains" && payload.matchType !== "regex") {
    throw new Error("O modo eco só funciona com matchType 'contains' ou 'regex'");
  }
```

- [ ] **Step 4: Run to verify it passes, then full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/triggerRoutes.test.ts && npx vitest run __tests__ && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/triggers.ts __tests__/triggerRoutes.test.ts
git commit -m "feat: validate responseType=echo requires matchType contains/regex and a replacement text"
```

---

### Task 3: `pages/triggers.js` — response-type UI

**Files:**
- Modify: `como-ja-e-dia-frontend/pages/triggers.js`

**Interfaces:**
- Consumes: nothing new — `form.responseType`/`form.matchType` are existing state.
- No API client changes: `api.createTrigger`/`api.updateTrigger` already forward the whole `parsedForm` object, which already includes `responseType`/`responseText` verbatim.

- [ ] **Step 1: Add the "echo" entry to `RESP_TYPES`**

In `pages/triggers.js`, change:

```jsx
const RESP_TYPES = [
    { value: "text",  icon: "💬", label: "Texto" },
    { value: "image", icon: "🖼️", label: "Imagem" },
    { value: "video", icon: "🎬", label: "Vídeo" },
];
```

to:

```jsx
const RESP_TYPES = [
    { value: "text",  icon: "💬", label: "Texto" },
    { value: "image", icon: "🖼️", label: "Imagem" },
    { value: "video", icon: "🎬", label: "Vídeo" },
    { value: "echo",  icon: "🔁", label: "Eco" },
];
```

- [ ] **Step 2: Hide the "Eco" card when `matchType` is `exact`, and reset off it automatically if the user switches to `exact` while it's selected**

In `TriggerForm`, find the response-type card grid:

```jsx
                        <Grid container spacing={1}>
                            {RESP_TYPES.map((rt) => (
                                <Grid item xs={4} key={rt.value}>
```

Change the `.map` call to filter first (still `RESP_TYPES.map`, just filtered — grid sizing `xs={4}` stays a 3-per-row layout since there are at most 4 visible types and it already wraps):

```jsx
                        <Grid container spacing={1}>
                            {RESP_TYPES.filter(
                                (rt) => rt.value !== "echo" || form.matchType !== "exact"
                            ).map((rt) => (
                                <Grid item xs={4} key={rt.value}>
```

Then find the "Tipo de match" `ToggleButtonGroup`'s `onChange` (in the same `TriggerForm` component, above the response section):

```jsx
                        <ToggleButtonGroup
                            value={form.matchType}
                            exclusive
                            onChange={(_, val) => val && setForm((p) => ({ ...p, matchType: val }))}
                            fullWidth
                            size="small"
                            sx={{
                                "& .MuiToggleButton-root": {
                                    textTransform: "none",
                                    fontWeight: 600,
                                    fontSize: 13,
                                    py: 0.75,
                                },
                            }}
                        >
                            <ToggleButton value="exact">Igual</ToggleButton>
```

Change only the `onChange` line:

```jsx
                            onChange={(_, val) =>
                                val &&
                                setForm((p) => ({
                                    ...p,
                                    matchType: val,
                                    responseType:
                                        val === "exact" && p.responseType === "echo"
                                            ? "text"
                                            : p.responseType,
                                }))
                            }
```

- [ ] **Step 3: Add the "echo" content field**

In `TriggerForm`, find the response-content conditional:

```jsx
                    {form.responseType === "text" ? (
                        <TextField
                            label="Texto de resposta"
                            multiline
                            minRows={3}
                            value={form.responseText}
                            onChange={(e) => setForm((p) => ({ ...p, responseText: e.target.value }))}
                            size="small"
                            fullWidth
                        />
                    ) : (
                        <Stack spacing={1}>
```

Insert an `echo` branch between the `text` branch and the media `Stack`:

```jsx
                    {form.responseType === "text" ? (
                        <TextField
                            label="Texto de resposta"
                            multiline
                            minRows={3}
                            value={form.responseText}
                            onChange={(e) => setForm((p) => ({ ...p, responseText: e.target.value }))}
                            size="small"
                            fullWidth
                        />
                    ) : form.responseType === "echo" ? (
                        <TextField
                            label="Texto que substitui o trecho encontrado"
                            multiline
                            minRows={2}
                            value={form.responseText}
                            onChange={(e) => setForm((p) => ({ ...p, responseText: e.target.value }))}
                            size="small"
                            fullWidth
                            helperText="Troca só o trecho que bateu no gatilho; o resto da mensagem original é mantido."
                        />
                    ) : (
                        <Stack spacing={1}>
```

(The closing `)}` after the media `Stack` needs no change — it already closes the ternary/ternary-chain correctly once the middle branch is inserted.)

- [ ] **Step 4: Verify with a production build**

Run: `cd como-ja-e-dia-frontend && npm run build`
Expected: build succeeds, no type/lint errors.

- [ ] **Step 5: Manual check**

Run the dev server (or use the `run` skill) and on `/triggers`: confirm the "Eco" card is absent when "Tipo de match" is "Igual", appears when "Contém" or "Regex" is selected, and selecting it swaps the response-text field's label/helper. Confirm switching "Tipo de match" back to "Igual" while "Eco" is selected snaps `responseType` back to "Texto" (card selection visibly moves).

- [ ] **Step 6: Commit**

```bash
cd como-ja-e-dia-frontend
git add pages/triggers.js
git commit -m "feat: add Eco response-type option to the Triggers admin page"
```

---

## Task Order & Independence

Tasks 1 and 2 both touch the backend and can be done in either order (Task 1's handler change and Task 2's validation change are independent of each other), but both should land before Task 3, so the frontend option is backed by working, validated behavior end-to-end. Task 3 has no code dependency on 1/2 (it only reads/writes `form.responseType`/`matchType` and forwards them as-is) but is meaningless to ship alone.
