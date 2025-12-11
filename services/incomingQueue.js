import { Worker } from "bullmq";

const queueName = process.env.INCOMING_QUEUE_NAME || "incoming-messages";
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export function startIncomingConsumer(processor) {
    const worker = new Worker(
        queueName,
        async (job) => {
            const payload = job.data || {};
            await processor(payload);
        },
        { connection: { url: redisUrl } }
    );

    worker.on("failed", (job, err) => {
        // eslint-disable-next-line no-console
        console.error(`[incoming-worker] Job ${job?.id} failed: ${err?.message}`);
    });

    return worker;
}
