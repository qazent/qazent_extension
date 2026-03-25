/**
 * Shared queue constants and Redis key builders.
 */

export const JOB_QUEUE_KEY = 'qazent-jobs';
export const PROCESSING_QUEUE_KEY = 'qazent-processing';
export const DLQ_KEY = 'qazent-dlq';
export const METRICS_PROCESSED_KEY = 'metrics:processed';
export const METRICS_FAILED_KEY = 'metrics:failed';
export const METRICS_RETRIED_KEY = 'metrics:retried';
export const METRICS_DLQ_KEY = 'metrics:dlq';

export const JOB_STATUS = {
  queued: 'queued',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed'
} as const;

export type JobStatus = typeof JOB_STATUS[keyof typeof JOB_STATUS];

export const ATTEMPT_DEFAULT = 0;
export const MAX_JOB_ATTEMPTS = 5;
export const JOB_LOCK_TTL_SECONDS = 180;
export const JOB_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
export const JOB_RESULT_TTL_SECONDS = 24 * 60 * 60;
export const JOB_TTL_SUCCESS = 7 * 24 * 60 * 60;
export const JOB_TTL_FAILED = 30 * 24 * 60 * 60;
export const JOB_TTL_TRANSIENT = 24 * 60 * 60;
export const JOB_TOKEN_TTL_SECONDS = 60 * 60;
export const JOB_AUTH_TTL_SECONDS = JOB_TTL_TRANSIENT;
export const WORKER_IDLE_SLEEP_MS = 400;

export function jobPayloadKey(jobId: string): string {
  return `job:${jobId}`;
}

export function jobStatusKey(jobId: string): string {
  return `job:status:${jobId}`;
}

export function jobAttemptsKey(jobId: string): string {
  return `job:attempts:${jobId}`;
}

export function jobLockKey(jobId: string): string {
  return `job:lock:${jobId}`;
}

export function jobResultKey(jobId: string): string {
  return `job:result:${jobId}`;
}

export function jobErrorKey(jobId: string): string {
  return `job:error:${jobId}`;
}

export function jobAuthKey(jobId: string): string {
  return `job:auth:${jobId}`;
}

export function jobTokenKey(jobId: string): string {
  return `job:token:${jobId}`;
}

export function jobAzureCommentPostedKey(jobId: string): string {
  return `job:azureCommentPosted:${jobId}`;
}
