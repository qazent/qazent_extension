/**
 * Lazy Upstash Redis client for queue operations.
 */

import { Redis } from '@upstash/redis';
import * as logger from '../utils/logger';
import { getRequiredEnv, validateQueueEnvironment } from '../utils/validateEnv';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (redisClient !== null) {
    return redisClient;
  }

  validateQueueEnvironment();
  const url = getRequiredEnv('UPSTASH_REDIS_URL');
  const token = getRequiredEnv('UPSTASH_REDIS_TOKEN');
  const endpoint = new URL(url);

  redisClient = new Redis({
    url,
    token
  });

  logger.info('Initialized Upstash Redis client', {
    provider: 'upstash',
    host: endpoint.host,
    pathname: endpoint.pathname || '/',
    protocol: endpoint.protocol.replace(':', '')
  });

  return redisClient;
}
