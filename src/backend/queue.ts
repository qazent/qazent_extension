/**
 * In-memory job queue with retry logic and background processing
 */

import { v4 as uuidv4 } from 'uuid';
import { QueueJob, QueueStatus, WebhookPayload, PRMetadata } from './types';
import * as logger from './utils/logger';
import * as adoClient from './ado-client';
import * as ai from './ai';
import { fetchPRDiff } from './fetchPRdiff';

const queue: QueueJob[] = [];
let isProcessing = false;
const MAX_RETRIES = 3;

/**
 * Extract organization name from Azure DevOps URL
 */
function extractOrgName(orgUrl: string): string {
  const url = new URL(orgUrl);

  if (url.hostname === 'dev.azure.com') {
    return url.pathname.split('/')[1];
  }

  if (url.hostname.endsWith('.visualstudio.com')) {
    return url.hostname.split('.')[0];
  }

  throw new Error(`Invalid Azure DevOps URL format: ${orgUrl}`);
}

/**
 * Extract PR metadata from webhook payload
 */
function extractPRMetadata(payload: WebhookPayload): PRMetadata {
  const sourceRef = payload.resource?.sourceRefName || 'unknown';
  const targetRef = payload.resource?.targetRefName || 'unknown';
  const createdBy = payload.resource?.createdBy || {};

  return {
    prId: payload.resource.pullRequestId,
    title: payload.resource.title,
    description: payload.resource.description || '',
    repositoryId: payload.resource.repository.id,
    repositoryName: payload.resource.repository.name,
    projectName: payload.resource.repository.project.name,
    projectId: payload.resource.repository.project.id,
    sourceBranch: sourceRef.replace('refs/heads/', ''),
    targetBranch: targetRef.replace('refs/heads/', ''),
    author: createdBy.displayName || 'unknown',
    authorEmail: createdBy.uniqueName || 'unknown',
    createDate: new Date(),
    branchName: sourceRef.replace('refs/heads/', ''),
  };
}

/**
 * Retry a function with exponential backoff and jitter
 * Useful for transient failures (network glitches, rate limiting)
 */
async function fetchWithRetry<T>(
  fetchFunc: () => Promise<T>,
  maxAttempts: number = 3,
  initialDelayMs: number = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchFunc();
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error; // Final attempt, don't retry
      }

      // Exponential backoff with jitter: (2^attempt - 1) * initialDelayMs + random(0-1000)ms
      const exponentialDelay = Math.pow(2, attempt - 1) * initialDelayMs;
      const jitter = Math.random() * 1000;
      const delayMs = exponentialDelay + jitter;

      logger.warn('API call failed, retrying', {
        attempt,
        maxAttempts,
        error: String(error),
        delayMs: Math.floor(delayMs),
        errorType: error instanceof Error ? error.constructor.name : typeof error
      });

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('fetchWithRetry loop completed without returning or throwing');
}

/**
 * Process a single job
 */
