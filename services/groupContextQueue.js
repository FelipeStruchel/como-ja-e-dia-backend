import { Queue } from "bullmq";

const queueName = process.env.GROUP_CONTEXT_QUEUE_NAME || "group-context";
const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);

// Prioriza host/port, alinhado com outras filas (send/incoming)
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

export async function enqueueGroupContextJob(groupId) {
    if (!groupId) throw new Error("groupId eh obrigatorio");
    const jobPromise = queue.add(
        "group-context",
        { groupId },
        { removeOnComplete: true, removeOnFail: 50 }
    );

    // Timeout defensivo para evitar request travando se Redis estiver indisponivel
    const timeoutMs = 5000;
    const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Timeout ao enfileirar contexto (Redis indisponivel?)")), timeoutMs)
    );
    return Promise.race([jobPromise, timeout]);
}

export function getGroupContextQueueName() {
    return queueName;
}
