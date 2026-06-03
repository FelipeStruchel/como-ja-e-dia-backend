# !forcespawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `!forcespawn` command that triggers an immediate Pokémon spawn, with a 5-minute capture lockout for the invoker, per-user 24h cooldown, and a per-group limit of 5 spawns per day.

**Architecture:** The spawner JID and lockout timestamp are embedded in the `drop:active:{groupId}` Redis payload. The worker's `reactionHandler` checks the lockout after its atomic `getdel`, restoring the key and calling `/drops/spawner-blocked` if the reactor is the blocked spawner. All cooldown state lives in Redis (no DB changes). The confirmation flow reuses `!confirmar` — the handler checks `forcespawn:pending` before the existing trade-confirming check.

**Tech Stack:** TypeScript, ioredis (already in both projects), vitest, BullMQ send queue (via `enqueueSendMessage`).

**Spec:** `docs/specs/2026-05-03-forcespawn-design.md`

---

## File Map

| File | Change |
|---|---|
| `como-ja-e-dia-backend/types.ts` | Add `ForceSpawn` to `CommandType` enum |
| `como-ja-e-dia-backend/services/dropService.ts` | Add `options?` param to `executeDrop`; include `spawnedBy`, `spawnerUnlocksAt`, `expiresAt` in Redis payload |
| `como-ja-e-dia-backend/routes/drops.ts` | Add `POST /drops/spawner-blocked` endpoint |
| `como-ja-e-dia-backend/handlers/commands.ts` | Add `ForceSpawnCommand` type, parse `!forcespawn`, `handleForcespawnCommand`, update `handleConfirmarCommand`, update `!ajuda`, import `executeDrop` |
| `como-ja-e-dia-worker/src/reactionHandler.ts` | Spawner lockout check after `getdel`; call `/drops/spawner-blocked` if blocked |
| `como-ja-e-dia-worker/src/__tests__/reactionHandler.test.ts` | New test cases for spawner lockout |

---

## Task 1: Add `ForceSpawn` to `CommandType` enum

**Files:**
- Modify: `como-ja-e-dia-backend/types.ts`

- [ ] **Step 1: Add the enum value**

Replace the file content:

```ts
export enum CommandType {
  All = "all",
  Analise = "analise",
  Pokemons = "pokemons",
  Galeria = "galeria",
  Give = "give",
  Trade = "trade",
  Aceitar = "aceitar",
  Recusar = "recusar",
  Confirmar = "confirmar",
  Cancelar = "cancelar",
  Ajuda = "ajuda",
  UsageError = "usage_error",
  ForceSpawn = "forcespawn",
}
```

- [ ] **Step 2: Commit**

```bash
cd como-ja-e-dia-backend
git add types.ts
git commit -m "feat: add ForceSpawn to CommandType enum"
```

---

## Task 2: Extend `executeDrop` with spawner options

**Files:**
- Modify: `como-ja-e-dia-backend/services/dropService.ts`

The `drop:active` Redis payload gains three optional fields: `spawnedBy`, `spawnerUnlocksAt`, and `expiresAt`. Normal scheduler drops set only `expiresAt`. Forcespawn drops set all three. The worker uses `expiresAt` to calculate remaining TTL when restoring the key.

- [ ] **Step 1: Update the function signature and Redis SET call**

In `services/dropService.ts`, change line 77 (`export async function executeDrop`) and the `redis.set` call (lines 125–131):

```ts
export async function executeDrop(
  groupId: string,
  options?: { spawnedBy?: string; spawnerUnlocksAt?: number }
): Promise<void> {
```

And replace the `redis.set` block:

```ts
  const expiresAt = Date.now() + DROP_CONFIG.ACTIVE_TTL_SEC * 1000

  await redis.set(
    `drop:active:${groupId}`,
    JSON.stringify({
      dropId: drop.id,
      pokemonId,
      expiresAt,
      ...(options?.spawnedBy
        ? { spawnedBy: options.spawnedBy, spawnerUnlocksAt: options.spawnerUnlocksAt }
        : {}),
    }),
    'EX',
    DROP_CONFIG.ACTIVE_TTL_SEC
  )
```

- [ ] **Step 2: Typecheck backend**

