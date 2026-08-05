# Group-scoped Confessions (sub-project 3 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The public anonymous confession form sends to exactly one group the sender picks, instead of broadcasting to every `confessionsEnabled` group at once.

**Architecture:** New public `GET /confessions/groups` lists `{id, name}` for `confessionsEnabled` groups. `POST /confessions` gains a required `groupId`, re-validated server-side against the live `confessionsEnabled` set on every request (never trusts that the client only offered valid options). Cooldown map keys on `` `${ip}:${groupId}` `` instead of `ip` alone. Frontend gets a lightweight `<Select>` (not the heavier admin `GroupPicker`) populated from the new endpoint.

**Tech Stack:** TypeScript, Express, Prisma 7, Vitest, Next.js (pages router), MUI.

## Global Constraints

- Design: `docs/superpowers/specs/2026-08-05-group-scoped-confessions-design.md`.
- Independent of sub-project 2 — no shared code beyond the pre-existing `services/groupService.ts` (`getConfessionsEnabledGroupIds`, unchanged). Can be executed before, after, or interleaved with sub-project 2.
- **The backend never trusts the client's `groupId`.** `POST /confessions` re-checks the submitted `groupId` against `getConfessionsEnabledGroupIds()` on every request — the public picker only listing eligible groups is UX, not the security boundary.
- Backend tests: `npm test` (vitest) from `como-ja-e-dia-backend/`. Frontend: no test runner, verified with `npm run build`.
- Do not touch `routes/groups.ts`, `routes/events.ts`, `routes/schedules.ts`, `routes/persona.ts`, `routes/triggers.ts`, or `middleware/auth.ts` — out of scope here (that's sub-project 2).

---

### Task 1: Backend — `GET /confessions/groups` + group-scoped `POST /confessions`

**Files:**
- Modify: `como-ja-e-dia-backend/routes/confessions.ts`
- Test: `como-ja-e-dia-backend/__tests__/confessionRoutes.test.ts` (new — this route file has no dedicated test today)

**Interfaces:**
- Produces: `GET /confessions/groups` (public) → `Array<{id: string, name: string}>`. `POST /confessions` body becomes `{message: string, groupId: string}`; `400 {error: "Grupo inválido"}` when `groupId` isn't currently `confessionsEnabled`; cooldown now keyed by `` `${ip}:${groupId}` ``. Consumed by Task 2 (frontend).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/confessionRoutes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../utils/ip.js', () => ({ getRequestIp: vi.fn(() => '1.2.3.4') }))
vi.mock('../services/sendQueue.js', () => ({ enqueueSendMessage: vi.fn() }))
vi.mock('../services/groupService.js', () => ({ getConfessionsEnabledGroupIds: vi.fn() }))
vi.mock('../services/db.js', () => ({
  prisma: { group: { findMany: vi.fn() } },
}))

import { getRequestIp } from '../utils/ip.js'
import { enqueueSendMessage } from '../services/sendQueue.js'
import { getConfessionsEnabledGroupIds } from '../services/groupService.js'
import { prisma } from '../services/db.js'
import { registerConfessionRoutes } from '../routes/confessions.js'

function makeApp() {
  const routes: Record<string, unknown[]> = {}
  const app = {
    get: (path: string, ...h: unknown[]) => { routes[`GET ${path}`] = h },
    post: (path: string, ...h: unknown[]) => { routes[`POST ${path}`] = h },
  }
  return { app: app as any, routes }
}

function makeDeps() {
  return { MAX_TEXT_LENGTH: 1000, MAX_MESSAGE_LENGTH: 4096, CONFESSION_COOLDOWN_MINUTES: 5 }
}

function makeReqRes(body: Record<string, unknown>) {
  const req = { body } as any
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any
  return { req, res }
}

beforeEach(() => vi.clearAllMocks())

