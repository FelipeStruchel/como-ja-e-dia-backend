import { Redis } from 'ioredis'

let _redis: Redis | null = null

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    })
    _redis.on('error', (err: Error) => {
      console.error('[redis]', err.message)
    })
  }
  return _redis
}