```bash
cd como-ja-e-dia-backend
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add services/dropService.ts
git commit -m "feat: include spawner lockout fields in drop:active Redis payload"
```

---

## Task 3: Add `/drops/spawner-blocked` endpoint

**Files:**
- Modify: `como-ja-e-dia-backend/routes/drops.ts`

The worker calls this endpoint when it detects the spawner trying to capture during lockout. The endpoint enqueues a group message telling them how long they need to wait.

- [ ] **Step 1: Add the endpoint inside `registerDropRoutes`**

Add after the existing `/drops/capture` handler (before the closing `}`):

```ts
  app.post('/drops/spawner-blocked', async (req, res) => {
    const token = req.headers['x-drop-token']
    if (!process.env.DROP_CAPTURE_TOKEN || token !== process.env.DROP_CAPTURE_TOKEN) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    const { groupId, reactorJid, unlocksAt } = req.body as {
      groupId?: string
      reactorJid?: string
      unlocksAt?: number
    }

    if (!groupId || !reactorJid || !unlocksAt) {
      res.status(400).json({ error: 'groupId, reactorJid e unlocksAt são obrigatórios' })
      return
    }

    res.json({ ok: true })

    const secsLeft = Math.max(60, Math.ceil((unlocksAt - Date.now()) / 1000))
    const minsLeft = Math.ceil(secsLeft / 60)
    const number = reactorJid.split('@')[0]
    await enqueueSendMessage({
      type: 'text',
      groupId,
      content: `⏳ @${number}, você convocou este Pokémon! Aguarda ${minsLeft} minuto${minsLeft !== 1 ? 's' : ''} antes de poder capturá-lo.`,
      mentions: [reactorJid],
    })
  })
```

- [ ] **Step 2: Typecheck backend**

```bash
cd como-ja-e-dia-backend
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add routes/drops.ts
git commit -m "feat: add /drops/spawner-blocked endpoint"
```

---

## Task 4: Spawner lockout in `reactionHandler` (with tests)

**Files:**
- Modify: `como-ja-e-dia-worker/src/reactionHandler.ts`
- Modify: `como-ja-e-dia-worker/src/__tests__/reactionHandler.test.ts`

After `getdel`, if the active drop has `spawnedBy` and the reactor matches and is still within `spawnerUnlocksAt`, the worker: (1) restores the Redis key with remaining TTL, (2) calls `/drops/spawner-blocked`, (3) returns without capturing.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `como-ja-e-dia-worker/src/__tests__/reactionHandler.test.ts`, inside `describe('handleReaction', ...)` after the last existing `it(...)`:

```ts
  describe('forcespawn spawner lockout', () => {
    const spawnerJid = 'user1@s.whatsapp.net' // same as validEntry.key.participant
    const now = Date.now()
    const forceDrop = {
      dropId: 'drop-force-1',
      pokemonId: 25,
      messageId: 'msg-abc-123',
      spawnedBy: spawnerJid,
      spawnerUnlocksAt: now + 300_000,
      expiresAt: now + 900_000,
    }

    it('restores key and calls spawner-blocked when spawner reacts during lockout', async () => {
      mockRedis.getdel.mockResolvedValue(JSON.stringify(forceDrop))
      ;(axios.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { ok: true } })

      await handleReaction(mockSock, validEntry)

      expect(mockRedis.set).toHaveBeenCalledWith(
        `drop:active:${groupId}`,
        JSON.stringify(forceDrop),
        'EX',
        expect.any(Number)
      )
      expect(axios.post).toHaveBeenCalledWith(
        'http://backend:3000/drops/spawner-blocked',
        { groupId, reactorJid: spawnerJid, unlocksAt: forceDrop.spawnerUnlocksAt },
        expect.objectContaining({ headers: { 'x-drop-token': 'test-token' } })
      )
      // Must NOT call /drops/capture
      expect(axios.post).not.toHaveBeenCalledWith(
        expect.stringContaining('/drops/capture'),
        expect.anything(),
        expect.anything()
      )
    })

    it('restored TTL is positive and based on expiresAt', async () => {
      const snapNow = Date.now()
      mockRedis.getdel.mockResolvedValue(JSON.stringify({
        ...forceDrop,
        expiresAt: snapNow + 600_000,
      }))
      ;(axios.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { ok: true } })

      await handleReaction(mockSock, validEntry)

      const setCall = (mockRedis.set as ReturnType<typeof vi.fn>).mock.calls[0]
      const ttl = setCall[3]
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(600)
    })

    it('allows capture after spawnerUnlocksAt has passed', async () => {
      const expiredDrop = {
        ...forceDrop,
        spawnerUnlocksAt: Date.now() - 1, // already expired
      }
      mockRedis.getdel.mockResolvedValue(JSON.stringify(expiredDrop))
      ;(axios.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { ok: true } })

      await handleReaction(mockSock, validEntry)

      expect(axios.post).toHaveBeenCalledWith(
        'http://backend:3000/drops/capture',
        expect.objectContaining({ dropId: 'drop-force-1' }),
        expect.anything()
      )
    })

    it('allows non-spawner to capture a forcespawn drop immediately', async () => {
      const otherReactor = {
        ...validEntry,
        key: { ...validEntry.key, participant: 'other-user@s.whatsapp.net' },
      }
      mockRedis.getdel.mockResolvedValue(JSON.stringify(forceDrop))
      ;(axios.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { ok: true } })

      await handleReaction(mockSock, otherReactor)

      expect(axios.post).toHaveBeenCalledWith(
        'http://backend:3000/drops/capture',
        expect.objectContaining({ capturedBy: 'other-user@s.whatsapp.net' }),
        expect.anything()
      )
    })

    it('does not call spawner-blocked for a normal drop without spawnedBy', async () => {
      const normalDrop = { dropId: 'drop-1', pokemonId: 25, messageId: 'msg-abc-123', expiresAt: Date.now() + 900_000 }
      mockRedis.getdel.mockResolvedValue(JSON.stringify(normalDrop))
      ;(axios.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { ok: true } })

      await handleReaction(mockSock, validEntry)

      expect(axios.post).toHaveBeenCalledWith(
        'http://backend:3000/drops/capture',
        expect.anything(),
        expect.anything()
      )
      expect(axios.post).not.toHaveBeenCalledWith(
        expect.stringContaining('spawner-blocked'),
        expect.anything(),
        expect.anything()
      )
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd como-ja-e-dia-worker
npm test
```

Expected: new tests FAIL — `spawner-blocked` is never called yet.

- [ ] **Step 3: Implement spawner lockout in `reactionHandler.ts`**

Update the `ActiveDrop` interface (lines 14–18):

```ts
interface ActiveDrop {
  dropId: string
  pokemonId: number
  messageId?: string
  spawnedBy?: string
  spawnerUnlocksAt?: number
  expiresAt?: number
}
```

Add the spawner lockout block inside `handleReaction`, right after the `active.messageId !== reactedMessageId` check (after line 68, before the `// Esta reação ganhou` comment):

```ts
  // Spawner lockout: who forced the spawn cannot capture for 5 minutes
  if (
    active.spawnedBy &&
    active.spawnerUnlocksAt &&
    active.expiresAt &&
    active.spawnedBy === reactorJid &&
    Date.now() < active.spawnerUnlocksAt
  ) {
    const remainingTtl = Math.max(1, Math.ceil((active.expiresAt - Date.now()) / 1000))
    await redis.set(activeKey, raw, 'EX', remainingTtl)
    try {
      await axios.post(
        `${config.backendUrl}/drops/spawner-blocked`,
        { groupId, reactorJid, unlocksAt: active.spawnerUnlocksAt },
        {
          headers: { 'x-drop-token': config.dropCaptureToken },
          timeout: 10_000,
        }
      )
    } catch (err) {
      log(`Falha ao notificar bloqueio do spawner: ${(err as Error).message}`, 'error')
    }
    return
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd como-ja-e-dia-worker
npm test
```

Expected: ALL tests pass including new ones.