describe('GET /confessions/groups', () => {
  it('is registered with no auth middleware and returns id+name for confessionsEnabled groups', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    expect(routes['GET /confessions/groups']).toHaveLength(1) // just the handler, no auth middleware
    const handler = routes['GET /confessions/groups'][0] as (req: any, res: any) => Promise<void>
    vi.mocked(prisma.group.findMany).mockResolvedValue([{ id: 'a@g.us', name: 'Grupo A' }] as any)
    const { req, res } = makeReqRes({})
    await handler(req, res)
    expect(prisma.group.findMany).toHaveBeenCalledWith({
      where: { confessionsEnabled: true },
      select: { id: true, name: true },
    })
    expect(res.json).toHaveBeenCalledWith([{ id: 'a@g.us', name: 'Grupo A' }])
  })
})

describe('POST /confessions', () => {
  it('rejects a groupId that is not currently confessionsEnabled', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    const handler = routes['POST /confessions'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getConfessionsEnabledGroupIds).mockResolvedValue(['a@g.us'])
    const { req, res } = makeReqRes({ message: 'oi', groupId: 'b@g.us' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(enqueueSendMessage).not.toHaveBeenCalled()
  })

  it('sends only to the chosen group when it is eligible', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    const handler = routes['POST /confessions'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getConfessionsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])
    const { req, res } = makeReqRes({ message: 'oi', groupId: 'a@g.us' })
    await handler(req, res)
    expect(enqueueSendMessage).toHaveBeenCalledTimes(1)
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'a@g.us', type: 'text' })
    )
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  })

  it('cooldown blocks a second request to the same group but allows a different group immediately', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    const handler = routes['POST /confessions'].at(-1) as (req: any, res: any) => Promise<void>
    vi.mocked(getConfessionsEnabledGroupIds).mockResolvedValue(['a@g.us', 'b@g.us'])

    const first = makeReqRes({ message: 'oi', groupId: 'a@g.us' })
    await handler(first.req, first.res)
    expect(first.res.status).not.toHaveBeenCalledWith(429)

    const secondSameGroup = makeReqRes({ message: 'de novo', groupId: 'a@g.us' })
    await handler(secondSameGroup.req, secondSameGroup.res)
    expect(secondSameGroup.res.status).toHaveBeenCalledWith(429)

    const differentGroup = makeReqRes({ message: 'outro grupo', groupId: 'b@g.us' })
    await handler(differentGroup.req, differentGroup.res)
    expect(differentGroup.res.status).not.toHaveBeenCalledWith(429)
  })

  it('rejects a missing groupId with 400 before ever calling getConfessionsEnabledGroupIds', async () => {
    const { app, routes } = makeApp()
    registerConfessionRoutes(app, makeDeps())
    const handler = routes['POST /confessions'].at(-1) as (req: any, res: any) => Promise<void>
    const { req, res } = makeReqRes({ message: 'oi' })
    await handler(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/confessionRoutes.test.ts`
Expected: FAIL — `GET /confessions/groups` doesn't exist, `POST /confessions` doesn't validate or scope `groupId` yet.

- [ ] **Step 3: Implement**

Replace `routes/confessions.ts` in full:

```ts
import { Express } from "express";
import { getRequestIp } from "../utils/ip.js";
import { enqueueSendMessage } from "../services/sendQueue.js";
import { getConfessionsEnabledGroupIds } from "../services/groupService.js";
import { prisma } from "../services/db.js";

export function registerConfessionRoutes(
  app: Express,
  {
    MAX_TEXT_LENGTH,
    MAX_MESSAGE_LENGTH,
    CONFESSION_COOLDOWN_MINUTES,
  }: {
    MAX_TEXT_LENGTH: number;
    MAX_MESSAGE_LENGTH: number;
    CONFESSION_COOLDOWN_MINUTES: number;
  }
) {
  const lastConfessionByIpAndGroup = new Map<string, number>();

  app.get("/confessions/groups", async (_req, res) => {
    try {
      const groups = await prisma.group.findMany({
        where: { confessionsEnabled: true },
        select: { id: true, name: true },
      });
      res.json(groups);
    } catch (error) {
      console.error("Erro ao listar grupos de confissão:", error);
      res.status(500).json({ error: "Erro ao listar grupos" });
    }
  });

  app.post("/confessions", async (req, res) => {
    try {
      const rawMessage =
        (typeof req.body?.message === "string" && req.body.message) ||
        (typeof req.body?.text === "string" && req.body.text) ||
        "";
      const message = rawMessage.trim();
      const confessionLimit = Math.min(MAX_TEXT_LENGTH, MAX_MESSAGE_LENGTH);

      if (!message) return res.status(400).json({ error: "Mensagem da confissão é obrigatória" });
      if (message.length > confessionLimit) {
        return res.status(400).json({
          error: `A confissão deve ter no máximo ${confessionLimit} caracteres`,
          maxLength: confessionLimit,
        });
      }

      const groupId = typeof req.body?.groupId === "string" ? req.body.groupId.trim() : "";
      if (!groupId) return res.status(400).json({ error: "Grupo inválido" });

      const eligibleGroupIds = await getConfessionsEnabledGroupIds();
      if (!eligibleGroupIds.includes(groupId)) {
        return res.status(400).json({ error: "Grupo inválido" });
      }

      const ip = getRequestIp(req);
      const cooldownKey = `${ip}:${groupId}`;
      const now = Date.now();
      const cooldownMs = CONFESSION_COOLDOWN_MINUTES * 60 * 1000;
      const lastUse = lastConfessionByIpAndGroup.get(cooldownKey) || 0;

      if (cooldownMs > 0 && now - lastUse < cooldownMs) {
        const waitSeconds = Math.ceil((cooldownMs - (now - lastUse)) / 1000);
        res.setHeader("Retry-After", waitSeconds);
        return res.status(429).json({
          error: `Aguarde ${Math.ceil(waitSeconds / 60)} minuto(s) antes de enviar outra confissão para este grupo.`,
          waitSeconds,
        });
      }

      const finalMessage = `Confissão anônima: ${message}`.slice(0, MAX_MESSAGE_LENGTH);
      await enqueueSendMessage({ groupId, type: "text", content: finalMessage });
      lastConfessionByIpAndGroup.set(cooldownKey, now);

      return res.json({ success: true, cooldownMinutes: CONFESSION_COOLDOWN_MINUTES });
    } catch (error) {
      console.error("Erro ao processar confissão:", error);
      return res.status(500).json({ error: "Erro ao enviar confissão" });
    }
  });
}
```

Note the deliberately generic `"Grupo inválido"` for both "no such group" and "flag is off" (per the design — doesn't let a request enumerate which groups exist vs. which have the flag on).

- [ ] **Step 4: Run to verify it passes, then full suite + typecheck**

Run: `cd como-ja-e-dia-backend && npx vitest run __tests__/confessionRoutes.test.ts && npx vitest run __tests__ && npx tsc --noEmit`
Expected: all PASS (same pre-existing unrelated `anilistService.test.ts` failures, nothing new).

- [ ] **Step 5: Commit**

```bash
cd como-ja-e-dia-backend
git add routes/confessions.ts __tests__/confessionRoutes.test.ts
git commit -m "feat: scope confessions to one server-validated group per submission, cooldown per (ip, group)"
```

---

### Task 2: Frontend — group picker on the confessions page

**Files:**
- Modify: `como-ja-e-dia-frontend/lib/apiClient.js`
- Create: `como-ja-e-dia-frontend/pages/api/confessions/groups.js`
- Modify: `como-ja-e-dia-frontend/pages/api/confessions.js` (its `POST` body already passes through unchanged — no edit needed there; the message/groupId pairing is entirely a client-side + backend concern. Confirmed by reading the existing proxy: it forwards `req` wholesale via `proxyJson`, body included, so this file needs no change — skip if verified.)
- Modify: `como-ja-e-dia-frontend/pages/confessions.js`

**Interfaces:**
- Consumes: `GET /confessions/groups` (Task 1).
- Produces: `api.getConfessionGroups(): Promise<Array<{id, name}>>`; `api.sendConfession(groupId, message)` — signature changes from `sendConfession(message)`.

- [ ] **Step 1: Verify the existing proxy route needs no change**

Read `pages/api/confessions.js`. Confirm it forwards the raw request body to the backend without inspecting or reshaping it (`proxyJson(req, res, { path: "/confessions", method: "POST" })` with no body manipulation). If so, no edit is needed there — the new `groupId` field flows through automatically once the client includes it in the JSON body. If the file does something unexpected (unlikely, but verify rather than assume), adjust it to pass `groupId` through.

- [ ] **Step 2: Add the new proxy route**

Create `pages/api/confessions/groups.js`:

```js
import { proxyJson } from "../../../lib/backendApi";

export default async function handler(req, res) {
    if (req.method === "GET") {
        return proxyJson(req, res, { path: "/confessions/groups", method: "GET" });
    }
    res.setHeader("Allow", ["GET"]);
    res.status(405).end("Method Not Allowed");
}
```

(Path depth: `pages/api/confessions/groups.js` sits inside `pages/api/confessions/` — three directory levels below the project root (`pages` → `api` → `confessions`), the same depth as `pages/api/groups/[id].js` (`pages` → `api` → `groups`), which uses `"../../../lib/backendApi"`. Use exactly three `../`, matching `[id].js`'s depth — not `pages/api/groups/discover/index.js`, which is one level deeper (four `../`) because it has an extra `discover/` segment that this file does not.)

- [ ] **Step 3: Update the API client**

In `lib/apiClient.js`, add near the existing `sendConfession`:

```js
    getConfessionGroups: () =>
        fetch("/api/confessions/groups").then(handleResponse),
```

Change `sendConfession` from:

```js
    sendConfession: (message) =>
        fetch("/api/confessions", {
            method: "POST",
            headers: handleHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ message }),
            credentials: "include",
        }).then(handleResponse),
```

to:

```js
    sendConfession: (groupId, message) =>
        fetch("/api/confessions", {
            method: "POST",
            headers: handleHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ groupId, message }),
            credentials: "include",
        }).then(handleResponse),
