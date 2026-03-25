/**
 * Redis-backed enqueue operations for PR processing jobs.
 */

import { QueuedJobAuth, QueuedPRJob } from '../types';
import * as logger from '../utils/logger';
import {
  ATTEMPT_DEFAULT,
  JOB_AUTH_TTL_SECONDS,
  JOB_QUEUE_KEY,
  JOB_STATUS,
  JOB_TOKEN_TTL_SECONDS,
  JOB_TTL_TRANSIENT,
  jobAuthKey,
  jobAttemptsKey,
  jobPayloadKey,
  jobTokenKey,
  jobStatusKey
} from './constants';
import { getRedisClient } from './redisClient';

async function writeJobAtomically(job: QueuedPRJob, auth: QueuedJobAuth): Promise<void> {
  const redis = getRedisClient();

  const pipeline = redis.pipeline();
  pipeline.set(jobPayloadKey(job.jobId), JSON.stringify(job), { ex: JOB_TTL_TRANSIENT });
  pipeline.set(jobAuthKey(job.jobId), JSON.stringify(auth), { ex: JOB_AUTH_TTL_SECONDS });
  pipeline.set(jobTokenKey(job.jobId), auth.accessToken, { ex: JOB_TOKEN_TTL_SECONDS });
  pipeline.set(jobStatusKey(job.jobId), JOB_STATUS.queued, { ex: JOB_TTL_TRANSIENT });
  pipeline.set(jobAttemptsKey(job.jobId), ATTEMPT_DEFAULT.toString(), { ex: JOB_TTL_TRANSIENT });
  pipeline.lpush(JOB_QUEUE_KEY, job.jobId);
  await pipeline.exec();
}

export async function enqueuePRJob(job: QueuedPRJob, auth: QueuedJobAuth): Promise<void> {
  try {
    await writeJobAtomically(job, auth);

    logger.info('PR job enqueued', {
      jobId: job.jobId,
      prId: job.prId,
      repo: job.repo,
      filesChangedCount: job.filesChanged.length,
      requestedBy: auth.requestedBy.id,
      queueKey: JOB_QUEUE_KEY
    });
  } catch (error) {
    logger.error('Failed to enqueue PR job', {
      jobId: job.jobId,
      prId: job.prId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new Error('Failed to enqueue PR job');
  }
}
