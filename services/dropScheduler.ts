// como-ja-e-dia-backend/services/dropScheduler.ts
import { Queue, Worker } from 'bullmq'
import { getRedis } from './redis.js'
import { executeDrop } from './dropService.js'
import { calculateDropProbability, DROP_CONFIG } from './dropConstants.js'
import { log } from './logger.js'

const connection = {
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
}

const dropQueue = new Queue(DROP_CONFIG.QUEUE_NAME, { connection })

export async function startDropScheduler(): Promise<void> {
  const groupId =
    process.env.GROUP_ID ||
    process.env.ALLOWED_PING_GROUP ||
    '120363339314665620@g.us'

  // Remove jobs existentes para evitar duplicatas no restart
  const existing = await dropQueue.getRepeatableJobs()
  for (const job of existing) {
    if (job.name === 'check-drop') {
      await dropQueue.removeRepeatableByKey(job.key)
    }
  }

  await dropQueue.add(
    'check-drop',
    { groupId },
    {
      repeat: { pattern: DROP_CONFIG.CHECK_INTERVAL_CRON },
      removeOnComplete: true,
      removeOnFail: 10,
    }
  )

  const worker = new Worker(
    DROP_CONFIG.QUEUE_NAME,
    async (job) => {
      if (job.name !== 'check-drop') return
      const { groupId } = job.data as { groupId: string }

      const redis = getRedis()
      const activityRaw = await redis.get(`activity:${groupId}`)
      const activityCount = activityRaw ? parseInt(activityRaw, 10) : 0

      const p = calculateDropProbability(activityCount)
      const roll = Math.random()

      log(
        `Drop check: activity=${activityCount} p=${p.toFixed(4)} roll=${roll.toFixed(4)} → ${roll < p ? 'DROPA' : 'passa'}`,
        'info'
      )

      if (roll < p) {
        await executeDrop(groupId)
      }
    },
    { connection }
  )

  worker.on('failed', (job, err) => {
    log(`Drop scheduler job ${job?.id} falhou: ${err.message}`, 'error')
  })

  log('Drop scheduler iniciado', 'info')
}