```

- [ ] **Step 4: Update `pages/confessions.js`**

Read the file in full first (its exact current state was captured during design — reproduced here for reference, but re-read before editing in case it has changed):

```jsx
import { useState } from "react";
import {
    Box, Card, CardContent, Typography, TextField, Button, Alert, Stack,
} from "@mui/material";
import Layout from "../components/Layout";
import { api } from "../lib/apiClient";

const MAX_LENGTH = 1000;

export default function ConfessionsPage() {
    const [text, setText] = useState("");
    const [status, setStatus] = useState({ type: "idle", message: "" });

    const isSending = status.type === "loading";

    async function handleSend(e) {
        e.preventDefault();
        if (!text.trim()) {
            setStatus({ type: "error", message: "Digite a confissão" });
            return;
        }
        if (text.length > MAX_LENGTH) {
            setStatus({ type: "error", message: `Limite de ${MAX_LENGTH} caracteres` });
            return;
        }
        try {
            setStatus({ type: "loading", message: "Enviando..." });
            await api.sendConfession(text.trim());
            setText("");
            setStatus({ type: "success", message: "Confissão enviada" });
        } catch (err) {
            setStatus({ type: "error", message: err?.message || "Erro ao enviar confissão" });
        } finally {
            setTimeout(() => setStatus({ type: "idle", message: "" }), 2000);
        }
    }

    return (
        <Layout title="Confissões Anônimas">
            <Card>
                <CardContent>
                    <Typography variant="body1" sx={{ mb: 2 }}>
                        Envie uma confissão anônima, é realmente anonima!
                    </Typography>
                    <Box component="form" onSubmit={handleSend}>
                        <Stack spacing={2}>
                            <TextField
                                label="Confissão"
                                multiline
                                minRows={5}
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                helperText={`${text.length}/${MAX_LENGTH}`}
                            />
                            <Button type="submit" variant="contained" disabled={isSending}>
                                Enviar confissão
                            </Button>
                        </Stack>
                    </Box>
                    {status.type !== "idle" && status.message && (
                        <Alert severity={status.type === "error" ? "error" : "success"} sx={{ mt: 2 }}>
                            {status.message}
                        </Alert>
                    )}
                </CardContent>
            </Card>
        </Layout>
    );
}
```

Replace it in full with:

```jsx
import { useEffect, useState } from "react";
import {
    Box, Card, CardContent, Typography, TextField, Button, Alert, Stack,
    Select, MenuItem, FormControl, InputLabel,
} from "@mui/material";
import Layout from "../components/Layout";
import { api } from "../lib/apiClient";

