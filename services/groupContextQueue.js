import { Queue } from "bullmq";

const queueName = process.env.GROUP_CONTEXT_QUEUE_NAME || "group-context";
const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";

const connection = redisUrl
    ? { url: redisUrl }
    : { host: redisHost, port: parseInt(redisPort, 10) };

const queue = new Queue(queueName, { connection });

export async function enqueueGroupContextJob(groupId) {
    if (!groupId) throw new Error("groupId eh obrigatorio");
    return queue.add(
        "group-context",
        { groupId },
        { removeOnComplete: true, removeOnFail: 50 }
    );
}

export function getGroupContextQueueName() {
    return queueName;
}