- [ ] **Step 5: Typecheck worker**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/reactionHandler.ts src/__tests__/reactionHandler.test.ts
git commit -m "feat: enforce spawner lockout in reactionHandler for forcespawn drops"
```

---

## Task 5: `!forcespawn` command in `commands.ts`

**Files:**
- Modify: `como-ja-e-dia-backend/handlers/commands.ts`

This task adds: the `ForceSpawnCommand` type, `!forcespawn` parsing, `handleForcespawnCommand` (cooldown checks + confirmation prompt), updates to `handleConfirmarCommand` (check pending forcespawn before trade confirming), and updates to `!ajuda`.

- [ ] **Step 1: Add import for `executeDrop`**

At the top of `handlers/commands.ts`, add after the existing imports:

```ts
import { executeDrop } from '../services/dropService.js'
```

- [ ] **Step 2: Add `ForceSpawnCommand` type and update the `Command` union**

In the type block (around line 60), add:

```ts
type ForceSpawnCommand = { type: CommandType.ForceSpawn }
```

Update the `Command` union to include it:

```ts
type Command =
  | AllCommand | AnaliseCommand | PokemonsCommand | GaleriaCommand
  | GiveCommand | TradeCommand | AceitarCommand | RecusarCommand
  | ConfirmarCommand | CancelarCommand | AjudaCommand | UsageErrorCommand
  | ForceSpawnCommand
