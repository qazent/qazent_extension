/**
 * Redis-backed dequeue and state transition helpers for worker processing.
 */

import type { Redis } from '@upstash/redis';
import { QueuedJobAuth, QueuedPRJob, StoredJobError } from '../types';
import * as logger from '../utils/logger';
import {
  DLQ_KEY,
  JOB_QUEUE_KEY,
  JOB_STATUS,
  JOB_TTL_FAILED,
  JOB_TTL_SUCCESS,
  JOB_TTL_TRANSIENT,
  METRICS_DLQ_KEY,
  METRICS_FAILED_KEY,
  METRICS_PROCESSED_KEY,
  METRICS_RETRIED_KEY,
  PROCESSING_QUEUE_KEY,
  type JobStatus,
  jobAttemptsKey,
  jobAuthKey,
  jobAzureCommentPostedKey,
  jobErrorKey,
  jobLockKey,
  jobPayloadKey,
  jobTokenKey,
  jobStatusKey
} from './constants';
import { getRedisClient } from './redisClient';

const DEQUEUE_TO_PROCESSING_SCRIPT = `
local jobId = redis.call("RPOP", KEYS[1])
if not jobId then
  return nil
end
redis.call("LPUSH", KEYS[2], jobId)
return jobId
`;

function parseJson<T>(raw: unknown, key: string): T | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw !== 'string') {
    logger.warn('Unexpected non-string Redis payload', { key, valueType: typeof raw });
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.error('Failed to parse Redis JSON payload', {
      key,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

interface JobRetentionOptions {
  payloadTtlSeconds: number;
  statusTtlSeconds: number;
  attemptsTtlSeconds: number;
  errorTtlSeconds?: number;
  commentMarkerTtlSeconds?: number;
}

function applyJobRetention(pipeline: ReturnType<Redis['pipeline']>, jobId: string, options: JobRetentionOptions): void {
  pipeline.expire(jobPayloadKey(jobId), options.payloadTtlSeconds);
  pipeline.expire(jobStatusKey(jobId), options.statusTtlSeconds);
  pipeline.expire(jobAttemptsKey(jobId), options.attemptsTtlSeconds);

  if (typeof options.errorTtlSeconds === 'number') {
    pipeline.expire(jobErrorKey(jobId), options.errorTtlSeconds);
  }

  if (typeof options.commentMarkerTtlSeconds === 'number') {
    pipeline.expire(jobAzureCommentPostedKey(jobId), options.commentMarkerTtlSeconds);
  }
}

export async function removeProcessingEntry(jobId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.lrem(PROCESSING_QUEUE_KEY, 1, jobId);
}

export async function dequeueJobId(): Promise<string | null> {
  const redis = getRedisClient();
  logger.info('Polling Upstash Redis for queued jobs', {
    queueKey: JOB_QUEUE_KEY,
    processingQueueKey: PROCESSING_QUEUE_KEY
  });
  const result = await redis.eval(DEQUEUE_TO_PROCESSING_SCRIPT, [JOB_QUEUE_KEY, PROCESSING_QUEUE_KEY], []) as string | null;
  logger.info('Received dequeue response from Upstash Redis', {
    queueKey: JOB_QUEUE_KEY,
    processingQueueKey: PROCESSING_QUEUE_KEY,
    jobId: result
  });
  return typeof result === 'string' && result.length > 0 ? result : null;
}

export async function getQueuedJob(jobId: string): Promise<QueuedPRJob | null> {
  const redis = getRedisClient();
  return parseJson<QueuedPRJob>(await redis.get(jobPayloadKey(jobId)), jobPayloadKey(jobId));
}

export async function getQueuedJobAuth(jobId: string): Promise<QueuedJobAuth | null> {
  const redis = getRedisClient();
  return parseJson<QueuedJobAuth>(await redis.get(jobAuthKey(jobId)), jobAuthKey(jobId));
}

export async function getJobStatus(jobId: string): Promise<JobStatus | null> {
  const redis = getRedisClient();
  const status = await redis.get(jobStatusKey(jobId));
  return typeof status === 'string' ? status as JobStatus : null;
}

export async function setJobStatus(jobId: string, status: JobStatus, ttlSeconds = JOB_TTL_TRANSIENT): Promise<void> {
  const redis = getRedisClient();
  const pipeline = redis.pipeline();
  pipeline.set(jobStatusKey(jobId), status, { ex: ttlSeconds });
  applyJobRetention(pipeline, jobId, {
    payloadTtlSeconds: JOB_TTL_TRANSIENT,
    statusTtlSeconds: ttlSeconds,
    attemptsTtlSeconds: JOB_TTL_TRANSIENT
  });
  await pipeline.exec();
}

export async function getJobAttempts(jobId: string): Promise<number> {
  const redis = getRedisClient();
  const attempts = await redis.get(jobAttemptsKey(jobId));
  if (typeof attempts === 'number') {
    return attempts;
  }
  if (typeof attempts === 'string') {
    const parsed = Number.parseInt(attempts, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function incrementJobAttempts(jobId: string, ttlSeconds = JOB_TTL_TRANSIENT): Promise<number> {
  const redis = getRedisClient();
  const results = await redis
    .pipeline()
    .incr(jobAttemptsKey(jobId))
    .expire(jobAttemptsKey(jobId), ttlSeconds)
    .expire(jobPayloadKey(jobId), JOB_TTL_TRANSIENT)
    .expire(jobStatusKey(jobId), JOB_TTL_TRANSIENT)
    .exec<[number, 0 | 1, 0 | 1, 0 | 1]>();

  return Number(results[0]);
}

export async function hasActiveJobLock(jobId: string): Promise<boolean> {
  const redis = getRedisClient();
  const lockValue = await redis.get(jobLockKey(jobId));
  return typeof lockValue === 'string' && lockValue.length > 0;
}

export async function isJobReadyForProcessing(jobId: string): Promise<boolean> {
  const [status, hasLock] = await Promise.all([
    getJobStatus(jobId),
    hasActiveJobLock(jobId)
  ]);
  return status === JOB_STATUS.queued && !hasLock;
}

export async function writeJobError(errorRecord: StoredJobError, ttlSeconds = JOB_TTL_TRANSIENT): Promise<void> {
  const redis = getRedisClient();
  await redis.set(jobErrorKey(errorRecord.jobId), JSON.stringify(errorRecord), { ex: ttlSeconds });
}

export async function clearJobError(jobId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(jobErrorKey(jobId));
}

export async function deleteJobAuth(jobId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(jobAuthKey(jobId));
}

export async function deleteJobToken(jobId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(jobTokenKey(jobId));
}

export async function markJobCompleted(jobId: string): Promise<void> {
  const redis = getRedisClient();
  const pipeline = redis.pipeline();
  pipeline.set(jobStatusKey(jobId), JOB_STATUS.completed, { ex: JOB_TTL_SUCCESS });
  applyJobRetention(pipeline, jobId, {
    payloadTtlSeconds: JOB_TTL_SUCCESS,
    statusTtlSeconds: JOB_TTL_SUCCESS,
    attemptsTtlSeconds: JOB_TTL_SUCCESS,
    commentMarkerTtlSeconds: JOB_TTL_SUCCESS
  });
  pipeline.incr(METRICS_PROCESSED_KEY);
  pipeline.lrem(PROCESSING_QUEUE_KEY, 1, jobId);
  await pipeline.exec();
}

export async function requeueJob(jobId: string): Promise<void> {
  const redis = getRedisClient();
  const pipeline = redis.pipeline();
  pipeline.set(jobStatusKey(jobId), JOB_STATUS.queued, { ex: JOB_TTL_TRANSIENT });
  applyJobRetention(pipeline, jobId, {
    payloadTtlSeconds: JOB_TTL_TRANSIENT,
    statusTtlSeconds: JOB_TTL_TRANSIENT,
    attemptsTtlSeconds: JOB_TTL_TRANSIENT,
    errorTtlSeconds: JOB_TTL_TRANSIENT
  });
  pipeline.incr(METRICS_RETRIED_KEY);
  pipeline.lrem(PROCESSING_QUEUE_KEY, 1, jobId);
  pipeline.lpush(JOB_QUEUE_KEY, jobId);
  await pipeline.exec();
}

export async function moveJobToDlq(jobId: string): Promise<void> {
  const redis = getRedisClient();
  const pipeline = redis.pipeline();
  pipeline.set(jobStatusKey(jobId), JOB_STATUS.failed, { ex: JOB_TTL_FAILED });
  applyJobRetention(pipeline, jobId, {
    payloadTtlSeconds: JOB_TTL_FAILED,
    statusTtlSeconds: JOB_TTL_FAILED,
    attemptsTtlSeconds: JOB_TTL_FAILED,
    errorTtlSeconds: JOB_TTL_FAILED,
    commentMarkerTtlSeconds: JOB_TTL_FAILED
  });
  pipeline.incr(METRICS_DLQ_KEY);
  pipeline.lrem(PROCESSING_QUEUE_KEY, 1, jobId);
  pipeline.lpush(DLQ_KEY, jobId);
  await pipeline.exec();
}

export async function incrementFailedMetric(): Promise<void> {
  const redis = getRedisClient();
  await redis.incr(METRICS_FAILED_KEY);
}

export async function getQueueDepth(): Promise<number> {
  const redis = getRedisClient();
  return redis.llen(JOB_QUEUE_KEY);
}

export async function recoverOrphanedProcessingJobs(): Promise<number> {
  const redis = getRedisClient();
  const processingJobIds = await redis.lrange(PROCESSING_QUEUE_KEY, 0, -1) as string[];
  let recoveredCount = 0;

  for (const jobId of processingJobIds) {
    if (typeof jobId !== 'string' || jobId.length === 0) {
      continue;
    }

    const [status, hasLock] = await Promise.all([
      getJobStatus(jobId),
      hasActiveJobLock(jobId)
    ]);

    if (hasLock) {
      continue;
    }

    if (status === JOB_STATUS.completed || status === JOB_STATUS.failed) {
      await removeProcessingEntry(jobId);
      continue;
    }

    const pipeline = redis.pipeline();
    pipeline.set(jobStatusKey(jobId), JOB_STATUS.queued, { ex: JOB_TTL_TRANSIENT });
    applyJobRetention(pipeline, jobId, {
      payloadTtlSeconds: JOB_TTL_TRANSIENT,
      statusTtlSeconds: JOB_TTL_TRANSIENT,
      attemptsTtlSeconds: JOB_TTL_TRANSIENT
    });
    pipeline.lrem(PROCESSING_QUEUE_KEY, 1, jobId);
    pipeline.lpush(JOB_QUEUE_KEY, jobId);
    await pipeline.exec();
    recoveredCount++;
  }

  if (recoveredCount > 0) {
    logger.warn('Recovered orphaned processing jobs', {
      recoveredCount,
      processingQueueKey: PROCESSING_QUEUE_KEY
    });
  }

  return recoveredCount;
}
