/**
 * Redis-backed background worker for PR processing.
 */

import * as dotenv from 'dotenv';
import * as ai from '../ai';
import * as adoClient from '../ado-client';
import {
  clearJobError,
  deleteJobAuth,
  deleteJobToken,
  dequeueJobId,
  getJobStatus,
  getQueuedJob,
  getQueuedJobAuth,
  incrementFailedMetric,
  incrementJobAttempts,
  isJobReadyForProcessing,
  markJobCompleted,
  moveJobToDlq,
  recoverOrphanedProcessingJobs,
  removeProcessingEntry,
  requeueJob,
  setJobStatus,
  writeJobError
} from '../queue/dequeue';
import {
  JOB_STATUS,
  MAX_JOB_ATTEMPTS,
  WORKER_IDLE_SLEEP_MS
} from '../queue/constants';
import { runGeminiJob } from '../services/geminiRunner';
import { getStoredJobResult, writeJobResult } from '../services/resultWriter';
import { notifyAzureWithJobResult } from '../services/azureNotifier';
import { QueuedPRJob, QueuedJobAuth, StoredJobError, PRMetadata } from '../types';
import * as logger from '../utils/logger';
import { validateQueueEnvironment, validateServerEnvironment } from '../utils/validateEnv';
import {
  acquireJobLock,
  createJobLockOwnerId,
  ownsJobLock,
  releaseJobLock,
  startJobLockHeartbeat
} from './lock';

dotenv.config();

let shutdownRequested = false;
let activeJobId: string | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkerLog(
  jobId: string,
  stage: string,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    jobId,
    stage,
    status,
    timestamp: new Date().toISOString(),
    ...extra
  };
}

async function fetchPrMetadataForStoredResult(job: QueuedPRJob, auth: QueuedJobAuth): Promise<PRMetadata> {
  const connection = adoClient.createConnection(auth.accessToken, auth.organizationUrl);
  return adoClient.fetchPRMetadata(job.prId, connection);
}

function isImmediateDlqError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('401') ||
    message.includes('403') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('expired token') ||
    message.includes('token expired')
  );
}

class LostJobLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LostJobLockError';
  }
}

async function handleJobFailure(jobId: string, job: QueuedPRJob | null, error: unknown): Promise<void> {
  const attempts = await incrementJobAttempts(jobId);
  const err = error instanceof Error ? error : new Error(String(error));
  const errorRecord: StoredJobError = {
    jobId,
    prId: job?.prId ?? 0,
    attempt: attempts,
    failedAt: Date.now(),
    message: err.message,
    name: err.name,
    stack: err.stack
  };

  await Promise.all([
    incrementFailedMetric(),
    writeJobError(errorRecord)
  ]);

  logger.error('job_failed', buildWorkerLog(jobId, 'execute', 'failed', {
    prId: job?.prId,
    attempt: attempts,
    error: err.message
  }));

  if (!isImmediateDlqError(err) && attempts < MAX_JOB_ATTEMPTS) {
    await requeueJob(jobId);
    logger.warn('job_retried', buildWorkerLog(jobId, 'retry', 'queued', {
      prId: job?.prId,
      attempt: attempts
    }));
    return;
  }

  await moveJobToDlq(jobId);
  await deleteJobAuth(jobId);
  await deleteJobToken(jobId);
  logger.error('job_dlq', buildWorkerLog(jobId, 'dlq', 'failed', {
    prId: job?.prId,
    attempt: attempts
  }));
}

