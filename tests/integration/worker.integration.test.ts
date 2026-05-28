/**
 * @jest-environment node
 */

import { createLoggerMock } from '../utils/logger-mock';
import { createRedisTestClient, RedisTestClient } from '../utils/redis-test-client';
import { enqueueTestJob } from '../utils/queue-test-helpers';

let redis: RedisTestClient;
const mockGetThreads = jest.fn();

jest.mock('../../src/backend/queue/redisClient', () => ({
  getRedisClient: jest.fn(() => redis)
}));

jest.mock('../../src/backend/utils/logger', () => createLoggerMock());
jest.mock('../../src/backend/ai', () => ({
  loadSystemPrompt: jest.fn(),
  extractPurposeAndScope: jest.fn(() => '<h2>Summary</h2><p>Validate queue worker.</p>'),
  generateTestCases: jest.fn()
}));
jest.mock('../../src/backend/fetchPRdiff', () => ({
  fetchPRDiff: jest.fn()
}));
jest.mock('../../src/backend/ado-client', () => ({
  createConnection: jest.fn(() => ({
    getGitApi: jest.fn(async () => ({
      getThreads: mockGetThreads
    }))
  })),
  fetchPRMetadata: jest.fn(),
  postPRComment: jest.fn()
}));

import * as ai from '../../src/backend/ai';
import * as adoClient from '../../src/backend/ado-client';
import { fetchPRDiff } from '../../src/backend/fetchPRdiff';
import {
  JOB_STATUS,
  JOB_TTL_SUCCESS,
  JOB_TTL_TRANSIENT,
  METRICS_PROCESSED_KEY,
  jobAttemptsKey,
  jobAzureCommentPostedKey,
  jobPayloadKey,
  jobResultKey,
  jobStatusKey
} from '../../src/backend/queue/constants';
import { resetWorkerStateForTests, runWorkerOnce } from '../../src/backend/worker/worker';

describe('worker integration', () => {
  beforeEach(() => {
    redis = createRedisTestClient();
    resetWorkerStateForTests();
    jest.clearAllMocks();

    mockGetThreads.mockResolvedValue([]);
    (adoClient.fetchPRMetadata as jest.Mock).mockResolvedValue({
      prId: 101,
      title: 'My PR',
      description: 'Description',
      repositoryId: 'repo-1',
      repositoryName: 'Repo',
      projectName: 'Project',
      projectId: 'project-1',
      sourceBranch: 'feature/test',
      targetBranch: 'main',
      author: 'Test User',
      authorEmail: 'user@example.com',
      createDate: new Date('2026-03-26T00:00:00.000Z'),
      branchName: 'feature/test'
    });
    (fetchPRDiff as jest.Mock).mockResolvedValue({
      changes: [
        {
          filePath: 'src/example.ts',
          changeType: 'edit',
          linesAdded: 3,
          linesDeleted: 1,
          diffContent: '@@ diff @@'
        }
      ],
      totalChanges: 1,
      sourceCommitId: 'source-1',
      targetCommitId: 'target-1'
    });
    (ai.generateTestCases as jest.Mock).mockResolvedValue({
      title: 'Generated testcase',
      htmlDescription: '<p>Generated body</p>'
    });
    (adoClient.postPRComment as jest.Mock).mockResolvedValue(undefined);
  });

  it('processes an enqueued job to completion and stores the result plus metrics', async () => {
    const { job } = await enqueueTestJob({ jobId: 'job-integration-1', prId: 401 });

    const processed = await runWorkerOnce();

    expect(processed).toBe(true);
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.completed);
    expect(await redis.get(jobResultKey(job.jobId))).toEqual(expect.any(String));
    expect(await redis.get(jobAzureCommentPostedKey(job.jobId))).toEqual(expect.any(String));
    expect(await redis.ttl(jobPayloadKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobPayloadKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_SUCCESS);
    expect(await redis.ttl(jobStatusKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobStatusKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_SUCCESS);
    expect(await redis.ttl(jobAttemptsKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobAttemptsKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_SUCCESS);
    expect(await redis.ttl(jobAzureCommentPostedKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobAzureCommentPostedKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_SUCCESS);
    expect(await redis.get(METRICS_PROCESSED_KEY)).toBe(1);
    expect(ai.generateTestCases).toHaveBeenCalledTimes(1);
    expect(adoClient.postPRComment).toHaveBeenCalledTimes(1);
  });

  it('retries comment posting failures without regenerating or duplicating the stored result', async () => {
    const { job } = await enqueueTestJob({ jobId: 'job-integration-2', prId: 402 });
    (adoClient.postPRComment as jest.Mock)
      .mockRejectedValueOnce(new Error('transient comment failure'))
      .mockResolvedValueOnce(undefined);

    await runWorkerOnce();

    const firstStoredResult = await redis.get(jobResultKey(job.jobId));
    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.queued);
    expect(await redis.ttl(jobStatusKey(job.jobId))).toBeGreaterThan(0);
    expect(await redis.ttl(jobStatusKey(job.jobId))).toBeLessThanOrEqual(JOB_TTL_TRANSIENT);
    expect(ai.generateTestCases).toHaveBeenCalledTimes(1);

    await runWorkerOnce();

    expect(await redis.get(jobStatusKey(job.jobId))).toBe(JOB_STATUS.completed);
    expect(await redis.get(jobResultKey(job.jobId))).toBe(firstStoredResult);
    expect(ai.generateTestCases).toHaveBeenCalledTimes(1);
    expect(adoClient.postPRComment).toHaveBeenCalledTimes(2);
    expect(await redis.get(jobAzureCommentPostedKey(job.jobId))).toEqual(expect.any(String));
  });
});
