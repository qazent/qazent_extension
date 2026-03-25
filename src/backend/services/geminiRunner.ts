/**
 * Worker-facing Gemini execution flow built from existing backend services.
 */

import * as adoClient from '../ado-client';
import * as ai from '../ai';
import { fetchPRDiff } from '../fetchPRdiff';
import { QueuedJobAuth, QueuedPRJob, PRMetadata, StoredJobResult } from '../types';

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildCommentContent(jobId: string, title: string, htmlDescription: string): string {
  const extractedPurposeAndScope = ai.extractPurposeAndScope(htmlDescription);
  const primaryBody = extractedPurposeAndScope.length > 0 ? extractedPurposeAndScope : htmlDescription;

  return [
    `<p><strong>${escapeHtml(title)}</strong></p>`,
    primaryBody,
    `<hr /><p><em>Qazent job ID: ${escapeHtml(jobId)}</em></p>`
  ].join('\n');
}

export interface GeminiRunOutput {
  prMetadata: PRMetadata;
  result: StoredJobResult;
}

export async function runGeminiJob(job: QueuedPRJob, auth: QueuedJobAuth): Promise<GeminiRunOutput> {
  const connection = adoClient.createConnection(auth.accessToken, auth.organizationUrl);
  const prMetadata = await adoClient.fetchPRMetadata(job.prId, connection);
  const codeDiff = await fetchPRDiff(
    prMetadata.projectName,
    prMetadata.repositoryId,
    job.prId,
    connection,
    extractOrgName(auth.organizationUrl),
    auth.accessToken
  );
  const generated = await ai.generateTestCases(prMetadata, codeDiff);

  return {
    prMetadata,
    result: {
      jobId: job.jobId,
      prId: job.prId,
      title: generated.title,
      htmlDescription: generated.htmlDescription,
      commentContent: buildCommentContent(job.jobId, generated.title, generated.htmlDescription),
      createdAt: Date.now()
    }
  };
}
