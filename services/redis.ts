import { Redis } from 'ioredis'

let _redis: Redis | null = null

export function getRedis(): Redis {
  if (!_redis) {
    const redisUrl = process.env.REDIS_URL
    const host = process.env.REDIS_HOST || 'redis'
    const port = parseInt(process.env.REDIS_PORT || '6379', 10)
    const options = redisUrl ? { lazyConnect: false } : { host, port }
    _redis = redisUrl ? new Redis(redisUrl) : new Redis(options)
    _redis.on('error', (err: Error) => {
      console.error('[redis]', err.message)
    })
  }
  return _redis
}
