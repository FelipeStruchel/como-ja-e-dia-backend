import removeAccentsLib from "remove-accents";
import { prisma } from "../services/db.js";
import { getRedis } from "../services/redis.js";
import { enqueueSendMessage } from "../services/sendQueue.js";
import { log } from "../services/logger.js";
import { generateAIAnalysis } from "../services/ai.js";
import { CommandType } from "../types.js"
import { executeDrop } from '../services/dropService.js';

function removeAccents(str: string): string {
  return removeAccentsLib(str || "");
}

interface IncomingMsg {
  body?: string;
  from?: string;
  author?: string;
  id?: string;
  isGroup?: boolean;
  fromMe?: boolean;
  participants?: unknown[];
  mentionedJids?: string[];
  recentMessages?: Array<{
    body?: string;
    type?: string;
    senderName?: string;
    author?: string;
    bodySanitized?: string;
  }>;
}

export function createCommandProcessor({
  log: logFn,
  generateAIAnalysis: analysisFn,
  prisma: prismaClient,
  MAX_MESSAGE_LENGTH,
  ANALYSE_COOLDOWN_SECONDS,
  isDbConnected,
  enqueueSendMessage: enqueueFn,
}: {
  log: typeof log;
  generateAIAnalysis: typeof generateAIAnalysis;
  prisma: typeof prisma;
  MAX_MESSAGE_LENGTH: number;
  ANALYSE_COOLDOWN_SECONDS: number;
  isDbConnected: () => boolean;
  enqueueSendMessage: typeof enqueueSendMessage;
}) {
  const lastAnalyses = new Map<string, number>();
  let lastAllTimestamp = 0;

  function getAllowedGroupId(): string {
    return process.env.ALLOWED_PING_GROUP || "120363339314665620@g.us";
  }

  function isFromAllowedGroup(msg: IncomingMsg): boolean {
    const allowed = getAllowedGroupId();
    return !!(msg && msg.from === allowed);
  }

  type AllCommand      = { type: CommandType.All }
  type AnaliseCommand  = { type: CommandType.Analise; n: number }
  type PokemonsCommand = { type: CommandType.Pokemons }
  type GaleriaCommand  = { type: CommandType.Galeria }
  type GiveCommand     = { type: CommandType.Give;  names: string[] }
  type TradeCommand    = { type: CommandType.Trade; names: string[] }
  type AceitarCommand   = { type: CommandType.Aceitar; names: string[] }
  type RecusarCommand   = { type: CommandType.Recusar }
  type ConfirmarCommand = { type: CommandType.Confirmar }
  type CancelarCommand  = { type: CommandType.Cancelar }
  type AjudaCommand      = { type: CommandType.Ajuda }
  type UsageErrorCommand = { type: CommandType.UsageError; hint: string }
  type ForceSpawnCommand = { type: CommandType.ForceSpawn }
  type Command =
    | AllCommand | AnaliseCommand | PokemonsCommand | GaleriaCommand
    | GiveCommand | TradeCommand | AceitarCommand | RecusarCommand
    | ConfirmarCommand | CancelarCommand | AjudaCommand | UsageErrorCommand
    | ForceSpawnCommand

  function parseCommand(text: string): Command | null {
    const lowered = removeAccents((text || "").trim().toLowerCase());

    if (lowered === "!all" || lowered === "!everyone") return { type: CommandType.All };
    if (lowered === "!pokemons" || lowered === "!pokemon") return { type: CommandType.Pokemons };
    if (lowered === "!galeria")    return { type: CommandType.Galeria };
    if (lowered === "!recusar")    return { type: CommandType.Recusar };
    if (lowered === "!confirmar")  return { type: CommandType.Confirmar };
    if (lowered === "!cancelar")   return { type: CommandType.Cancelar };
    if (lowered === "!ajuda" || lowered === "!help") return { type: CommandType.Ajuda };
    if (lowered === "!forcespawn") return { type: CommandType.ForceSpawn };

    if (lowered.startsWith("!analise")) {
      const parts = lowered.split(/\s+/);
      let n = 10;
      if (parts.length >= 2) {
        const parsed = parseInt(parts[1], 10);
        if (!isNaN(parsed)) n = parsed;
      }
      return { type: CommandType.Analise, n };
    }

    // Target JID comes from contextInfo.mentionedJid (passed as mentionedJids),
    // not from the text — the body may contain a LID instead of a phone number.
    const giveMatch = text.match(/^!give\s+@\S+\s+(.+)$/i);
    if (giveMatch) {
      const names = giveMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length) return { type: CommandType.Give, names };
    }
    if (/^!give(\s|$)/i.test(text)) {
      return { type: CommandType.UsageError, hint: "❌ Uso correto: *!give @pessoa NomePokemon* (separe vários por vírgula)" };
    }

    const tradeMatch = text.match(/^!trade\s+@\S+\s+(.+)$/i);
    if (tradeMatch) {
      const names = tradeMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length) return { type: CommandType.Trade, names };
    }
    if (/^!trade(\s|$)/i.test(text)) {
      return { type: CommandType.UsageError, hint: "❌ Uso correto: *!trade @pessoa NomePokemon* (separe vários por vírgula)" };
    }

    const aceitarMatch = text.match(/^!aceitar\s+(.+)$/i);
    if (aceitarMatch) {
      const names = aceitarMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length) return { type: CommandType.Aceitar, names };
    }
    if (/^!aceitar(\s|$)/i.test(text)) {
      return { type: CommandType.UsageError, hint: "❌ Uso correto: *!aceitar NomePokemon* (o que você dá em troca)" };
    }

    return null;
  }

  const GALERIA_MAX = 20
  const GALERIA_DELAY_MS = 1000
  const TRADE_TTL_SEC = 300

  interface OwnedDrop { dropId: string; pokemonId: number; pokemonName: string }

  async function resolveOwnedDrops(
    ownerJid: string,
    groupId: string,
    names: string[]
  ): Promise<{ owned: OwnedDrop[]; missing: string[] }> {
    const drops = await prismaClient.pokemonDrop.findMany({
      where: { capturedBy: ownerJid, groupId, capturedAt: { not: null } },
    })
    const pokemonIds = drops.map((d) => d.pokemonId)
    const caches = await prismaClient.pokemonCache.findMany({
      where: { id: { in: pokemonIds } },
      select: { id: true, name: true },
    })
    const dropByPokemonId = new Map(drops.map((d) => [d.pokemonId, d]))

    const owned: OwnedDrop[] = []
    const missing: string[] = []
    for (const name of names) {
      const cache = caches.find((c) => c.name.toLowerCase() === name.toLowerCase())
      if (!cache) { missing.push(name); continue }
      const drop = dropByPokemonId.get(cache.id)
      if (!drop) { missing.push(name); continue }
      owned.push({ dropId: drop.id, pokemonId: cache.id, pokemonName: cache.name })
    }
    return { owned, missing }
  }

  async function handleAllCommand(msg: IncomingMsg): Promise<void> {
    const allowedGroup = getAllowedGroupId();
    if (!msg.isGroup) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Isso só funciona em grupos, parceiro.",
        replyTo: msg.id,
      });
      return;
    }
    if (msg.from !== allowedGroup) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Comando !all e !everyone restrito a administradores deste grupo.",
        replyTo: msg.id,
      });
      return;
    }
    const ALL_COOLDOWN = parseInt(
      process.env.ANALYSE_ALL_COOLDOWN_SECONDS || "600",
      10
    );
    const nowTs = Date.now();
    if ((nowTs - lastAllTimestamp) / 1000 < ALL_COOLDOWN) {
      const wait = Math.ceil(ALL_COOLDOWN - (nowTs - lastAllTimestamp) / 1000);
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Já teve um ping recentemente. Aguenta mais ${wait} segundos.`,
        replyTo: msg.id,
      });
      return;
    }
    const rawParticipants = msg.participants || [];
    const mentionIds = Array.from(
      new Set(
        rawParticipants
          .map((p): string | null => {
            if (typeof p === "string") return p;
            if (p && typeof p === "object") {
              const obj = p as Record<string, unknown>;
              if (obj._serialized) return String(obj._serialized);
              if (obj.id && typeof obj.id === "object") {
                const id = obj.id as Record<string, unknown>;
                if (id._serialized) return String(id._serialized);
              }
              if (obj.id && typeof obj.id === "string") return obj.id;
            }
            return null;
          })
          .filter((x): x is string => x !== null)
      )
    );
    const maxMentions = 256;
    if (mentionIds.length === 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Não consegui obter a lista de participantes.",
        replyTo: msg.id,
      });
      return;
    }
    if (mentionIds.length > maxMentions) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Esse grupo é gigante (${mentionIds.length} membros). Não vou pingar todo mundo.`,
        replyTo: msg.id,
      });
      return;
    }
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: "@everyone",
      mentions: mentionIds,
    });
    lastAllTimestamp = nowTs;
  }

  function getUserIdForCooldown(msg: IncomingMsg): string {
    if (msg.fromMe) return "bot-self";
    return msg.author || msg.from || "unknown";
  }

  function withinAnalyseCooldown(
    userId: string
  ): { blocked: true; wait: number } | { blocked: false } {
    const now = Date.now();
    const last = lastAnalyses.get(userId) || 0;
    const diffSec = Math.floor((now - last) / 1000);
    if (diffSec < ANALYSE_COOLDOWN_SECONDS) {
      return { blocked: true, wait: ANALYSE_COOLDOWN_SECONDS - diffSec };
    }
    lastAnalyses.set(userId, now);
    return { blocked: false };
  }

  function sanitizeMessagesForAnalysis(msg: IncomingMsg) {
    return Array.isArray(msg.recentMessages)
      ? msg.recentMessages.filter((m) => m && m.body && m.type === "chat")
      : [];
  }

  async function handleAnaliseCommand(msg: IncomingMsg, n: number): Promise<void> {
    if (n > 30) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Tu acha que essa porcaria de IA é de graça? Limite máximo: 30 mensagens.",
        replyTo: msg.id,
      });
      return;
    }
    if (n <= 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Número inválido. Use !analise ou !analise <n> onde n entre 1 e 30.",
        replyTo: msg.id,
      });
      return;
    }
    const userId = getUserIdForCooldown(msg);
    const cd = withinAnalyseCooldown(userId);
    if (cd.blocked) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Aguenta aí, parceiro. Espera mais ${cd.wait} segundos antes de pedir outra análise.`,
        replyTo: msg.id,
      });
      return;
    }

    const sanitized = sanitizeMessagesForAnalysis(msg);
    const toAnalyze = sanitized.slice(-n);
    if (!toAnalyze || toAnalyze.length === 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Não há mensagens suficientes para analisar.",
        replyTo: msg.id,
      });
      return;
    }

    let analysis: string | null = null;
    const start = Date.now();
    try {
      analysis = await analysisFn(toAnalyze);
      if (isDbConnected && isDbConnected()) {
        try {
          await prismaClient.analysisLog.create({
            data: {
              user: userId,
              chatId: msg.from || "",
              requestedN: n,
              analyzedCount: toAnalyze.length,
              messages: toAnalyze.map((m, i) => ({
                idx: i + 1,
                sender: m.senderName || m.author || "desconhecido",
                text: (m.body || "").slice(0, 1000),
              })),
              result: analysis,
              durationMs: Date.now() - start,
            },
          });
        } catch (createErr: unknown) {
          const msg2 = createErr instanceof Error ? createErr.message : String(createErr);
          logFn(`Erro ao salvar AnalysisLog: ${msg2}`, "error");
        }
      }
    } catch (aiErr: unknown) {
      const msg2 = aiErr instanceof Error ? aiErr.message : String(aiErr);
      logFn(`AI analysis error: ${msg2}`, "error");
    }

    if (!analysis) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Hmmm... a IA não colaborou dessa vez.",
        replyTo: msg.id,
      });
      return;
    }
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: (analysis || "").slice(0, MAX_MESSAGE_LENGTH),
      replyTo: msg.id,
    });
  }

  async function handlePokemonsCommand(msg: IncomingMsg): Promise<void> {
    const author = msg.author || ""
    if (!author || !msg.from) return

    const drops = await prismaClient.pokemonDrop.findMany({
      where: { capturedBy: author, groupId: msg.from, capturedAt: { not: null } },
      orderBy: { capturedAt: "desc" },
    })

    if (drops.length === 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Nenhum Pokémon capturado ainda. Fique de olho nos drops! 👀`,
        mentions: [author],
        replyTo: msg.id,
      })
      return
    }

    const pokemonIds = [...new Set(drops.map((d) => d.pokemonId))]
    const caches = await prismaClient.pokemonCache.findMany({
      where: { id: { in: pokemonIds } },
      select: { id: true, name: true },
    })
    const nameMap = new Map(caches.map((c) => [c.id, c.name]))

    const number = author.split("@")[0]
    const header = `🎮 *Pokédex de @${number}* — ${drops.length} capturado${drops.length !== 1 ? "s" : ""}\n`
    const divider = `${"─".repeat(28)}\n`
    const lines = drops.map((d, i) => {
      const name = nameMap.get(d.pokemonId) ?? `#${d.pokemonId}`
      const date = d.capturedAt
        ? `_${d.capturedAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}_`
        : ""
      return `${i + 1}. *${name}*${date ? `  ${date}` : ""}`
    })

    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: header + divider + lines.join("\n"),
      mentions: [author],
    })
  }

  async function handleGaleriaCommand(msg: IncomingMsg): Promise<void> {
    const author = msg.author || ""
    if (!author || !msg.from) return

    const drops = await prismaClient.pokemonDrop.findMany({
      where: { capturedBy: author, groupId: msg.from, capturedAt: { not: null } },
      orderBy: { capturedAt: "desc" },
      take: GALERIA_MAX,
    })

    const number = author.split("@")[0]

    if (drops.length === 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Nenhum Pokémon capturado ainda, @${number}. Fique de olho nos drops! 👀`,
        mentions: [author],
        replyTo: msg.id,
      })
      return
    }

    const pokemonIds = [...new Set(drops.map((d) => d.pokemonId))]
    const caches = await prismaClient.pokemonCache.findMany({
      where: { id: { in: pokemonIds } },
      select: { id: true, name: true, types: true, imageUrl: true },
    })
    const cacheMap = new Map(caches.map((c) => [c.id, c]))

    const total = drops.length
    const hasMore = total === GALERIA_MAX
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: `📬 Enviando${hasMore ? ` os ${GALERIA_MAX} mais recentes d` : " "}a sua coleção no privado, @${number}!`,
      mentions: [author],
      replyTo: msg.id,
    })

    for (let i = 0; i < drops.length; i++) {
      const drop = drops[i]
      const cache = cacheMap.get(drop.pokemonId)
      if (!cache) continue

      const types = cache.types.join(", ")
      const date = drop.capturedAt
        ? drop.capturedAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })
        : "?"
      const caption = [
        `🎮 *${cache.name}*`,
        `🏷️ _${types}_`,
        `📅 _Capturado em ${date}_`,
        `[${i + 1} de ${total}]`,
      ].join("\n")

      await enqueueFn(
        { groupId: author, type: "image", content: cache.imageUrl, caption },
        { delay: i * GALERIA_DELAY_MS }
      )
    }
  }

  async function handleGiveCommand(
    msg: IncomingMsg,
    names: string[]
  ): Promise<void> {
    const author = msg.author || ""
    if (!author || !msg.from) return

    const targetJid = msg.mentionedJids?.[0]
    if (!targetJid) {
      await enqueueFn({ groupId: msg.from, type: "text", content: "Use o @menção do WhatsApp para indicar o destinatário.", replyTo: msg.id })
      return
    }

    if (targetJid === author) {
      await enqueueFn({ groupId: msg.from, type: "text", content: "Você não pode se dar um Pokémon.", replyTo: msg.id })
      return
    }

    const { owned, missing } = await resolveOwnedDrops(author, msg.from, names)
    if (missing.length > 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Pokémon não encontrado na sua coleção: *${missing.join(", ")}*`,
        replyTo: msg.id,
      })
      return
    }

    await prismaClient.pokemonDrop.updateMany({
      where: { id: { in: owned.map((o) => o.dropId) } },
      data: { capturedBy: targetJid },
    })

    const nameList = owned.map((o) => `*${o.pokemonName}*`).join(", ")
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: `✅ @${author.split("@")[0]} deu ${nameList} para @${targetJid.split("@")[0]}!`,
      mentions: [author, targetJid],
    })
  }

  async function handleTradeCommand(
    msg: IncomingMsg,
    names: string[]
  ): Promise<void> {
    const author = msg.author || ""
    if (!author || !msg.from) return

    const targetJid = msg.mentionedJids?.[0]
    if (!targetJid) {
      await enqueueFn({ groupId: msg.from, type: "text", content: "Use o @menção do WhatsApp para indicar com quem quer trocar.", replyTo: msg.id })
      return
    }

    if (targetJid === author) {
      await enqueueFn({ groupId: msg.from, type: "text", content: "Você não pode trocar com você mesmo.", replyTo: msg.id })
      return
    }

    const { owned, missing } = await resolveOwnedDrops(author, msg.from, names)
    if (missing.length > 0) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Pokémon não encontrado na sua coleção: *${missing.join(", ")}*`,
        replyTo: msg.id,
      })
      return
    }

    const redis = getRedis()
    const tradeKey = `trade:pending:${msg.from}:${targetJid}`
    const existing = await redis.get(tradeKey)
    if (existing) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `@${targetJid.split("@")[0]} já tem uma proposta de troca pendente. Aguarda expirar ou ela recusar.`,
        mentions: [targetJid],
        replyTo: msg.id,
      })
      return
    }

    await redis.set(
      tradeKey,
      JSON.stringify({ fromJid: author, dropIds: owned.map((o) => o.dropId), pokemonNames: owned.map((o) => o.pokemonName) }),
      "EX",
      TRADE_TTL_SEC
    )

    const nameList = owned.map((o) => `*${o.pokemonName}*`).join(", ")
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: `🔄 @${author.split("@")[0]} quer trocar ${nameList} com @${targetJid.split("@")[0]}.\n\nResponda *!aceitar NomePokemon* com o que vai dar de volta, ou *!recusar*. Expira em 5 minutos.`,
      mentions: [author, targetJid],
    })
  }

  async function handleAceitarCommand(msg: IncomingMsg, names: string[]): Promise<void> {
    const author = msg.author || ""
    if (!author || !msg.from) return

    const redis = getRedis()
    const pendingKey = `trade:pending:${msg.from}:${author}`
    const raw = await redis.getdel(pendingKey)
    if (!raw) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Nenhuma proposta de troca pendente para você.",
        replyTo: msg.id,
      })
      return
    }

    const proposal = JSON.parse(raw) as { fromJid: string; dropIds: string[]; pokemonNames: string[] }

    const { owned, missing } = await resolveOwnedDrops(author, msg.from, names)
    if (missing.length > 0) {
      await redis.set(pendingKey, raw, "EX", TRADE_TTL_SEC)
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: `Pokémon não encontrado na sua coleção: *${missing.join(", ")}*`,
        replyTo: msg.id,
      })
      return
    }

    // Salva estado aguardando confirmação de A
    const confirmKey = `trade:confirming:${msg.from}:${proposal.fromJid}`
    await redis.set(
      confirmKey,
      JSON.stringify({
        fromJid: proposal.fromJid,
        fromDropIds: proposal.dropIds,
        fromPokemonNames: proposal.pokemonNames,
        toJid: author,
        toDropIds: owned.map((o) => o.dropId),
        toPokemonNames: owned.map((o) => o.pokemonName),
      }),
      "EX",
      TRADE_TTL_SEC
    )

    const offering = proposal.pokemonNames.map((n) => `*${n}*`).join(", ")
    const counterOffer = owned.map((o) => `*${o.pokemonName}*`).join(", ")
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: `⏳ @${author.split("@")[0]} quer dar ${counterOffer} pelo seu ${offering}, @${proposal.fromJid.split("@")[0]}.\n\nConfirme com *!confirmar* ou desista com *!cancelar*.`,
      mentions: [author, proposal.fromJid],
    })
  }

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

  async function handleCancelarCommand(msg: IncomingMsg): Promise<void> {
    const author = msg.author || ""
    if (!author || !msg.from) return

    const redis = getRedis()
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

    const trade = JSON.parse(raw) as { toJid: string; fromPokemonNames: string[] }
    const offering = trade.fromPokemonNames.map((n) => `*${n}*`).join(", ")
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: `❌ @${author.split("@")[0]} desistiu da troca de ${offering}. @${trade.toJid.split("@")[0]}, sua proposta foi recusada.`,
      mentions: [author, trade.toJid],
    })
  }

  async function handleRecusarCommand(msg: IncomingMsg): Promise<void> {
    const author = msg.author || ""
    if (!author || !msg.from) return

    const redis = getRedis()
    const tradeKey = `trade:pending:${msg.from}:${author}`
    const raw = await redis.getdel(tradeKey)
    if (!raw) {
      await enqueueFn({
        groupId: msg.from,
        type: "text",
        content: "Nenhuma proposta de troca pendente para você.",
        replyTo: msg.id,
      })
      return
    }

    const trade = JSON.parse(raw) as { fromJid: string; pokemonNames: string[] }
    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: `❌ @${author.split("@")[0]} recusou a proposta de @${trade.fromJid.split("@")[0]}.`,
      mentions: [author, trade.fromJid],
    })
  }

  async function handleAjudaCommand(msg: IncomingMsg): Promise<void> {
    const texto = [
      `🤖 *Comandos disponíveis*`,
      `${"─".repeat(28)}`,
      ``,
      `*📋 Geral*`,
      `!pokemons — lista seus Pokémons capturados`,
      `!galeria — recebe as fotos da sua coleção no PV`,
      `!analise _<n>_ — análise das últimas _n_ mensagens (padrão: 10, máx: 30)`,
      `!all — menciona todo mundo do grupo`,
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
      `!cancelar — desiste da troca após ver a contra-proposta`,
    ].join("\n")

    await enqueueFn({
      groupId: msg.from,
      type: "text",
      content: texto,
      replyTo: msg.id,
    })
  }

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
    const groupCount = await redis.zcount(groupKey, windowStart + 1, "+inf")
    if (groupCount >= 5) {
      // Find when the oldest entry within the window exits (freeing a slot)
      const [member] = await redis.zrange(groupKey, 0, 0)
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

  return async function processCommand(msg: IncomingMsg): Promise<void> {
    try {
      if (!msg || !msg.body) return;
      if (!isFromAllowedGroup(msg)) return;

      const text = msg.body.trim();
      const cmd = parseCommand(text);
      if (!cmd) return;

      if (cmd.type === CommandType.All) {
        await handleAllCommand(msg);
        return;
      }
      if (cmd.type === CommandType.Analise) {
        await handleAnaliseCommand(msg, cmd.n);
        return;
      }
      if (cmd.type === CommandType.Pokemons) {
        await handlePokemonsCommand(msg);
        return;
      }
      if (cmd.type === CommandType.Galeria) {
        await handleGaleriaCommand(msg);
        return;
      }
      if (cmd.type === CommandType.Give) {
        await handleGiveCommand(msg, cmd.names);
        return;
      }
      if (cmd.type === CommandType.Trade) {
        await handleTradeCommand(msg, cmd.names);
        return;
      }
      if (cmd.type === CommandType.Aceitar) {
        await handleAceitarCommand(msg, cmd.names);
        return;
      }
      if (cmd.type === CommandType.Recusar) {
        await handleRecusarCommand(msg);
        return;
      }
      if (cmd.type === CommandType.Confirmar) {
        await handleConfirmarCommand(msg);
        return;
      }
      if (cmd.type === CommandType.Cancelar) {
        await handleCancelarCommand(msg);
        return;
      }
      if (cmd.type === CommandType.Ajuda) {
        await handleAjudaCommand(msg);
        return;
      }
      if (cmd.type === CommandType.ForceSpawn) {
        await handleForcespawnCommand(msg);
        return;
      }
      if (cmd.type === CommandType.UsageError) {
        await enqueueFn({ groupId: msg.from, type: "text", content: cmd.hint, replyTo: msg.id });
        return;
      }
    } catch (err: unknown) {
      const msg2 = err instanceof Error ? err.message : String(err);
      logFn(`Erro no processor de comando: ${msg2}`, "error");
    }
  };
}
