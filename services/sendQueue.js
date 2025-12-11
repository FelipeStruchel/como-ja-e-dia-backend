import { Queue } from "bullmq";

const queueName = process.env.SEND_QUEUE_NAME || "send-messages";
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

const connection = { url: redisUrl };
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
    return queue.add("send", payload, jobOpts);
}

export function getSendQueue() {
    return queue;
}
