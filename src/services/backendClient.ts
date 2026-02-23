/**
 * Backend API client for Manual Test Case Generation Extension
 * Provides functions to interact with the backend service for generating test cases
 * and creating work items.
 */

import {
  GeneratedTestCase,
  WorkItemResponse,
  ApiErrorResponse
} from '../types/extension-types';

/**
 * Validate that the URL is absolute and properly formed
 * Prevents relative URLs from being resolved against CDN origin
 */
function validateBackendUrl(url: string): void {
  if (!url || url.trim() === '') {
    throw new Error('Backend URL is empty or undefined');
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(`Invalid backend URL: "${url}" - must start with http:// or https://`);
  }

  try {
    new URL(url);
  } catch {
    throw new Error(`Malformed backend URL: "${url}"`);
  }
}

/**
 * Normalize backend URL and append path safely
 */
function buildUrl(base: string, path: string): string {
  validateBackendUrl(base);
  return base.replace(/\/+$/, '') + path;
}

/**
 * Generic helper for backend POST requests with timeout + unified error handling
 */
async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Handle non-OK responses
    if (!response.ok) {
      let errorData: ApiErrorResponse | null = null;

      try {
        errorData = await response.json();
      } catch {
        // ignore JSON parse errors — backend might return HTML on failure
      }

      const message =
        errorData?.message ||
        errorData?.error ||
        `Backend error (${response.status})`;

      switch (response.status) {
        case 400:
          throw new Error('Invalid request data');
        case 404:
          throw new Error('Resource not found');
        case 500:
          throw new Error('Backend service failed. Please try again.');
        default:
          throw new Error(message);
      }
    }

    // Parse JSON safely
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error('Invalid JSON received from backend');
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timed out. Please try again.');
      }
      if (error.message.includes('fetch') || error.message.includes('Failed to')) {
        throw new Error('Unable to connect to backend service');
      }
      throw error;
    }

    throw new Error('Unable to connect to backend service');
  }
}

/**
 * Generate test cases for a PR
 * Returns test case data plus commit IDs needed for work item creation
 */
export async function generateTestCases(
  prId: number,
  projectName: string,
  repositoryId: string,
  backendUrl: string,
  customContext?: string
): Promise<GeneratedTestCase & { sourceCommitId?: string; targetCommitId?: string }> {
  const url = buildUrl(backendUrl, '/generate-tests');

  return postJson<GeneratedTestCase & { sourceCommitId?: string; targetCommitId?: string }>(
    url,
    { prId, projectName, repositoryId, customContext },
    60000 // 60s timeout — backend can take 35–40s for large PRs
  );
}

/**
 * Create a work item from a test case
 */
export async function createWorkItem(
  testCase: GeneratedTestCase,
  prId: number,
  projectName: string,
  repositoryId: string,
  backendUrl: string,
  projectId: string,
  sourceCommitId: string,
  targetCommitId: string,
): Promise<WorkItemResponse> {
  const url = buildUrl(backendUrl, '/create-work-item');

  return postJson<WorkItemResponse>(
    url,
    {
      testCase,
      prId,
      projectName,
      repositoryId,
      projectId,
      sourceCommitId,
      targetCommitId
    },
    30000 // 30s timeout — work item creation is much faster
  );
}

/**
 * Post comment on PR linking to created work item
 */
export async function postPRComment(
  prId: number,
  projectName: string,
  repositoryId: string,
  workItemId: number,
  _workItemUrl: string,
  _testCaseTitle: string,
  backendUrl: string
): Promise<void> {
  const url = buildUrl(backendUrl, '/post-pr-comment');

  


  await postJson<{ success: boolean }>(
    url,
    { prId, projectName, repositoryId, workItemId },
    10000 // 10s timeout
  );
  

}