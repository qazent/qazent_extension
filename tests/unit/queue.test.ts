/**
 * @jest-environment node
 */

import { createLoggerMock } from '../utils/logger-mock';
import { createRedisTestClient, RedisTestClient } from '../utils/redis-test-client';
import { createTestAuth, createTestJob } from '../utils/queue-test-helpers';

let redis: RedisTestClient;

jest.mock('../../src/backend/queue/redisClient', () => ({
  getRedisClient: jest.fn(() => redis)
}));

jest.mock('../../src/backend/utils/logger', () => createLoggerMock());

import { enqueuePRJob } from '../../src/backend/queue/enqueue';
import {
  ATTEMPT_DEFAULT,
  JOB_AUTH_TTL_SECONDS,
  JOB_QUEUE_KEY,
  JOB_TOKEN_TTL_SECONDS,
  JOB_TTL_TRANSIENT,
  JOB_STATUS,
  jobAttemptsKey,
  jobAuthKey,
  jobPayloadKey,
  jobStatusKey,
  jobTokenKey
} from '../../src/backend/queue/constants';

describe('queue enqueue', () => {
  beforeEach(() => {
    redis = createRedisTestClient();
  });

  it('persists job payload, status, attempts, token, and pushes to the queue', async () => {
    const job = createTestJob({ jobId: 'job-queue-1' });
    const auth = createTestAuth({ accessToken: 'sdk.jwt.token' });

    await enqueuePRJob(job, auth);

    expect(await redis.get(jobPayloadKey(job.jobId))).toBe(JSON.stringify(job));
    expect(await redis.get(jobAuthKey(job.jobId))).toBe(JSON.stringify(auth));
    expect(await redis.ttl(jobAuthKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobAuthKey(job.jobId))).toBeLessThanOrEqual(JOB_AUTH_TTL_SECONDS);
    expect(await redis.ttl(jobPayloadKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobPayloadKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_TRANSIENT);
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.queued);
    expect(await redis.ttl(jobStatusKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobStatusKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_TRANSIENT);
    expect(await redis.get(jobAttemptsKey(job.jobId))).toBe(ATTEMPT_DEFAULT.toString());
    expect(await redis.ttl(jobAttemptsKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobAttemptsKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_TRANSIENT);
    expect(await redis.get(jobTokenKey(job.jobId))).toBe(auth.accessToken);
    expect(await redis.ttl(jobTokenKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobTokenKey(job.jobId))).toBeLessThanOrEqual(JOB_TOKEN_TTL_SECONDS);
    expect(await redis.lrange(JOB_QUEUE_KEY, 0, -1)).toEqual([job.jobId]);
  });

  it('does not leave partial writes behind when the Redis transaction fails', async () => {
    const job = createTestJob({ jobId: 'job-queue-2' });
    const auth = createTestAuth();
    redis.failNextExecWith(new Error('redis transaction failed'));

    await expect(enqueuePRJob(job, auth)).rejects.toThrow('Failed to enqueue PR job');

    expect(await redis.get(jobPayloadKey(job.jobId))).toBeNull();
    expect(await redis.get(jobAuthKey(job.jobId))).toBeNull();
    expect(await redis.get(jobStatusKey(job.jobId))).toBeNull();
    expect(await redis.get(jobAttemptsKey(job.jobId))).toBeNull();
    expect(await redis.get(jobTokenKey(job.jobId))).toBeNull();
    expect(await redis.lrange(JOB_QUEUE_KEY, 0, -1)).toEqual([]);
  });
});
