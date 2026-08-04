import { Queue } from "bullmq";

const queueName = process.env.GROUP_DISCOVERY_QUEUE_NAME || "group-discovery";
const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);

const hasHostPort = !!process.env.REDIS_HOST || !!process.env.REDIS_PORT;
const baseConnection = hasHostPort
  ? { host: redisHost, port: redisPort }
  : redisUrl
    ? { url: redisUrl }
    : { host: "redis", port: 6379 };

const connection = {
  ...baseConnection,
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
};

const queue = new Queue(queueName, { connection });

export async function enqueueGroupDiscoveryJob(): Promise<unknown> {
  const jobPromise = queue.add(
    "group-discovery",
    {},
    { jobId: "group-discovery", removeOnComplete: 20, removeOnFail: 20 }
  );

  const timeoutMs = 5000;
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(
      () => rej(new Error("Timeout ao enfileirar descoberta de grupos (Redis indisponivel?)")),
      timeoutMs
    )
  );
  return Promise.race([jobPromise, timeout]);
}

export function getGroupDiscoveryQueueName(): string {
  return queueName;
}
