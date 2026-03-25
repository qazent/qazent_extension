/**
 * Distributed job lock helpers backed by Redis.
 */

import { randomUUID } from 'crypto';
import * as logger from '../utils/logger';
import {
  JOB_LOCK_HEARTBEAT_INTERVAL_MS,
  JOB_LOCK_TTL_SECONDS,
  jobLockKey
} from '../queue/constants';
import { getRedisClient } from '../queue/redisClient';

const REFRESH_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export interface JobLockHeartbeat {
  stop: () => Promise<void>;
  hasLostLock: () => boolean;
}

export function createJobLockOwnerId(): string {
  return `${process.pid}:${randomUUID()}`;
}

export async function acquireJobLock(jobId: string, ownerId: string): Promise<boolean> {
  const redis = getRedisClient();
  const acquired = await redis.set(jobLockKey(jobId), ownerId, {
    nx: true,
    ex: JOB_LOCK_TTL_SECONDS
  });
  return acquired === 'OK';
}

export async function ownsJobLock(jobId: string, ownerId: string): Promise<boolean> {
  const redis = getRedisClient();
  const currentOwner = await redis.get(jobLockKey(jobId));
  return currentOwner === ownerId;
}

export async function refreshJobLock(jobId: string, ownerId: string): Promise<boolean> {
  const redis = getRedisClient();
  const result = await redis.eval(REFRESH_LOCK_SCRIPT, [jobLockKey(jobId)], [
    ownerId,
    JOB_LOCK_TTL_SECONDS.toString()
  ]) as number;
  return result === 1;
}

export async function releaseJobLock(jobId: string, ownerId: string): Promise<boolean> {
  const redis = getRedisClient();
  const result = await redis.eval(RELEASE_LOCK_SCRIPT, [jobLockKey(jobId)], [ownerId]) as number;
  return result === 1;
}

export function startJobLockHeartbeat(jobId: string, ownerId: string): JobLockHeartbeat {
  let lostLock = false;
  const intervalHandle = setInterval(() => {
    void refreshJobLock(jobId, ownerId)
      .then((refreshed) => {
        if (!refreshed) {
          lostLock = true;
          logger.warn('Job lock heartbeat lost ownership', { jobId, ownerId });
        }
      })
      .catch((error) => {
        logger.warn('Job lock heartbeat refresh failed', {
          jobId,
          ownerId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }, JOB_LOCK_HEARTBEAT_INTERVAL_MS);

  return {
    stop: async () => {
      clearInterval(intervalHandle);
    },
    hasLostLock: () => lostLock
  };
}
