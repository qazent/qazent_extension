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
  createConnection: jest.fn().mockReturnValue({}),
  fetchPRMetadata: jest.fn().mockResolvedValue({
    prId: 101,
    title: 'PR title',
    description: '',
    repositoryId: 'repo-1',
    repositoryName: 'Repo',
    projectName: 'Project',
    projectId: 'project-1',
    sourceBranch: 'feature',
    targetBranch: 'main',
    author: 'Test User',
    authorEmail: 'user@example.com',
    createDate: new Date('2026-03-26T00:00:00.000Z'),
    branchName: 'feature'
  })
}));

import { JOB_STATUS, jobStatusKey } from '../../src/backend/queue/constants';
import { getStoredJobResult, writeJobResult } from '../../src/backend/services/resultWriter';
import { runGeminiJob } from '../../src/backend/services/geminiRunner';
import { notifyAzureWithJobResult } from '../../src/backend/services/azureNotifier';
import { resetWorkerStateForTests, runWorkerOnce } from '../../src/backend/worker/worker';

describe('worker idempotency', () => {
  beforeEach(() => {
    redis = createRedisTestClient();
    resetWorkerStateForTests();
    jest.clearAllMocks();
  });

  it('skips jobs that are already marked completed', async () => {
    const { job } = await enqueueTestJob({ jobId: 'job-idempotent-1' });
    await redis.set(jobStatusKey(job.jobId), JOB_STATUS.completed);

    await runWorkerOnce();

    expect(runGeminiJob).not.toHaveBeenCalled();
    expect(notifyAzureWithJobResult).not.toHaveBeenCalled();
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.completed);
  });

  it('does not overwrite an existing stored result when a duplicate write occurs', async () => {
    const firstResult = await writeJobResult({
      jobId: 'job-idempotent-2',
      prId: 102,
      title: 'Original result',
      htmlDescription: '<p>Original</p>',
      commentContent: '<p>Original comment</p>',
      createdAt: 1
    });

    const secondResult = await writeJobResult({
      jobId: 'job-idempotent-2',
      prId: 102,
      title: 'Duplicate result',
      htmlDescription: '<p>Duplicate</p>',
      commentContent: '<p>Duplicate comment</p>',
      createdAt: 2
    });

    expect(secondResult).toEqual(firstResult);
    expect(await getStoredJobResult('job-idempotent-2')).toEqual(firstResult);
  });
});
