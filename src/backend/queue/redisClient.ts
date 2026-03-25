/**
 * Lazy Upstash Redis client for queue operations.
 */

import { Redis } from '@upstash/redis';
import { getRequiredEnv, validateQueueEnvironment } from '../utils/validateEnv';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (redisClient !== null) {
    return redisClient;
  }

  validateQueueEnvironment();
  redisClient = new Redis({
    url: getRequiredEnv('UPSTASH_REDIS_URL'),
    token: getRequiredEnv('UPSTASH_REDIS_TOKEN')
  });

  return redisClient;
}
