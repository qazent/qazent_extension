/**
 * Writes and reads worker results from Redis.
 */

import { StoredJobResult } from '../types';
import * as logger from '../utils/logger';
import {
  JOB_RESULT_TTL_SECONDS,
  jobResultKey
} from '../queue/constants';
import { getRedisClient } from '../queue/redisClient';

function parseStoredJobResult(raw: unknown, key: string): StoredJobResult | null {
  if (typeof raw !== 'string') {
    return null;
  }

  try {
    return JSON.parse(raw) as StoredJobResult;
  } catch (error) {
    logger.error('Failed to parse stored job result', {
      key,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

export async function getStoredJobResult(jobId: string): Promise<StoredJobResult | null> {
  const redis = getRedisClient();
  return parseStoredJobResult(await redis.get(jobResultKey(jobId)), jobResultKey(jobId));
}

export async function writeJobResult(result: StoredJobResult): Promise<StoredJobResult> {
  const redis = getRedisClient();
  const key = jobResultKey(result.jobId);
  const stored = await redis.set(key, JSON.stringify(result), {
    ex: JOB_RESULT_TTL_SECONDS,
    nx: true
  });

  if (stored === 'OK') {
    return result;
  }

  const existing = await getStoredJobResult(result.jobId);
  if (existing !== null) {
    logger.info('Reusing previously stored job result', { jobId: result.jobId, prId: result.prId });
    return existing;
  }

  await redis.set(key, JSON.stringify(result), {
    ex: JOB_RESULT_TTL_SECONDS
  });
  return result;
}
