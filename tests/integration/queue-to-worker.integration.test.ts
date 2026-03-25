/**
 * @jest-environment node
 */

import { createLoggerMock } from '../utils/logger-mock';
import { createRedisTestClient, RedisTestClient } from '../utils/redis-test-client';
import { enqueueTestJob } from '../utils/queue-test-helpers';

let redis: RedisTestClient;
let releaseRun: (() => void) | null = null;

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

import { JOB_QUEUE_KEY, PROCESSING_QUEUE_KEY, JOB_STATUS, jobAttemptsKey, jobLockKey, jobStatusKey } from '../../src/backend/queue/constants';
import { recoverOrphanedProcessingJobs } from '../../src/backend/queue/dequeue';
import { acquireJobLock } from '../../src/backend/worker/lock';
import { processJob, resetWorkerStateForTests, runWorkerOnce } from '../../src/backend/worker/worker';
import { runGeminiJob } from '../../src/backend/services/geminiRunner';
import { notifyAzureWithJobResult } from '../../src/backend/services/azureNotifier';

function buildRunOutput(jobId: string, prId: number) {
  return {
    prMetadata: {
      prId,
      title: 'Concurrent PR',
      description: '',
      repositoryId: 'repo-1',
      repositoryName: 'Repo',
      projectName: 'Project',
      projectId: 'project-1',
      sourceBranch: 'feature',
      targetBranch: 'main',
      author: 'User',
      authorEmail: 'user@example.com',
      createDate: new Date('2026-03-26T00:00:00.000Z'),
      branchName: 'feature'
    },
    result: {
      jobId,
      prId,
      title: 'Generated testcase',
      htmlDescription: '<p>Body</p>',
      commentContent: '<p>Comment</p>',
      createdAt: Date.now()
    }
  };
}

async function waitForRunGeminiCall(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((runGeminiJob as jest.Mock).mock.calls.length > 0) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for runGeminiJob to be called');
}

describe('queue to worker integration', () => {
  beforeEach(() => {
    redis = createRedisTestClient();
    releaseRun = null;
    resetWorkerStateForTests();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-26T00:00:00.000Z'));
    (runGeminiJob as jest.Mock).mockImplementation(async (job: { jobId: string; prId: number }) => buildRunOutput(job.jobId, job.prId));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows only one worker to process a queued job concurrently', async () => {
    const { job } = await enqueueTestJob({ jobId: 'job-concurrency', prId: 501 });
    (runGeminiJob as jest.Mock).mockImplementation((queuedJob: { jobId: string; prId: number }) => new Promise((resolve) => {
      releaseRun = () => resolve(buildRunOutput(queuedJob.jobId, queuedJob.prId));
    }));

    const first = processJob(job.jobId);
    await waitForRunGeminiCall();
    const second = processJob(job.jobId);

    releaseRun?.();
    await Promise.all([first, second]);

    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.completed);
    expect(runGeminiJob).toHaveBeenCalledTimes(1);
    expect(notifyAzureWithJobResult).toHaveBeenCalledTimes(1);
  });

  it('recovers an orphaned processing job after the lock expires and completes it once', async () => {
    const { job } = await enqueueTestJob({ jobId: 'job-crash-recovery', prId: 502 });

    await redis.lpush(PROCESSING_QUEUE_KEY, job.jobId);
    await acquireJobLock(job.jobId, 'crashed-worker');
    jest.advanceTimersByTime(181_000);

    const recovered = await recoverOrphanedProcessingJobs();
    const processed = await runWorkerOnce();

    expect(recovered).toBe(1);
    expect(processed).toBe(true);
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.completed);
    expect(runGeminiJob).toHaveBeenCalledTimes(1);
    expect(notifyAzureWithJobResult).toHaveBeenCalledTimes(1);
  });

  it('bails out without retrying when lock ownership is lost mid-job', async () => {
    const { job } = await enqueueTestJob({ jobId: 'job-lock-lost', prId: 503 });
    (runGeminiJob as jest.Mock).mockImplementation(async (queuedJob: { jobId: string; prId: number }) => {
      await redis.del(jobLockKey(queuedJob.jobId));
      return buildRunOutput(queuedJob.jobId, queuedJob.prId);
    });

    await runWorkerOnce();

    expect(await redis.get(jobAttemptsKey(job.jobId))).toBe('0');
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.processing);
    expect(await redis.lrange(JOB_QUEUE_KEY, 0, -1)).toEqual([]);
    expect(notifyAzureWithJobResult).not.toHaveBeenCalled();
  });
});
