import { Queue, Worker } from "bullmq";
import moment from "moment-timezone";
import path from "path";
import { prisma } from "./db.js";
import { generateAICaption } from "./ai.js";
import { enqueueSendMessage } from "./sendQueue.js";
import { log } from "./logger.js";
import { getRandomMedia } from "../mediaManager.js";

const connection = {
    host: process.env.REDIS_HOST || "redis",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

const queueName = "scheduled-jobs";
const schedQueue = new Queue(queueName, { connection });

function buildRepeatOpts(schedule) {
    let cron = schedule.cron || "";
    if (!schedule.useCronOverride) {
        const [hh = "06", mm = "00"] = (schedule.time || "06:00").split(":");
        const days =
            Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length
                ? schedule.daysOfWeek.join(",")
                : "*";
        cron = `${mm} ${hh} * * ${days}`;
    }
    return {
        cron,
        tz: schedule.timezone || "America/Sao_Paulo",
        startDate: schedule.startDate || undefined,
        endDate: schedule.endDate || undefined,
    };
}

function resolveGreeting(now) {
    const minutes = now.hours() * 60 + now.minutes();
    if (minutes <= 12 * 60) return "bom dia";
    if (minutes <= 18 * 60) return "boa tarde";
    return "boa noite";
}

async function buildEventsContext(tz) {
    const now = moment.tz(tz);
    const start = now.clone().startOf("day");
    const end = now.clone().endOf("day");

    const eventsToday = await prisma.event.findMany({
        where: { date: { gte: start.toDate(), lte: end.toDate() } },
        orderBy: { date: "asc" },
    });

    const nextEvents = await prisma.event.findMany({
        where: { date: { gt: end.toDate() } },
        orderBy: { date: "asc" },
        take: 1,
    });
    const nextEvent = nextEvents[0] || null;

    const names = eventsToday.map((e) => e.name);
    let eventsTodayDetails = null;
    if (eventsToday.length) {
        eventsTodayDetails = eventsToday
            .map((e) => {
                const m = moment.tz(e.date, tz);
                return `${e.name} às ${m.format("HH:mm")}`;
            })
            .join("; ");
    }

    let nearestDateStr = null;
    let countdown = null;
    if (nextEvent) {
        const m = moment.tz(nextEvent.date, tz);
        names.push(nextEvent.name);
        nearestDateStr = `${nextEvent.name} em ${m.format("DD/MM/YYYY [às] HH:mm")}`;
        const diff = moment.duration(m.diff(now));
        countdown = {
            days: Math.max(0, Math.floor(diff.asDays())),
            hours: diff.hours(),
            minutes: diff.minutes(),
        };
    }

    return {
        names,
        eventsTodayDetails,
        nearestDateStr,
        countdown,
        hasEvents: names.length > 0,
    };
}

export async function clearRepeat(schedule) {
    if (!schedule.repeatJobKey) return;
    try {
        await schedQueue.removeRepeatableByKey(schedule.repeatJobKey);
    } catch (err) {
        log(`Erro ao remover repeatable ${schedule.id}: ${err.message}`, "warn");
    }
}

export async function registerRepeat(schedule) {
    if (!schedule.active) return null;
    const repeat = buildRepeatOpts(schedule);
    const job = await schedQueue.add(
        "run-schedule",
        { scheduleId: schedule.id },
        {
            repeat,
            removeOnComplete: true,
            removeOnFail: 20,
            jobId: `schedule:${schedule.id}`,
        }
    );
    const repeatJobKey = job?.repeatJobKey || "";
    await prisma.schedule.update({
        where: { id: schedule.id },
        data: { repeatJobKey },
    });
    return job;
}

export async function resyncSchedules() {
    const all = await prisma.schedule.findMany();
    for (const sch of all) {
        if (!sch.repeatJobKey) continue;
        try {
            await schedQueue.removeRepeatableByKey(sch.repeatJobKey);
        } catch (_) {}
    }
    const docs = await prisma.schedule.findMany({ where: { active: true } });
    for (const doc of docs) {
        await registerRepeat(doc);
    }
    log(`Resync schedules: ${docs.length} ativos registrados`, "info");
}

function shouldRunToday(schedule, now) {
    if (schedule.startDate && moment(now).isBefore(schedule.startDate)) return false;
    if (schedule.endDate && moment(now).isAfter(schedule.endDate)) return false;
    if (Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length) {
        const dow = moment(now).tz(schedule.timezone || "America/Sao_Paulo").day();
        if (!schedule.daysOfWeek.includes(dow)) return false;
    }
    return true;
}

async function processScheduleJob(scheduleId) {
    const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
    if (!schedule || !schedule.active) return;
    const now = moment.tz(schedule.timezone || "America/Sao_Paulo");
    if (!shouldRunToday(schedule, now)) return;

    const greetingHint = resolveGreeting(now);
    const shouldAnnounceEvents = !!schedule.announceEvents;
    const eventsContext = shouldAnnounceEvents
        ? await buildEventsContext(schedule.timezone || "America/Sao_Paulo")
        : { names: [], eventsTodayDetails: null, nearestDateStr: null, countdown: null, hasEvents: false };

    let caption = null;
    if (schedule.captionMode === "custom") caption = schedule.customCaption || "";
    else if (schedule.captionMode === "auto") {
        try {
            caption = await generateAICaption({
                purpose: "greeting",
                names: eventsContext.names,
                timeStr: eventsContext.eventsTodayDetails,
                announceEvents: shouldAnnounceEvents,
                noEvents: shouldAnnounceEvents ? !eventsContext.hasEvents : null,
                dayOfWeek: now.format("dddd"),
                todayDateStr: now.format("DD/MM/YYYY"),
                personaOverride: schedule.personaPrompt || null,
                eventsTodayDetails: eventsContext.eventsTodayDetails,
                nearestDateStr: eventsContext.nearestDateStr,
                countdown: eventsContext.countdown,
                greetingHint,
            });
        } catch (err) {
            log(`Falha ao gerar caption auto: ${err.message}`, "warn");
        }
    }

    const payloads = [];
    const groupId =
        process.env.GROUP_ID ||
        process.env.ALLOWED_PING_GROUP ||
        "120363339314665620@g.us";
    const mediaUrl = schedule.mediaUrl || "";

    if (schedule.type === "text") {
        payloads.push({ groupId, type: "text", content: schedule.textContent || "" });
    } else {
        payloads.push({
            groupId,
            type: schedule.type,
            content: mediaUrl,
            caption: caption || undefined,
        });
    }

    if (schedule.includeRandomPool !== false) {
        const randomMedia = await getRandomMedia();
        const randomTextRows = await prisma.$queryRaw`
            SELECT * FROM "Phrase" ORDER BY RANDOM() LIMIT 1
        `;
        const randomTextDoc = Array.isArray(randomTextRows) ? randomTextRows[0] : null;
        const candidates = [];
        if (randomMedia) candidates.push({ kind: "media", data: randomMedia });
        if (randomTextDoc) {
            candidates.push({
                kind: "text",
                data: { type: "text", content: randomTextDoc.text || "", id: randomTextDoc.id || null },
            });
        }
        if (candidates.length) {
            const choice = candidates[Math.floor(Math.random() * candidates.length)];
            const isText = choice.kind === "text" || choice.data.type === "text";
            const typeLabel = isText ? "Frase" : choice.data.type === "image" ? "Foto" : "Vídeo";
            if (schedule.includeIntro) {
                payloads.push({ groupId, type: "text", content: `${typeLabel} do dia:` });
            }
            if (isText) {
                payloads.push({
                    groupId,
                    type: "text",
                    content: choice.data.content || "",
                    cleanup: choice.data.id ? { type: "phrase", id: choice.data.id } : undefined,
                });
            } else {
                const baseInternal = (
                    process.env.MEDIA_BASE_URL ||
                    process.env.BACKEND_PUBLIC_URL ||
                    "http://backend:3000"
                ).replace(/\/+$/, "");
                const filename = path.basename(choice.data.path);
                payloads.push({
                    groupId,
                    type: choice.data.type,
                    content: `${baseInternal}/media/${choice.data.type}/${filename}`,
                    cleanup: { type: choice.data.type, filename, scope: "media" },
                });
            }
        }
    }

    for (const p of payloads) {
        await enqueueSendMessage(p);
    }
}

export function startScheduledWorker() {
    const worker = new Worker(
        queueName,
        async (job) => {
            if (job.name !== "run-schedule") return;
            const scheduleId = job.data?.scheduleId;
            if (!scheduleId) return;
            await processScheduleJob(scheduleId);
        },
        { connection }
    );

    worker.on("failed", (job, err) => {
        log(`scheduled job ${job?.id} failed: ${err?.message}`, "error");
    });

    log("Scheduled worker iniciado", "info");
    return worker;
}
