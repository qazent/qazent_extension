/**
 * Backend API client for Manual Test Case Generation Extension
 * Provides functions to interact with the backend service for generating test cases
 * and creating work items.
 *
 * Security: All requests include Azure DevOps OAuth token in Authorization header
 */

import * as SDK from 'azure-devops-extension-sdk';
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
 * Token cache for Azure DevOps OAuth tokens
 * Cache tokens for 10 minutes (they're valid for 1 hour)
 */
let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get Azure DevOps OAuth token from SDK
 * Caches token to avoid repeated SDK calls
 */
async function getAuthToken(): Promise<string> {
  // Check cache first
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  // Get fresh token from SDK
  try {
    const token = await SDK.getAccessToken();

    // Cache the token
    cachedToken = {
      token,
      expiresAt: Date.now() + TOKEN_CACHE_TTL_MS
    };

    return token;
  } catch (error) {
    console.error('Failed to get access token from Azure DevOps SDK:', error);
    throw new Error('Failed to authenticate. Please refresh the page.');
  }
}

/**
 * Clear cached token (used on 401 errors to force refresh)
 */
function clearTokenCache(): void {
  cachedToken = null;
}

/**
 * Generic helper for backend POST requests with timeout + unified error handling
 * Includes Azure DevOps OAuth token in Authorization header
 * Includes organization URL in X-Ado-Org-Url header for multi-tenant support
 * Implements auto-retry on 401 errors (token expiration)
 */
async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
  retryCount: number = 0
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Get authentication token
    const token = await getAuthToken();

    // Get organization URL from Azure DevOps SDK
    const orgUrl = SDK.getHost().uri; // e.g., https://dev.azure.com/myorg

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Ado-Org-Url': orgUrl
      },
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

      // Handle authentication errors with auto-retry
      if (response.status === 401 && retryCount === 0) {
        console.warn('Authentication failed, clearing token cache and retrying...');
        clearTokenCache();
        // Retry once with fresh token
        return postJson<T>(url, body, timeoutMs, retryCount + 1);
      }

      // Map status codes to user-friendly messages
      switch (response.status) {
        case 400:
          // Provide more specific error for missing organization URL
          if (message.includes('X-Ado-Org-Url') || message.includes('organization')) {
            throw new Error('Organization information missing. Please refresh the page.');
          }
          throw new Error(message || 'Invalid request data');
        case 401:
          throw new Error('Authentication failed. Please refresh the page.');
        case 403:
          throw new Error('You don\'t have permission to perform this action.');
        case 404:
          throw new Error('Resource not found');
        case 429:
          throw new Error('Too many requests. Please wait and try again.');
        case 500:
          throw new Error('Backend service failed. Please try again.');
        case 503:
          throw new Error('Service temporarily unavailable. Please try again later.');
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