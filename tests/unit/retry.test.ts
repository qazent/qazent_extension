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
  notifyAzureWithJobResult: jest.fn()
}));
jest.mock('../../src/backend/ado-client', () => ({
  createConnection: jest.fn(),
  fetchPRMetadata: jest.fn()
}));

import {
  DLQ_KEY,
  JOB_QUEUE_KEY,
  JOB_STATUS,
  METRICS_DLQ_KEY,
  METRICS_FAILED_KEY,
  METRICS_RETRIED_KEY,
  jobAttemptsKey,
  jobStatusKey
} from '../../src/backend/queue/constants';
import { runGeminiJob } from '../../src/backend/services/geminiRunner';
import { resetWorkerStateForTests, runWorkerOnce } from '../../src/backend/worker/worker';

describe('worker retry logic', () => {
  beforeEach(() => {
    redis = createRedisTestClient();
    resetWorkerStateForTests();
    jest.clearAllMocks();
  });

  it('requeues retryable failures and increments attempts plus metrics', async () => {
    (runGeminiJob as jest.Mock).mockRejectedValueOnce(new Error('upstream 500 network failure'));
    const { job } = await enqueueTestJob({ jobId: 'job-retry-1' });

    await runWorkerOnce();

    expect(await redis.get(jobAttemptsKey(job.jobId))).toBe(1);
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.queued);
    expect(await redis.lrange(JOB_QUEUE_KEY, 0, -1)).toEqual([job.jobId]);
    expect(await redis.lrange(DLQ_KEY, 0, -1)).toEqual([]);
    expect(await redis.get(METRICS_FAILED_KEY)).toBe(1);
    expect(await redis.get(METRICS_RETRIED_KEY)).toBe(1);
    expect(await redis.get(METRICS_DLQ_KEY)).toBeNull();
  });

  it('moves authorization failures directly to the DLQ without retrying', async () => {
    (runGeminiJob as jest.Mock).mockRejectedValueOnce(new Error('401 unauthorized'));
    const { job } = await enqueueTestJob({ jobId: 'job-retry-2' });

    await runWorkerOnce();

    expect(await redis.get(jobAttemptsKey(job.jobId))).toBe(1);
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.failed);
    expect(await redis.lrange(JOB_QUEUE_KEY, 0, -1)).toEqual([]);
    expect(await redis.lrange(DLQ_KEY, 0, -1)).toEqual([job.jobId]);
    expect(await redis.get(METRICS_FAILED_KEY)).toBe(1);
    expect(await redis.get(METRICS_RETRIED_KEY)).toBeNull();
    expect(await redis.get(METRICS_DLQ_KEY)).toBe(1);
  });
});
