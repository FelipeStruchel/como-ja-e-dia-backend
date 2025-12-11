import { Worker } from "bullmq";

const queueName = process.env.INCOMING_QUEUE_NAME || "incoming-messages";
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

export function startIncomingConsumer(processor) {
    const worker = new Worker(
        queueName,
        async (job) => {
            const payload = job.data || {};
            await processor(payload);
        },
        { connection }
    );

    worker.on("failed", (job, err) => {
        // eslint-disable-next-line no-console
        console.error(`[incoming-worker] Job ${job?.id} failed: ${err?.message}`);
    });

    return worker;
}
