# Group-scoped `!ajuda` (sub-project 4 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `!ajuda` stops listing pokemon-related commands in groups where `pokemonEnabled` is off, and gains the previously-undocumented `!pokemon <nome>` line where it's on.

**Architecture:** `handleAjudaCommand` in `handlers/commands.ts` calls the already-imported `isPokemonEnabled(msg.from)` and conditionally assembles the message from three text blocks (always-shown header/general/miru, conditionally-shown pokemon sections, a one-line note when they're hidden) instead of one static string.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Design: `docs/superpowers/specs/2026-08-05-group-scoped-help-design.md`.
- Independent of sub-projects 2 and 3 — touches only `handlers/commands.ts` and its test.
- No new `Group` flag is introduced. `!analise`, `!all`, and the entire Miru section stay unconditional — only the pokemon-related block (three of the four existing sections) becomes conditional.
- Do not change `parseCommand`, the `POKEMON_COMMAND_TYPES` gate, or any command's actual dispatch/execution logic — this plan only changes what `!ajuda` prints.

---

### Task 1: Filter `!ajuda` by `isPokemonEnabled`

**Files:**
- Modify: `como-ja-e-dia-backend/handlers/commands.ts`
- Test: `como-ja-e-dia-backend/__tests__/ajudaCommand.test.ts` (new)

**Interfaces:** none new — `handleAjudaCommand(msg: IncomingMsg): Promise<void>` keeps its existing signature and remains internal to `createCommandProcessor`'s closure, called the same way at its existing dispatch site (`handlers/commands.ts:1261-1262`, unchanged).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/ajudaCommand.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/db.js', () => ({
  prisma: {
    linkedGroup: { findMany: vi.fn().mockResolvedValue([]) },
  },
}))

vi.mock('../services/redis.js', () => ({
  getRedis: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })),
}))

vi.mock('../services/sendQueue.js', () => ({
  enqueueSendMessage: vi.fn(),
}))

vi.mock('../services/miruService.js', () => ({
  consumeRolls: vi.fn(),
  executeMiruDrop: vi.fn(),
  getAlbum: vi.fn(),
  getTopCollectors: vi.fn(),
  resolveGameGroupId: vi.fn(),
  ROLL_ALLOWANCE: 10,
}))

vi.mock('../services/characterSyncService.js', () => ({
  drawRolls: vi.fn(),
  executeRollDrops: vi.fn(),
}))

vi.mock('../services/groupService.js', () => ({
  isGroupRegistered: vi.fn().mockResolvedValue(true),
  isPokemonEnabled: vi.fn(),
}))

vi.mock('../services/logger.js', () => ({ log: vi.fn() }))
vi.mock('../services/ai.js', () => ({ generateAIAnalysis: vi.fn() }))
vi.mock('../services/dropService.js', () => ({ executeDrop: vi.fn() }))
vi.mock('../services/pokemonService.js', () => ({ fetchAndCachePokemon: vi.fn() }))

import { createCommandProcessor } from '../handlers/commands.js'
import { prisma } from '../services/db.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { log } from '../services/logger.js'
import { generateAIAnalysis } from '../services/ai.js'
import { isPokemonEnabled } from '../services/groupService.js'

const ALLOWED_GROUP_ID = '120363339314665620@g.us'

function makeProcessor() {
  return createCommandProcessor({
    log,
    generateAIAnalysis,
    prisma: prisma as any,
    MAX_MESSAGE_LENGTH: 4096,
    ANALYSE_COOLDOWN_SECONDS: 60,
    isDbConnected: () => true,
    enqueueSendMessage,
  })
}

function makeMsg(body: string, from = ALLOWED_GROUP_ID) {
  return {
    body, from, author: '5511999@s.whatsapp.net', id: 'msg1',
    isGroup: true, fromMe: false, participants: [], mentionedJids: [],
  }
}

beforeEach(() => vi.clearAllMocks())