const MAX_LENGTH = 1000;

export default function ConfessionsPage() {
    const [text, setText] = useState("");
    const [groups, setGroups] = useState([]);
    const [groupId, setGroupId] = useState("");
    const [loadingGroups, setLoadingGroups] = useState(true);
    const [status, setStatus] = useState({ type: "idle", message: "" });

    const isSending = status.type === "loading";

    useEffect(() => {
        api.getConfessionGroups()
            .then((data) => setGroups(data || []))
            .catch(() => setGroups([]))
            .finally(() => setLoadingGroups(false));
    }, []);

    async function handleSend(e) {
        e.preventDefault();
        if (!groupId) {
            setStatus({ type: "error", message: "Escolha um grupo" });
            return;
        }
        if (!text.trim()) {
            setStatus({ type: "error", message: "Digite a confissão" });
            return;
        }
        if (text.length > MAX_LENGTH) {
            setStatus({ type: "error", message: `Limite de ${MAX_LENGTH} caracteres` });
            return;
        }
        try {
            setStatus({ type: "loading", message: "Enviando..." });
            await api.sendConfession(groupId, text.trim());
            setText("");
            setStatus({ type: "success", message: "Confissão enviada" });
        } catch (err) {
            setStatus({ type: "error", message: err?.message || "Erro ao enviar confissão" });
        } finally {
            setTimeout(() => setStatus({ type: "idle", message: "" }), 2000);
        }
    }

    return (
        <Layout title="Confissões Anônimas">
            <Card>
                <CardContent>
                    <Typography variant="body1" sx={{ mb: 2 }}>
                        Envie uma confissão anônima, é realmente anonima!
                    </Typography>
                    {!loadingGroups && groups.length === 0 && (
                        <Alert severity="info" sx={{ mb: 2 }}>
                            Nenhum grupo está aceitando confissões no momento.
                        </Alert>
                    )}
                    <Box component="form" onSubmit={handleSend}>
                        <Stack spacing={2}>
                            <FormControl size="small" disabled={loadingGroups || groups.length === 0}>
                                <InputLabel id="confession-group-label">Grupo</InputLabel>
                                <Select
                                    labelId="confession-group-label"
                                    label="Grupo"
                                    value={groupId}
                                    onChange={(e) => setGroupId(e.target.value)}
                                >
                                    {groups.map((g) => (
                                        <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>
                                    ))}
                                </Select>
                            </FormControl>
                            <TextField
                                label="Confissão"
                                multiline
                                minRows={5}
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                helperText={`${text.length}/${MAX_LENGTH}`}
                            />
                            <Button type="submit" variant="contained" disabled={isSending || groups.length === 0}>
                                Enviar confissão
                            </Button>
                        </Stack>
                    </Box>
                    {status.type !== "idle" && status.message && (
                        <Alert severity={status.type === "error" ? "error" : "success"} sx={{ mt: 2 }}>
                            {status.message}
                        </Alert>
                    )}
                </CardContent>
            </Card>
        </Layout>
    );
}
```

- [ ] **Step 5: Verify with a production build**

Run: `cd como-ja-e-dia-frontend && npm run build`
Expected: build succeeds, no type/lint errors.

- [ ] **Step 6: Commit**

```bash
cd como-ja-e-dia-frontend
git add lib/apiClient.js pages/api/confessions/groups.js pages/confessions.js
git commit -m "feat: add group picker to the public confessions page"
```

---

## Task Order & Independence

Task 1 (backend) must land before Task 2 (frontend) is functionally testable, but both can be written in either order since Task 2 only fails at *runtime* against an unmigrated backend, not at build time. Fully independent of sub-project 2's tasks.
