/**
 * @jest-environment node
 */

import { createLoggerMock } from '../utils/logger-mock';
import { createRedisTestClient, RedisTestClient } from '../utils/redis-test-client';

let redis: RedisTestClient;

jest.mock('../../src/backend/queue/redisClient', () => ({
  getRedisClient: jest.fn(() => redis)
}));

jest.mock('../../src/backend/utils/logger', () => createLoggerMock());

import {
  JOB_LOCK_HEARTBEAT_INTERVAL_MS,
  JOB_LOCK_TTL_SECONDS,
  jobLockKey
} from '../../src/backend/queue/constants';
import {
  acquireJobLock,
  refreshJobLock,
  releaseJobLock,
  startJobLockHeartbeat
} from '../../src/backend/worker/lock';

describe('worker lock', () => {
  beforeEach(() => {
    redis = createRedisTestClient();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-26T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('acquires the lock once and enforces exclusivity across workers', async () => {
    const firstAcquire = await acquireJobLock('job-lock-1', 'owner-a');
    const secondAcquire = await acquireJobLock('job-lock-1', 'owner-b');

    expect(firstAcquire).toBe(true);
    expect(secondAcquire).toBe(false);
    expect(await redis.get(jobLockKey('job-lock-1'))).toBe('owner-a');
  });

  it('expires locks when the TTL elapses without renewal', async () => {
    await acquireJobLock('job-lock-2', 'owner-a');

    jest.advanceTimersByTime((JOB_LOCK_TTL_SECONDS + 1) * 1000);

    expect(await redis.get(jobLockKey('job-lock-2'))).toBeNull();
  });

  it('renews the lock on heartbeat and only the owner can refresh or release it', async () => {
    await acquireJobLock('job-lock-3', 'owner-a');

    expect(await refreshJobLock('job-lock-3', 'owner-b')).toBe(false);
    expect(await releaseJobLock('job-lock-3', 'owner-b')).toBe(false);
    expect(await redis.get(jobLockKey('job-lock-3'))).toBe('owner-a');

    const heartbeat = startJobLockHeartbeat('job-lock-3', 'owner-a');
    jest.advanceTimersByTime(JOB_LOCK_HEARTBEAT_INTERVAL_MS + 1);
    await Promise.resolve();

    expect(await redis.ttl(jobLockKey('job-lock-3'))).toBeGreaterThan(0);

    await heartbeat.stop();
    jest.advanceTimersByTime((JOB_LOCK_TTL_SECONDS + 1) * 1000);

    expect(await redis.get(jobLockKey('job-lock-3'))).toBeNull();
  });

  it('allows the owner to release the lock explicitly', async () => {
    await acquireJobLock('job-lock-4', 'owner-a');

    expect(await releaseJobLock('job-lock-4', 'owner-a')).toBe(true);
    expect(await redis.get(jobLockKey('job-lock-4'))).toBeNull();
  });
});
