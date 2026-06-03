# Design: `!forcespawn`

**Data:** 2026-05-03  
**Status:** Aprovado

## Resumo

Novo comando `!forcespawn` que força o spawn de um Pokémon selvagem no grupo. Quem o usa não pode capturar o Pokémon por 5 minutos (para dar chance aos outros). Possui cooldown individual de 24h e limite de 5 usos por grupo por dia.

---

## Fluxo completo

### 1. Usuário digita `!forcespawn`

O `handleForcespawnCommand` no backend executa as checagens em ordem:

1. **Drop ativo**: verifica `drop:active:{groupId}` no Redis. Se existir → responde "Já tem um Pokémon selvagem por aí! Aguarda ele ser capturado primeiro." e para.
2. **Cooldown do usuário**: verifica `forcespawn:user:{groupId}:{authorJid}` no Redis. Se existir → responde "Você já usou !forcespawn hoje. Pode usar novamente em X horas e Y minutos." (usa `TTL` da chave para calcular) e para.
3. **Limite do grupo**: verifica sorted set `forcespawn:group:{groupId}` no Redis. Conta membros com score ≥ `now - 86400000`. Se ≥ 5 → responde "O grupo já convocou 5 Pokémons hoje. Próxima convocação disponível em X horas e Y minutos." (score do 5º elemento mais antigo determina quando vaga) e para.
4. **Confirmação pendente**: armazena `forcespawn:pending:{groupId}:{authorJid}` no Redis com TTL de 60s e responde:  
   _"⚠️ Você não poderá capturar este Pokémon por 5 minutos. Responda *!confirmar* para convocar, ou ignore para cancelar."_

### 2. Usuário digita `!confirmar`

O `handleConfirmarCommand` checa `forcespawn:pending:{groupId}:{authorJid}` **antes** de checar `trade:confirming`. Se a chave existir:

1. `GETDEL forcespawn:pending:{groupId}:{authorJid}`
2. Registra cooldowns:
   - `SET forcespawn:user:{groupId}:{authorJid} {usedAt} EX 86400`
   - `ZADD forcespawn:group:{groupId} {now} {authorJid}:{now}`
3. Chama `executeDrop(groupId, { spawnedBy: authorJid, spawnerUnlocksAt: now + 300_000 })`
4. O cooldown **só é cobrado após confirmação** — tentativas que expiram sem confirmar não custam nada.

### 3. `executeDrop` com opção `spawnedBy`

Assinatura atualizada:
```ts
export async function executeDrop(
  groupId: string,
  options?: { spawnedBy?: string; spawnerUnlocksAt?: number }
): Promise<void>
```

O payload salvo no Redis `drop:active:{groupId}` passa a incluir os campos opcionais:
```json
{
  "dropId": "...",
  "pokemonId": 42,
  "spawnedBy": "5511999999999@lid",
  "spawnerUnlocksAt": 1746300000000
}
```

---

## Lockout na captura (worker)

O `reactionHandler.ts` já faz `GETDEL drop:active:{groupId}` de forma atômica. Após o parse do payload:

```
se active.spawnedBy === reactorJid E Date.now() < active.spawnerUnlocksAt:
  1. remainingTtl = Math.max(1, Math.ceil((active.expiresAt - Date.now()) / 1000))
  2. SET drop:active:{groupId} <raw> EX <remainingTtl>
  3. POST /drops/spawner-blocked { groupId, reactorJid, unlocksAt: active.spawnerUnlocksAt }
  4. return (não chama /drops/capture)
```

O payload do `drop:active` passa a incluir `expiresAt` (timestamp ms = momento do drop + `ACTIVE_TTL_SEC * 1000`) para que o worker possa restaurar o TTL com precisão sem precisar de outro lookup.

### Endpoint `/drops/spawner-blocked`

Novo endpoint no backend (mesmo token `x-drop-token`):

```
POST /drops/spawner-blocked
{ groupId, reactorJid, unlocksAt }
```

Calcula minutos restantes e enfileira no grupo:
> "⏳ @X, você convocou este Pokémon! Aguarda Y minutos antes de poder capturá-lo."

---

## Redis — chaves utilizadas

| Chave | Tipo | TTL | Conteúdo |
|---|---|---|---|
| `drop:active:{groupId}` | string (JSON) | 900s | payload do drop ativo (existente, expandido) |
| `forcespawn:pending:{groupId}:{jid}` | string | 60s | `"1"` (existência é o sinal) |
| `forcespawn:user:{groupId}:{jid}` | string | 86400s | timestamp ISO da última convocação |
| `forcespawn:group:{groupId}` | sorted set | sem TTL global | score=timestamp(ms), member=`{jid}:{timestamp}` |

O sorted set do grupo não tem TTL global — os membros antigos ficam, mas são ignorados na contagem (filtro por score). Limpeza: `ZREMRANGEBYSCORE forcespawn:group:{groupId} 0 {now-86400000}` executada a cada uso.

---

## Sem mudanças no Prisma/DB

Todos os controles de cooldown e lockout vivem no Redis. O `PokemonDrop` não é alterado.

---

## Mensagens

| Situação | Mensagem |
|---|---|
| Drop ativo no grupo | "Já tem um Pokémon selvagem por aí! Aguarda ele ser capturado primeiro." |
| Cooldown do usuário | "Você já usou !forcespawn hoje. Pode usar novamente em X horas e Y minutos." |
| Limite do grupo | "O grupo já convocou 5 Pokémons hoje. Próxima convocação disponível em X horas e Y minutos." |
| Confirmação solicitada | "⚠️ Você não poderá capturar este Pokémon por 5 minutos. Responda *!confirmar* para convocar, ou ignore para cancelar." |
| Spawner tenta capturar | "⏳ @X, você convocou este Pokémon! Aguarda Y minutos antes de poder capturá-lo." |

---

## `!ajuda` — linha adicionada

```
!forcespawn — convoca um Pokémon selvagem (1x por dia; quem convoca não pode capturar por 5 min; máx 5 por dia no grupo)
```

---

## Arquivos a modificar

| Arquivo | Mudança |
|---|---|
| `types.ts` | Adicionar `ForceSpawn = "forcespawn"` ao enum `CommandType` |
| `handlers/commands.ts` | Adicionar parse de `!forcespawn`, `handleForcespawnCommand`, atualizar `handleConfirmarCommand`, atualizar `!ajuda` |
| `services/dropService.ts` | Adicionar parâmetro `options` a `executeDrop`, incluir `spawnedBy`/`spawnerUnlocksAt`/`expiresAt` no payload Redis |
| `routes/drops.ts` | Adicionar endpoint `POST /drops/spawner-blocked` |
| `como-ja-e-dia-worker/src/reactionHandler.ts` | Checar lockout do spawner após getdel; chamar `/drops/spawner-blocked` se bloqueado |
