import { Queue } from "bullmq";

const queueName = process.env.SEND_QUEUE_NAME || "send-messages";
const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);

const connection =
  redisHost || redisPort
    ? { host: redisHost || "redis", port: redisPort || 6379 }
    : redisUrl
      ? { url: redisUrl }
      : { host: "redis", port: 6379 };

const queue = new Queue(queueName, { connection });

export interface SendPayload {
  groupId?: string;
  type: "text" | "image" | "video" | "pokemon_drop";
  dropId?: string;
  content: string;
  caption?: string;
  replyTo?: string;
  mentions?: string[];
  cleanup?: { type: string; id?: string; filename?: string; scope?: string };
}

export interface EnqueueOptions {
  attempts?: number;
  priority?: number;
  delay?: number;
  idempotencyKey?: string;
}

export async function enqueueSendMessage(
  payload: SendPayload,
  opts: EnqueueOptions = {}
) {
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
    cleanup: payload.cleanup,
    dropId: payload.dropId,
  };
  const jobOpts = {
    attempts: opts.attempts || 3,
    removeOnComplete: 50,
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
