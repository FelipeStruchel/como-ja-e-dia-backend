import { Queue, Worker } from "bullmq";
import moment from "moment-timezone";
import path from "path";
import { Schedule } from "../models/schedule.js";
import { generateAICaption } from "./ai.js";
import { enqueueSendMessage } from "./sendQueue.js";
import { log } from "./logger.js";
import { getRandomMedia, removeMedia } from "../mediaManager.js";

const connection = {
    host: process.env.REDIS_HOST || "redis",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

const queueName = "scheduled-jobs";
const schedQueue = new Queue(queueName, { connection });

function buildRepeatOpts(schedule) {
    // monta cron a partir de hora/dia quando não há override
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

export async function clearRepeat(schedule) {
    if (!schedule.repeatJobKey) return;
    try {
        await schedQueue.removeRepeatableByKey(schedule.repeatJobKey);
    } catch (err) {
        log(`Erro ao remover repeatable ${schedule._id}: ${err.message}`, "warn");
    }
}

export async function registerRepeat(schedule) {
    if (!schedule.active) return null;
    const repeat = buildRepeatOpts(schedule);
    const job = await schedQueue.add(
        "run-schedule",
        { scheduleId: schedule._id.toString() },
        {
            repeat,
            removeOnComplete: true,
            removeOnFail: 20,
            jobId: `schedule:${schedule._id}`,
        }
    );
    schedule.repeatJobKey = job?.repeatJobKey || "";
    await schedule.save();
    return job;
}

export async function resyncSchedules() {
    const all = await Schedule.find({}).lean();
    for (const sch of all) {
        if (!sch.repeatJobKey) continue;
        try {
            await schedQueue.removeRepeatableByKey(sch.repeatJobKey);
        } catch (_) {}
    }
    const docs = await Schedule.find({ active: true });
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
    const schedule = await Schedule.findById(scheduleId).lean();
    if (!schedule || !schedule.active) return;
    const now = moment.tz(schedule.timezone || "America/Sao_Paulo");
    if (!shouldRunToday(schedule, now)) return;

    let caption = null;
    if (schedule.captionMode === "custom") caption = schedule.customCaption || "";
    else if (schedule.captionMode === "auto") {
        try {
            caption = await generateAICaption({
                purpose: "greeting",
                names: [],
                timeStr: null,
                noEvents: false,
                dayOfWeek: now.format("dddd"),
                todayDateStr: now.format("DD/MM/YYYY"),
                personaOverride: schedule.personaPrompt || null,
            });
        } catch (err) {
            log(`Falha ao gerar caption auto: ${err.message}`, "warn");
        }
    }

    const payloads = [];

    const mediaUrl = schedule.mediaUrl || schedule.content || "";
    if (schedule.type === "text") {
        payloads.push({
            groupId:
                process.env.GROUP_ID ||
                process.env.ALLOWED_PING_GROUP ||
                "120363339314665620@g.us",
            type: "text",
            content: schedule.textContent || "",
        });
    } else {
        const shouldCleanup =
            schedule.cleanupAfterSend &&
            schedule.endDate &&
            moment(now).isSameOrAfter(schedule.endDate, "day");
        payloads.push({
            groupId:
                process.env.GROUP_ID ||
                process.env.ALLOWED_PING_GROUP ||
                "120363339314665620@g.us",
            type: schedule.type,
            content: mediaUrl,
            caption: caption || undefined,
            cleanup: shouldCleanup
                ? {
                      type: schedule.type,
                      filename: mediaUrl.split("/").pop(),
                      scope: "media",
                  }
                : undefined,
        });
    }

    if (schedule.includeRandomPool !== false) {
        const randomMedia = await getRandomMedia("randomMedia");
        if (randomMedia) {
            const typeLabel =
                randomMedia.type === "text"
                    ? "Frase"
                    : randomMedia.type === "image"
                    ? "Foto"
                    : "Vídeo";
            if (schedule.includeIntro) {
                payloads.push({
                    groupId:
                        process.env.GROUP_ID ||
                        process.env.ALLOWED_PING_GROUP ||
                        "120363339314665620@g.us",
                    type: "text",
                    content: `${typeLabel} do dia:`,
                });
            }

            if (randomMedia.type === "text") {
                payloads.push({
                    groupId:
                        process.env.GROUP_ID ||
                        process.env.ALLOWED_PING_GROUP ||
                        "120363339314665620@g.us",
                    type: "text",
                    content: randomMedia.content || "",
                });
            } else {
                const filename = path.basename(randomMedia.path);
                payloads.push({
                    groupId:
                        process.env.GROUP_ID ||
                        process.env.ALLOWED_PING_GROUP ||
                        "120363339314665620@g.us",
                    type: randomMedia.type,
                    content: randomMedia.path,
                    cleanup: {
                        type: randomMedia.type,
                        filename,
                        scope: "media",
                    },
                });
            }
            await removeMedia(randomMedia.path);
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