describe('!ajuda', () => {
  it('includes the pokemon sections and !pokemon <nome> when pokemonEnabled is true', async () => {
    vi.mocked(isPokemonEnabled).mockResolvedValue(true)
    const process = makeProcessor()
    await process(makeMsg('!ajuda'))
    const sent = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(sent.content).toContain('!pokemons')
    expect(sent.content).toContain('!give')
    expect(sent.content).toContain('!trade')
    expect(sent.content).toContain('!pokemon <nome>')
    expect(sent.content).not.toContain('desativados neste grupo')
  })

  it('omits the pokemon sections and adds the disabled note when pokemonEnabled is false', async () => {
    vi.mocked(isPokemonEnabled).mockResolvedValue(false)
    const process = makeProcessor()
    await process(makeMsg('!ajuda'))
    const sent = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(sent.content).not.toContain('!pokemons')
    expect(sent.content).not.toContain('!give')
    expect(sent.content).not.toContain('!trade')
    expect(sent.content).not.toContain('!pokemon <nome>')
    expect(sent.content).toContain('desativados neste grupo')
  })

  it('always includes !analise, !all, and the Miru section regardless of pokemonEnabled', async () => {
    vi.mocked(isPokemonEnabled).mockResolvedValue(false)
    const process = makeProcessor()
    await process(makeMsg('!ajuda'))
    const sent = vi.mocked(enqueueSendMessage).mock.calls[0][0] as any
    expect(sent.content).toContain('!analise')
    expect(sent.content).toContain('!all')
    expect(sent.content).toContain('!miru help')
  })

  it('!help is a synonym and behaves identically', async () => {
    vi.mocked(isPokemonEnabled).mockResolvedValue(true)
    const process = makeProcessor()
    await process(makeMsg('!help'))
    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/ajudaCommand.test.ts`
Expected: FAIL — `handleAjudaCommand` currently sends the same static, unconditional text regardless of `isPokemonEnabled`, so the "omits" and "disabled note" assertions fail.

- [ ] **Step 3: Rewrite `handleAjudaCommand`**

In `handlers/commands.ts`, replace the existing `handleAjudaCommand` function (currently at line 872, the one building a single static `texto` array) with:

```ts
  async function handleAjudaCommand(msg: IncomingMsg): Promise<void> {
    const pokemonOn = msg.from ? await isPokemonEnabled(msg.from) : false

    const lines = [
      `🤖 *Comandos disponíveis*`,
      `${"─".repeat(28)}`,
      ``,
      `*📋 Geral*`,
      `!analise _<n>_ — análise das últimas _n_ mensagens (padrão: 10, máx: 30)`,
      `!all — menciona todo mundo do grupo`,
    ]

    if (pokemonOn) {
      lines.push(
        `!pokemons — lista seus Pokémons capturados`,
        `!galeria — recebe as fotos da sua coleção no PV`,
        `!pokemon <nome> — busca informações de qualquer Pokémon`,
        `!forcespawn — convoca um Pokémon selvagem (1x por dia; quem convoca não pode capturar por 5 min; máx 5 por dia no grupo)`,
        ``,
        `*🎁 Transferência*`,
        `!give @numero _Pokemon1, Pokemon2_ — dá um ou mais Pokémons para alguém`,
        ``,
        `*🔄 Troca*`,
        `!trade @numero _Pokemon_ — propõe uma troca`,
        `!aceitar _Pokemon_ — contra-propõe o que você dá de volta`,
        `!confirmar — confirma a troca após ver a contra-proposta`,
        `!recusar — recusa uma proposta recebida`,
        `!cancelar — desiste da troca após ver a contra-proposta`
      )
    } else {
      lines.push(``, `_Recursos de Pokémon estão desativados neste grupo._`)
    }

    lines.push(``, `*🎴 Miru*`, `!miru help — ver comandos do sistema Miru`)

    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: lines.join("\n"),
      replyTo: msg.id,
    })
  }
```

Note the section order changes slightly from the original (`!analise`/`!all` were previously interleaved before the pokemon-only `📋 Geral` items; now they're grouped first since they're the only unconditional `Geral` content) — this is an intentional, harmless reordering, not a functional change to any command's behavior.

- [ ] **Step 4: Run to verify it passes, then full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/ajudaCommand.test.ts && npx vitest run __tests__ && npx tsc --noEmit`
Expected: all PASS (same pre-existing unrelated `anilistService.test.ts` failures, nothing new), no type errors.

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add handlers/commands.ts __tests__/ajudaCommand.test.ts
git commit -m "feat: filter !ajuda's pokemon sections by the group's pokemonEnabled flag"
```

---

## Task Order & Independence

Single task, no dependencies on sub-projects 2 or 3.
