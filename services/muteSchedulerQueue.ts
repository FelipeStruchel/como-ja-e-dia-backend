import { Queue } from "bullmq";
import { log } from "./logger.js";

const queueName = process.env.MUTE_QUEUE_NAME || "mute-all-groups";
const connection = {
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

const queue = new Queue(queueName, { connection });

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

export function getMuteQueueName(): string {
  return queueName;
}

export async function startMuteScheduler(): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === "mute-all") {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    "mute-all",
    {},
    {
      repeat: { every: SIX_DAYS_MS },
      removeOnComplete: true,
      removeOnFail: 10,
    }
  );

  // Fire once immediately on boot too, so a fresh deploy doesn't wait up to 6 days.
  await queue.add("mute-all", {}, { removeOnComplete: true, removeOnFail: 10 });

  log("Mute scheduler iniciado (renovação a cada 6 dias)", "info");
}
