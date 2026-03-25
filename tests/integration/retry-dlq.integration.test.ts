/**
 * @jest-environment node
 */

import { createLoggerMock } from '../utils/logger-mock';
import { createRedisTestClient, RedisTestClient } from '../utils/redis-test-client';
import { enqueueTestJob } from '../utils/queue-test-helpers';

let redis: RedisTestClient;

jest.mock('../../src/backend/queue/redisClient', () => ({
  getRedisClient: jest.fn(() => redis)
}));

jest.mock('../../src/backend/utils/logger', () => createLoggerMock());
jest.mock('../../src/backend/services/geminiRunner', () => ({
  runGeminiJob: jest.fn()
}));
jest.mock('../../src/backend/services/azureNotifier', () => ({
  notifyAzureWithJobResult: jest.fn().mockResolvedValue(undefined)
}));

import { runGeminiJob } from '../../src/backend/services/geminiRunner';
import {
  DLQ_KEY,
  JOB_QUEUE_KEY,
  JOB_STATUS,
  JOB_TTL_FAILED,
  jobAttemptsKey,
  jobErrorKey,
  jobPayloadKey,
  jobStatusKey
} from '../../src/backend/queue/constants';
import { resetWorkerStateForTests, runWorkerOnce } from '../../src/backend/worker/worker';

describe('retry and DLQ integration', () => {
  beforeEach(() => {
    redis = createRedisTestClient();
    resetWorkerStateForTests();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-26T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('moves a repeatedly failing job to the DLQ after five attempts', async () => {
    (runGeminiJob as jest.Mock).mockRejectedValue(new Error('downstream 500'));
    const { job } = await enqueueTestJob({ jobId: 'job-dlq-1', prId: 601 });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await runWorkerOnce();
    }

    expect(await redis.get(jobAttemptsKey(job.jobId))).toBe(5);
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.failed);
    expect(await redis.lrange(JOB_QUEUE_KEY, 0, -1)).toEqual([]);
    expect(await redis.lrange(DLQ_KEY, 0, -1)).toEqual([job.jobId]);
    expect(await redis.get(jobErrorKey(job.jobId))).toEqual(expect.any(String));
    expect(await redis.ttl(jobPayloadKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobPayloadKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_FAILED);
    expect(await redis.ttl(jobStatusKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobStatusKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_FAILED);
    expect(await redis.ttl(jobAttemptsKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobAttemptsKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_FAILED);
    expect(await redis.ttl(jobErrorKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobErrorKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_FAILED);
  });

  it('sends expired-token jobs directly to the DLQ without retrying', async () => {
    const { job } = await enqueueTestJob(
      { jobId: 'job-dlq-2', prId: 602 },
      { expiresAt: Date.now() - 1_000 }
    );

    await runWorkerOnce();

    expect(runGeminiJob).not.toHaveBeenCalled();
    expect(await redis.get(jobAttemptsKey(job.jobId))).toBe(1);
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.failed);
    expect(await redis.lrange(JOB_QUEUE_KEY, 0, -1)).toEqual([]);
    expect(await redis.lrange(DLQ_KEY, 0, -1)).toEqual([job.jobId]);
    expect(String(await redis.get(jobErrorKey(job.jobId)))).toContain('Expired token');
  });
});
