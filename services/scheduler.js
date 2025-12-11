import moment from "moment-timezone";
import cron from "node-cron";
import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { MEDIA_TYPES, getRandomMedia, removeMedia } from "../mediaManager.js";
import { generateAICaption } from "./ai.js";
import { Event } from "../models/event.js";
import { enqueueSendMessage } from "./sendQueue.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_MESSAGE_LENGTH = 4096;

function getLocalDailyVideo(log) {
    try {
        const now = moment();
        const currentHour = now.hour();
        const dailyDir = join(__dirname, "..", "daily_vid");
        const videos = { manha: "bomdia.mp4", noite: "bomnoite.mp4" };

        if (currentHour >= 6 && currentHour < 18) {
            const p = join(dailyDir, videos.manha);
            log?.(`Selecionando vídeo da manhã: ${videos.manha}`, "info");
            if (existsSync(p)) return p;
        }

        const p2 = join(dailyDir, videos.noite);
        log?.(`Selecionando vídeo da noite: ${videos.noite}`, "info");
        if (existsSync(p2)) return p2;

        if (existsSync(dailyDir)) {
            const files = readdirSync(dailyDir).filter((f) =>
                f.toLowerCase().endsWith(".mp4")
            );
            if (files.length > 0) return join(dailyDir, files[0]);
        }

        return null;
    } catch (error) {
        log?.(`Erro ao obter vídeo local: ${error.message}`, "error");
        return null;
    }
}

async function buildCaption(log) {
    let defaultMessage;
    let futureEvents = null;
    let nearestDate = null;
    let nearestIso = null;
    try {
        futureEvents = await Event.find({ date: { $gt: new Date() } })
            .sort({ date: 1 })
            .lean();
        if (futureEvents && futureEvents.length > 0) {
            nearestDate = new Date(futureEvents[0].date);
            nearestIso = nearestDate.toISOString();
            const nearestEvents = futureEvents.filter(
                (e) => new Date(e.date).toISOString() === nearestIso
            );
            const names = nearestEvents.map((e) => e.name).join(" ou ");

            const target = moment.tz(nearestDate, "America/Sao_Paulo");
            const nowSP = moment.tz("America/Sao_Paulo");
            const diffMs = target.diff(nowSP);

            if (diffMs <= 0) {
                defaultMessage = `Eventos do dia: ${names}`;
            } else {
                const totalMinutes = Math.floor(diffMs / (1000 * 60));
                const days = Math.floor(totalMinutes / (60 * 24));
                const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
                const minutes = totalMinutes % 60;

                const parts = [];
                if (days > 0) parts.push(`${days} ${days === 1 ? "dia" : "dias"}`);
                if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hora" : "horas"}`);
                if (minutes > 0)
                    parts.push(`${minutes} ${minutes === 1 ? "minuto" : "minutos"}`);
                let human;
                if (parts.length === 0) human = "menos de 1 minuto";
                else if (parts.length === 1) human = parts[0];
                else if (parts.length === 2) human = parts.join(" e ");
                else human = parts.slice(0, -1).join(", ") + " e " + parts.slice(-1);

                defaultMessage = `Faltam ${human} para ${names} e eu ainda não consigo acreditar que hoje já é dia ${moment().format(
                    "DD"
                )}!`;
            }
        } else {
            defaultMessage =
                "Nenhum evento cadastrado ainda. Cadastre um aqui: https://vmi2849405.contaboserver.net";
        }
    } catch (err) {
        log?.(`Erro ao buscar eventos para legenda: ${err.message}`, "error");
        defaultMessage = "Sem eventos encontrados no momento. Cadastre um novo!";
    }

    try {
        let ai = null;
        if (futureEvents && futureEvents.length > 0) {
            const names = futureEvents
                .filter((e) => new Date(e.date).toISOString() === nearestIso)
                .map((e) => e.name);
            const weekday = moment.tz("America/Sao_Paulo").format("dddd");
            const todayStr = moment.tz("America/Sao_Paulo").format("DD/MM/YYYY");
            const targetSP2 = moment.tz(nearestDate, "America/Sao_Paulo");
            const nowSP2 = moment.tz("America/Sao_Paulo");
            const diffMs2 = targetSP2.diff(nowSP2);
            const totalMin2 = Math.max(0, Math.floor(diffMs2 / (1000 * 60)));
            const cd = {
                days: Math.floor(totalMin2 / (60 * 24)),
                hours: Math.floor((totalMin2 % (60 * 24)) / 60),
                minutes: totalMin2 % 60,
            };
            const nearestDateStr = moment
                .tz(nearestDate, "America/Sao_Paulo")
                .format("DD/MM/YYYY [às] HH:mm");
            ai = await generateAICaption({
                purpose: "greeting",
                names,
                timeStr: moment.tz(nearestDate, "America/Sao_Paulo").format("DD/MM/YYYY HH:mm"),
                noEvents: false,
                dayOfWeek: weekday,
                countdown: cd,
                nearestDateStr,
                todayDateStr: todayStr,
            });
        } else {
            const weekday = moment.tz("America/Sao_Paulo").format("dddd");
            const todayStr = moment.tz("America/Sao_Paulo").format("DD/MM/YYYY");
            ai = await generateAICaption({
                purpose: "greeting",
                names: [],
                noEvents: true,
                dayOfWeek: weekday,
                todayDateStr: todayStr,
            });
        }
        if (ai) defaultMessage = ai;
    } catch (allErr) {
        log?.(`Erro ao processar legenda com AI: ${allErr.message}`, "error");
    }

    return (defaultMessage || "").slice(0, MAX_MESSAGE_LENGTH);
}