```

- [ ] **Step 3: Add `!forcespawn` to `parseCommand`**

In `parseCommand`, after the `!ajuda` line:

```ts
if (lowered === "!forcespawn") return { type: CommandType.ForceSpawn };
```

- [ ] **Step 4: Add `handleForcespawnCommand`**

Add this function after `handleAjudaCommand`:

```ts
  async function handleForcespawnCommand(msg: IncomingMsg): Promise<void> {
    const author = msg.author || ""
    if (!author || !msg.from) return

    const redis = getRedis()

    // Block if there is already an active drop
    const activeDrop = await redis.get(`drop:active:${msg.from}`)
    if (activeDrop) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Já tem um Pokémon selvagem por aí! Aguarda ele ser capturado primeiro.",
        replyTo: msg.id,
      })
      return
    }

    // Per-user 24h cooldown
    const userKey = `forcespawn:user:${msg.from}:${author}`
    const userTtl = await redis.ttl(userKey)
    if (userTtl > 0) {
      const h = Math.floor(userTtl / 3600)
      const m = Math.ceil((userTtl % 3600) / 60)
      const timeStr = h > 0 ? `${h}h e ${m}min` : `${m} minuto${m !== 1 ? "s" : ""}`
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Você já usou !forcespawn hoje. Pode usar novamente em ${timeStr}.`,
        replyTo: msg.id,
      })
      return
    }

    // Per-group limit: 5 per 24h
    const groupKey = `forcespawn:group:${msg.from}`
    const now = Date.now()
    const windowStart = now - 86_400_000
    await redis.zremrangebyscore(groupKey, "-inf", windowStart)
    const groupCount = await redis.zcount(groupKey, windowStart, "+inf")
    if (groupCount >= 5) {
      // Find when the oldest entry within the window exits (freeing a slot)
      const idx = groupCount - 5
      const [member] = await redis.zrange(groupKey, idx, idx)
      let timeStr = "algumas horas"
      if (member) {
        const score = await redis.zscore(groupKey, member)
        if (score) {
          const secsLeft = Math.max(60, Math.ceil((parseInt(score, 10) + 86_400_000 - now) / 1000))
          const h = Math.floor(secsLeft / 3600)
          const m = Math.ceil((secsLeft % 3600) / 60)
          timeStr = h > 0 ? `${h}h e ${m}min` : `${m} minuto${m !== 1 ? "s" : ""}`
        }
      }
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `O grupo já convocou 5 Pokémons hoje. Próxima convocação disponível em ${timeStr}.`,
        replyTo: msg.id,
      })
      return
    }

    // Set pending confirmation (60s TTL — expires silently if ignored)
    const pendingKey = `forcespawn:pending:${msg.from}:${author}`
    await redis.set(pendingKey, "1", "EX", 60)

    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content:
        "⚠️ Você não poderá capturar este Pokémon por 5 minutos. Responda *!confirmar* para convocar, ou ignore para cancelar.",
      replyTo: msg.id,
    })
  }
```

- [ ] **Step 5: Update `handleConfirmarCommand` to check `forcespawn:pending` first**

Replace the entire `handleConfirmarCommand` function body with:

```ts
  async function handleConfirmarCommand(msg: IncomingMsg): Promise<void> {
    const author = msg.author || ""
    if (!author || !msg.from) return

    const redis = getRedis()

    // Forcespawn confirmation takes priority over trade confirming
    const pendingKey = `forcespawn:pending:${msg.from}:${author}`
    const pending = await redis.getdel(pendingKey)
    if (pending) {
      const now = Date.now()
      const spawnerUnlocksAt = now + 300_000

      // Register cooldowns before spawning
      await redis.set(`forcespawn:user:${msg.from}:${author}`, now.toString(), "EX", 86400)
      await redis.zadd(`forcespawn:group:${msg.from}`, now, `${author}:${now}`)

      await executeDrop(msg.from, { spawnedBy: author, spawnerUnlocksAt })

      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `🌟 @${author.split("@")[0]} convocou um Pokémon selvagem! Seja rápido para capturá-lo!`,
        mentions: [author],
        replyTo: msg.id,
      })
      return
    }

    // Existing trade confirming logic
    const confirmKey = `trade:confirming:${msg.from}:${author}`
    const raw = await redis.getdel(confirmKey)
    if (!raw) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Nenhuma troca aguardando sua confirmação.",
        replyTo: msg.id,
      })
      return
    }

    const trade = JSON.parse(raw) as {
      fromJid: string; fromDropIds: string[]; fromPokemonNames: string[]
      toJid: string;   toDropIds: string[];   toPokemonNames: string[]
    }

    await prismaClient.$transaction([
      prismaClient.pokemonDrop.updateMany({
        where: { id: { in: trade.fromDropIds } },
        data: { capturedBy: trade.toJid },
      }),
      prismaClient.pokemonDrop.updateMany({
        where: { id: { in: trade.toDropIds } },
        data: { capturedBy: trade.fromJid },
      }),
    ])

    const fromGot = trade.toPokemonNames.map((n) => `*${n}*`).join(", ")
    const toGot   = trade.fromPokemonNames.map((n) => `*${n}*`).join(", ")
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: `🤝 Troca concluída!\n@${trade.fromJid.split("@")[0]} recebeu ${fromGot}\n@${trade.toJid.split("@")[0]} recebeu ${toGot}`,
      mentions: [trade.fromJid, trade.toJid],
    })
  }
```

- [ ] **Step 6: Update `!ajuda`**

In `handleAjudaCommand`, add the `!forcespawn` line under the `*📋 Geral*` section, after the `!all` line:

```ts
      `!forcespawn — convoca um Pokémon selvagem (1x por dia; quem convoca não pode capturar por 5 min; máx 5 por dia no grupo)`,
```

The full `Geral` block should read:

```ts
      `*📋 Geral*`,
      `!pokemons — lista seus Pokémons capturados`,
      `!galeria — recebe as fotos da sua coleção no PV`,
      `!analise _<n>_ — análise das últimas _n_ mensagens (padrão: 10, máx: 30)`,
      `!all — menciona todo mundo do grupo`,
      `!forcespawn — convoca um Pokémon selvagem (1x por dia; quem convoca não pode capturar por 5 min; máx 5 por dia no grupo)`,
```

- [ ] **Step 7: Add `ForceSpawn` dispatch to `processCommand`**

In the `processCommand` function, add after the `Ajuda` block and before `UsageError`:

```ts
      if (cmd.type === CommandType.ForceSpawn) {
        await handleForcespawnCommand(msg);
        return;
      }
```

- [ ] **Step 8: Typecheck backend**

```bash
cd como-ja-e-dia-backend
npm run typecheck
```

Expected: no errors.

- [ ] **Step 9: Run all backend tests**

```bash
npm test
```

Expected: all existing tests pass.

- [ ] **Step 10: Commit**

```bash
git add handlers/commands.ts
git commit -m "feat: add !forcespawn command with cooldowns, confirmation, and spawner lockout"
```

---

## Task 6: Final typecheck pass

- [ ] **Step 1: Typecheck backend**

```bash
cd como-ja-e-dia-backend
npm run typecheck
```

Expected: no errors.

- [ ] **Step 2: Typecheck worker**

```bash
cd como-ja-e-dia-worker
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run all tests in both repos**

```bash
cd como-ja-e-dia-backend && npm test
cd como-ja-e-dia-worker && npm test
```

Expected: all tests pass.
