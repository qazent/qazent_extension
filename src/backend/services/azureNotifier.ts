/**
 * Thin idempotent wrapper around the existing Azure DevOps PR comment helper.
 */

import * as adoClient from '../ado-client';
import { QueuedJobAuth, PRMetadata, StoredJobResult } from '../types';
import * as logger from '../utils/logger';
import { jobAzureCommentPostedKey, JOB_TTL_SUCCESS } from '../queue/constants';
import { getRedisClient } from '../queue/redisClient';

function buildCommentMarker(jobId: string): string {
  return `Qazent job ID: ${jobId}`;
}

async function hasRedisCommentMarker(jobId: string): Promise<boolean> {
  const redis = getRedisClient();
  const marker = await redis.get(jobAzureCommentPostedKey(jobId));
  return typeof marker === 'string' && marker.length > 0;
}

async function writeRedisCommentMarker(jobId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.set(jobAzureCommentPostedKey(jobId), JSON.stringify({
    jobId,
    postedAt: Date.now()
  }), { ex: JOB_TTL_SUCCESS });
}

async function commentAlreadyExistsInAzure(
  jobId: string,
  auth: QueuedJobAuth,
  prMetadata: PRMetadata
): Promise<boolean> {
  const connection = adoClient.createConnection(auth.accessToken, auth.organizationUrl);
  const gitApi = await connection.getGitApi();
  const threads = await gitApi.getThreads(prMetadata.repositoryId, prMetadata.prId, prMetadata.projectName);
  const marker = buildCommentMarker(jobId);

  return threads.some((thread) =>
    (thread.comments ?? []).some((comment) => typeof comment.content === 'string' && comment.content.includes(marker))
  );
}

export async function notifyAzureWithJobResult(
  jobId: string,
  auth: QueuedJobAuth,
  prMetadata: PRMetadata,
  result: StoredJobResult
): Promise<void> {
  if (await hasRedisCommentMarker(jobId)) {
    logger.info('Skipping Azure comment because Redis marker already exists', { jobId, prId: prMetadata.prId });
    return;
  }

  if (await commentAlreadyExistsInAzure(jobId, auth, prMetadata)) {
    await writeRedisCommentMarker(jobId);
    logger.info('Recovered Azure comment marker from existing PR thread', { jobId, prId: prMetadata.prId });
    return;
  }

  const connection = adoClient.createConnection(auth.accessToken, auth.organizationUrl);
  await adoClient.postPRComment({
    projectName: prMetadata.projectName,
    repositoryId: prMetadata.repositoryId,
    prId: prMetadata.prId,
    workItemId: 0,
    connection,
    commentContent: result.commentContent
  });
  await writeRedisCommentMarker(jobId);
}
