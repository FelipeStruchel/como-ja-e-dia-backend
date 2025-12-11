import { Worker } from "bullmq";

const queueName = process.env.INCOMING_QUEUE_NAME || "incoming-messages";
const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";

const connection = redisUrl
    ? { url: redisUrl }
    : { host: redisHost, port: parseInt(redisPort, 10) };

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