async function processJob(job: QueueJob): Promise<void> {
  const { payload, attempt } = job;
  const prMetadata = extractPRMetadata(payload);

  // Create Azure DevOps connection from stored credentials
  const connection = adoClient.createConnection(payload.token, payload.orgUrl);
  const orgName = extractOrgName(payload.orgUrl);

  logger.info('Processing job', {
    jobId: job.id,
    prId: prMetadata.prId,
    projectId: prMetadata.projectId,
    repositoryId: prMetadata.repositoryId,
    sourceBranch: prMetadata.sourceBranch,
    targetBranch: prMetadata.targetBranch,
    attempt,
    maxAttempts: job.maxAttempts,
    orgUrl: payload.orgUrl,
    tokenLength: payload.token?.length,
    tokenIsJWT: payload.token?.includes('.')
  });

  try {
    // Step 1: Fetch PR diff from Azure DevOps with retry logic
    logger.info('Fetching PR diff', { jobId: job.id, prId: prMetadata.prId, tokenLength: payload.token?.length, tokenIsJWT: payload.token?.includes('.'), orgUrl: payload.orgUrl});
    const codeDiff = await fetchWithRetry(
      () => fetchPRDiff(
        prMetadata.projectName,
        prMetadata.repositoryId,
        prMetadata.prId,
        connection,
        orgName,
        payload.token,
      ),
      3,  // maxAttempts
      1000  // initialDelayMs
    );

    // Step 2: Generate test cases using AI
    logger.info('Generating test cases with AI', { jobId: job.id, prId: prMetadata.prId });
    const taskOutput = await ai.generateTestCases(prMetadata, codeDiff);

    // Step 3: Create work item in Azure DevOps
    logger.info('Creating work item', { jobId: job.id, prId: prMetadata.prId });
    const workItemId = await adoClient.createTaskWorkItem(
      prMetadata.projectName,
      taskOutput,
      prMetadata,
      connection
    );

    // Step 4: Post PR comment
    try {
      logger.info('Posting PR comment', { jobId: job.id, prId: prMetadata.prId, workItemId });
      await adoClient.postPRComment(
        prMetadata.projectName,
        prMetadata.repositoryId,
        prMetadata.prId,
        workItemId,
        connection
      );
    } catch (commentError) {
      // Log warning but don't fail job - work item already created
      logger.warn('Failed to post PR comment, continuing', {
        jobId: job.id,
        prId: prMetadata.prId,
        workItemId,
        error: String(commentError)
      });
    }

    logger.info('Job completed successfully', {
      jobId: job.id,
      prId: prMetadata.prId,
      workItemId,
      attempt
    });

  } catch (error) {
    logger.error('Job failed', {
      jobId: job.id,
      prId: prMetadata.prId,
      attempt,
      error: String(error)
    });

    // Check if we should retry
    if (attempt < job.maxAttempts) {
      const nextAttempt = attempt + 1;
      const backoffSeconds = Math.pow(2, attempt - 1); // 1s, 2s, 4s
      const scheduledFor = new Date(Date.now() + backoffSeconds * 1000);

      logger.warn('Scheduling retry', {
        jobId: job.id,
        prId: prMetadata.prId,
        nextAttempt,
        backoffSeconds,
        scheduledFor: scheduledFor.toISOString()
      });

      // Re-queue with incremented attempt and scheduled time
      queue.push({
        ...job,
        attempt: nextAttempt,
        scheduledFor
      });

    } else {
      // Max retries reached, create fallback work item
      logger.error('Max retries reached, creating fallback work item', {
        jobId: job.id,
        prId: prMetadata.prId
      });

      try {
        const fallbackWorkItemId = await adoClient.createFallbackWorkItem(
          prMetadata.projectName,
          prMetadata,
          connection
        );

        logger.info('Fallback work item created', {
          jobId: job.id,
          prId: prMetadata.prId,
          workItemId: fallbackWorkItemId
        });

        // Post PR comment for fallback work item
        try {
          await adoClient.postPRComment(
            prMetadata.projectName,
            prMetadata.repositoryId,
            prMetadata.prId,
            fallbackWorkItemId,
            connection
          );
        } catch (commentError) {
          logger.warn('Failed to post PR comment for fallback work item', {
            jobId: job.id,
            prId: prMetadata.prId,
            workItemId: fallbackWorkItemId,
            error: String(commentError)
          });
        }

      } catch (fallbackError) {
        logger.error('Failed to create fallback work item', {
          jobId: job.id,
          prId: prMetadata.prId,
          error: String(fallbackError)
        });
      }
    }
  }
}

/**
 * Background worker that processes jobs from the queue
 */
async function worker(): Promise<void> {
  while (true) {
    // Check if there are jobs ready to process
    const now = new Date();
    const readyJobIndex = queue.findIndex(job => {
      return !job.scheduledFor || job.scheduledFor <= now;
    });

    if (readyJobIndex !== -1) {
      // Remove job from queue
      const job = queue.splice(readyJobIndex, 1)[0];

      // Process the job
      await processJob(job);

    } else {
      // No jobs ready, wait before checking again
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

/**
 * Add a job to the queue
 */
export function addJob(payload: WebhookPayload, token: string, orgUrl: string): string {
  const jobId = uuidv4();

  // Store credentials in payload for background processing
  payload.token = token;
  payload.orgUrl = orgUrl;

  const job: QueueJob = {
    id: jobId,
    payload,
    attempt: 1,
    maxAttempts: MAX_RETRIES
  };

  queue.push(job);

  logger.info('Job added to queue', {
    jobId,
    prId: payload.resource.pullRequestId,
    queueLength: queue.length,
    orgUrl,
    tokenLength: token?.length,
    tokenIsJWT: token?.includes('.')
  });

  return jobId;
}

/**
 * Start the background worker
 */
export function startWorker(): void {
  if (isProcessing) {
    logger.warn('Worker already running');
    return;
  }

  isProcessing = true;
  logger.info('Starting background worker');

  // Start worker (non-blocking)
  worker().catch(error => {
    logger.error('Worker crashed', { error: String(error) });
    isProcessing = false;
  });
}

/**
 * Get current queue status
 */
export function getQueueStatus(): QueueStatus {
  return {
    pending: queue.length,
    processing: isProcessing
  };
}
