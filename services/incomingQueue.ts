import { Worker } from "bullmq";

const queueName = process.env.INCOMING_QUEUE_NAME || "incoming-messages";
const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);

const connection =
  redisHost || redisPort
    ? { host: redisHost || "redis", port: redisPort || 6379 }
    : redisUrl
      ? { url: redisUrl }
      : { host: "redis", port: 6379 };

export function startIncomingConsumer(
  processor: (payload: Record<string, unknown>) => Promise<void>
) {
  const worker = new Worker(
    queueName,
    async (job) => {
      const payload = job.data || {};
      await processor(payload);
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    console.error(`[incoming-worker] Job ${job?.id} failed: ${err?.message}`);
  });

  return worker;
}