export async function processJob(jobId: string): Promise<void> {
  activeJobId = jobId;
  logger.info('job_dequeued', buildWorkerLog(jobId, 'dequeue', 'queued'));

  const [job, auth] = await Promise.all([
    getQueuedJob(jobId),
    getQueuedJobAuth(jobId)
  ]);

  if (job === null || auth === null) {
    await removeProcessingEntry(jobId);
    await handleJobFailure(jobId, job, new Error('Missing queued job payload or auth state'));
    activeJobId = null;
    return;
  }

  if (typeof auth.expiresAt === 'number' && auth.expiresAt < Date.now()) {
    await removeProcessingEntry(jobId);
    await handleJobFailure(jobId, job, new Error('Expired token'));
    activeJobId = null;
    return;
  }

  const currentStatus = await getJobStatus(jobId);
  if (currentStatus === JOB_STATUS.completed) {
    await removeProcessingEntry(jobId);
    logger.info('job_completed', buildWorkerLog(jobId, 'skip', 'completed', { reason: 'already_completed' }));
    activeJobId = null;
    return;
  }

  if (!(await isJobReadyForProcessing(jobId))) {
    await removeProcessingEntry(jobId);
    logger.info('job_locked', buildWorkerLog(jobId, 'skip', currentStatus === JOB_STATUS.failed ? 'failed' : 'queued', {
      reason: 'job_not_ready'
    }));
    activeJobId = null;
    return;
  }

  const ownerId = createJobLockOwnerId();
  const acquiredLock = await acquireJobLock(jobId, ownerId);
  if (!acquiredLock) {
    await removeProcessingEntry(jobId);
    logger.info('job_locked', buildWorkerLog(jobId, 'lock', 'queued', { reason: 'lock_unavailable' }));
    activeJobId = null;
    return;
  }

  logger.info('job_locked', buildWorkerLog(jobId, 'lock', 'processing', { ownerId }));
  const heartbeat = startJobLockHeartbeat(jobId, ownerId);

  try {
    await setJobStatus(jobId, JOB_STATUS.processing);
    logger.info('job_started', buildWorkerLog(jobId, 'execute', 'processing', { prId: job.prId }));

    let storedResult = await getStoredJobResult(jobId);
    let prMetadata: PRMetadata;

    if (storedResult !== null) {
      prMetadata = await fetchPrMetadataForStoredResult(job, auth);
    } else {
      const runOutput = await runGeminiJob(job, auth);
      prMetadata = runOutput.prMetadata;
      storedResult = await writeJobResult(runOutput.result);
    }

    if (heartbeat.hasLostLock() || !(await ownsJobLock(jobId, ownerId))) {
      throw new LostJobLockError('Lost job lock ownership before Azure notification');
    }

    await notifyAzureWithJobResult(jobId, auth, prMetadata, storedResult);

    if (heartbeat.hasLostLock() || !(await ownsJobLock(jobId, ownerId))) {
      throw new LostJobLockError('Lost job lock ownership before completion');
    }

    await markJobCompleted(jobId);
    await clearJobError(jobId);
    await deleteJobAuth(jobId);
    await deleteJobToken(jobId);
    logger.info('job_completed', buildWorkerLog(jobId, 'complete', 'completed', { prId: job.prId }));
  } catch (error) {
    if (error instanceof LostJobLockError) {
      logger.warn('job_lock_lost', buildWorkerLog(jobId, 'lock', 'processing', {
        prId: job.prId,
        error: error.message
      }));
      return;
    }
    await handleJobFailure(jobId, job, error);
  } finally {
    await heartbeat.stop();
    await releaseJobLock(jobId, ownerId);
    activeJobId = null;
  }
}

export async function runWorkerOnce(): Promise<boolean> {
  await recoverOrphanedProcessingJobs();
  const jobId = await dequeueJobId();
  if (jobId === null) {
    return false;
  }

  await processJob(jobId);
  return true;
}

async function workerLoop(): Promise<void> {
  await recoverOrphanedProcessingJobs();

  while (!shutdownRequested) {
    const jobId = await dequeueJobId();
    if (jobId === null) {
      await sleep(WORKER_IDLE_SLEEP_MS);
      continue;
    }

    await processJob(jobId);
  }
}

function requestShutdown(signal: string): void {
  shutdownRequested = true;
  logger.info('Worker shutdown requested', {
    signal,
    activeJobId,
    timestamp: new Date().toISOString()
  });
}

export function resetWorkerStateForTests(): void {
  shutdownRequested = false;
  activeJobId = null;
}

export async function startWorker(): Promise<void> {
  logger.info('Worker startup initiated', {
    pid: process.pid,
    nodeEnv: process.env.NODE_ENV ?? 'undefined',
    idleSleepMs: WORKER_IDLE_SLEEP_MS,
    timestamp: new Date().toISOString()
  });

  validateServerEnvironment(['GEMINI_API_KEY']);
  validateQueueEnvironment();
  ai.loadSystemPrompt('qa');
  ai.loadSystemPrompt('review');

  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  logger.info('Worker started and ready to poll Upstash Redis', {
    pid: process.pid,
    queueMode: 'redis-only',
    timestamp: new Date().toISOString()
  });

  const recoveryInterval = setInterval(() => {
    void recoverOrphanedProcessingJobs().catch((error) => {
      logger.warn('Failed to recover orphaned processing jobs', {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, 60_000);

  try {
    await workerLoop();
  } finally {
    clearInterval(recoveryInterval);
    logger.info('Worker stopped', {
      activeJobId,
      shutdownRequested,
      timestamp: new Date().toISOString()
    });
  }
}

if (process.env.NODE_ENV !== 'test') {
  void startWorker().catch((error) => {
    logger.error('Worker crashed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
  });
}
