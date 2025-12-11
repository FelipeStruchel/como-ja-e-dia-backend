import { Queue } from "bullmq";

const queueName = process.env.SEND_QUEUE_NAME || "send-messages";
const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);

// Prioriza host/port quando presentes; senão usa URL; senão default "redis"
const connection =
    redisHost || redisPort
        ? { host: redisHost || "redis", port: redisPort || 6379 }
        : redisUrl
          ? { url: redisUrl }
          : { host: "redis", port: 6379 };

const queue = new Queue(queueName, { connection });

export async function enqueueSendMessage(payload, opts = {}) {
    const normalized = {
        groupId:
            payload.groupId ||
            process.env.GROUP_ID ||
            process.env.ALLOWED_PING_GROUP ||
            "120363339314665620@g.us",
        type: payload.type || "text",
        content: payload.content || "",
        caption: payload.caption,
        replyTo: payload.replyTo,
        mentions: payload.mentions || [],
    };
    const jobOpts = {
        attempts: opts.attempts || 3,
        removeOnComplete: true,
        removeOnFail: 50,
        priority: opts.priority,
        delay: opts.delay,
        jobId: opts.idempotencyKey,
    };
    return queue.add("send", normalized, jobOpts);
}

export function getSendQueue() {
    return queue;
}