async function sendDaily(log) {
    const videoPath = getLocalDailyVideo(log);
    if (!videoPath) {
        log?.("Nenhum vídeo encontrado para enviar", "warning");
        return;
    }

    const groupId =
        process.env.GROUP_ID ||
        process.env.ALLOWED_PING_GROUP ||
        "120363339314665620@g.us";

    const caption = await buildCaption(log);

    await enqueueSendMessage({
        groupId,
        type: "video",
        content: videoPath,
        caption,
    });

    const randomMedia = await getRandomMedia();
    if (randomMedia) {
        const mediaType =
            randomMedia.type === MEDIA_TYPES.TEXT
                ? "mensagem"
                : randomMedia.type === MEDIA_TYPES.IMAGE
                ? "foto"
                : "vídeo";
        const intro = `${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} do dia:`;
        await enqueueSendMessage({
            groupId,
            type: "text",
            content: intro,
        });

        if (randomMedia.type === MEDIA_TYPES.TEXT) {
            await enqueueSendMessage({
                groupId,
                type: "text",
                content: randomMedia.content || "",
            });
        } else {
            await enqueueSendMessage({
                groupId,
                type: randomMedia.type,
                content: randomMedia.path,
            });
        }
        await removeMedia(randomMedia.path);
    }
}

async function processExpiredEvents(log) {
    try {
        const now = new Date();
        const toAnnounce = await Event.find({
            date: { $lte: now },
            announced: false,
        }).sort({ date: 1 });

        if (!toAnnounce.length) return;

        const groupedByDate = toAnnounce.reduce((acc, ev) => {
            const key = new Date(ev.date).toISOString();
            acc[key] = acc[key] || [];
            acc[key].push(ev);
            return acc;
        }, {});

        for (const groupEvents of Object.values(groupedByDate)) {
            const names = groupEvents.map((e) => e.name).join(" e ");
            const timeStr = moment
                .tz(new Date(groupEvents[0].date), "America/Sao_Paulo")
                .format("DD/MM/YYYY [às] HH:mm");
            let message = `É hora do evento ${names}! (${timeStr})`;
            try {
                const weekday2 = moment.tz("America/Sao_Paulo").format("dddd");
                const todayStr2 = moment.tz("America/Sao_Paulo").format("DD/MM/YYYY");
                const aiMsg = await generateAICaption({
                    purpose: "event",
                    names: groupEvents.map((e) => e.name),
                    timeStr,
                    dayOfWeek: weekday2,
                    todayDateStr: todayStr2,
                });
                if (aiMsg) message = aiMsg;
            } catch (aiErr) {
                log?.(
                    `OpenAI announcement failed: ${
                        aiErr && aiErr.message ? aiErr.message : aiErr
                    }`,
                    "info"
                );
            }
            const finalMsg = (message || "").slice(0, MAX_MESSAGE_LENGTH);
            await enqueueSendMessage({
                groupId:
                    process.env.GROUP_ID ||
                    process.env.ALLOWED_PING_GROUP ||
                    "120363339314665620@g.us",
                type: "text",
                content: finalMsg,
            });

            const ids = groupEvents.map((e) => e._id);
            await Event.updateMany(
                { _id: { $in: ids } },
                { $set: { announced: true, announcedAt: new Date() } }
            );
            await Event.deleteMany({ _id: { $in: ids } });
        }
    } catch (err) {
        log?.(`Erro no processamento de eventos expirados: ${err.message}`, "error");
    }
}

export function startDailySchedulers({ log }) {
    const tz = process.env.TZ || "America/Sao_Paulo";

    // Envio diário: Bom dia (06:00) e Boa noite (22:00)
    cron.schedule(
        "0 6 * * *",
        async () => {
            try {
                log?.("Execução agendada: envio diário (bom dia)", "info");
                await sendDaily(log);
            } catch (err) {
                log?.(`Erro ao enviar rotina diária: ${err.message}`, "error");
            }
        },
        { timezone: tz }
    );
    cron.schedule(
        "0 22 * * *",
        async () => {
            try {
                log?.("Execução agendada: envio diário (boa noite)", "info");
                await sendDaily(log);
            } catch (err) {
                log?.(`Erro ao enviar rotina diária: ${err.message}`, "error");
            }
        },
        { timezone: tz }
    );

    // Checagem de eventos expirados a cada 1 minuto
    cron.schedule(
        "* * * * *",
        async () => {
            try {
                await processExpiredEvents(log);
            } catch (err) {
                log?.(`Erro no cron de eventos expirados: ${err.message}`, "error");
            }
        },
        { timezone: tz }
    );

    log?.("Schedulers diários/eventos registrados com node-cron", "info");
}
