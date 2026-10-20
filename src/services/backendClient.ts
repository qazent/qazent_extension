/**
 * Backend API client for Manual Test Case Generation Extension
 * Provides functions to interact with the backend service for generating test cases
 * and creating work items.
 *
 * Security: All requests include Azure DevOps OAuth token in Authorization header
 */

import * as SDK from 'azure-devops-extension-sdk';
import { CommonServiceIds, ILocationService } from "azure-devops-extension-api";

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
const TOKEN_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Get Azure DevOps OAuth token from SDK
 * Caches token to avoid repeated SDK calls
 */
async function getAuthToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  try {
    const token = await SDK.getAccessToken();

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
 * Resolve the Azure DevOps organization URL using the Location Service
 *
 * Correct usage per Microsoft documentation:
 * Passing undefined for both parameters returns the base organization URL.
 */
async function getOrganizationUrl(): Promise<string> {
  const locationService = await SDK.getService<ILocationService>(
    CommonServiceIds.LocationService
  );

  if (!locationService || typeof locationService.getServiceLocation !== 'function') {
    throw new Error('Unable to access Azure DevOps Location Service');
  }

  // ✅ Correct and fully typed usage
  const orgUrl: string = await locationService.getServiceLocation(undefined, undefined);

  if (!orgUrl) {
    throw new Error('Unable to determine Azure DevOps organization URL');
  }

  return orgUrl.replace(/\/+$/, '');
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
    const token = await getAuthToken();
    const orgUrl = await getOrganizationUrl();

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

    if (!response.ok) {
      let errorData: ApiErrorResponse | null = null;

      try {
        errorData = await response.json();
      } catch {}

      const message =
        errorData?.message ||
        errorData?.error ||
        `Backend error (${response.status})`;

      if (response.status === 401 && retryCount === 0) {
        console.warn('Authentication failed, clearing token cache and retrying...');
        clearTokenCache();
        return postJson<T>(url, body, timeoutMs, retryCount + 1);
      }

      switch (response.status) {
        case 400:
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
 */
export interface InlineCommentPayload {
  filePath: string;
  line: number;
  side: 'left' | 'right';
  contentHtml: string;
  severity?: 'Blocker' | 'Major' | 'Minor' | 'Nit';
  offset?: number;
  endOffset?: number;
  suggestedCode?: string;
}

export interface SkippedInlineComment {
  filePath?: string;
  line?: number;
  reason: string;
}

export async function generateTestCases(
  prId: number,
  projectName: string,
  repositoryId: string,
  backendUrl: string,
  customContext: string | undefined,
  mode: 'qa' | 'review' | 'deep-review' | 'inline-comments'
): Promise<GeneratedTestCase & {
  sourceCommitId?: string;
  targetCommitId?: string;
  inlineComments?: InlineCommentPayload[];
  skippedInlineComments?: SkippedInlineComment[];
}> {
  const url = buildUrl(backendUrl, '/generate-tests');

  return postJson<
    GeneratedTestCase & {
      sourceCommitId?: string;
      targetCommitId?: string;
      inlineComments?: InlineCommentPayload[];
      skippedInlineComments?: SkippedInlineComment[];
    }
  >(
    url,
    {
      prId,
      projectName,
      repositoryId,
      customContext,
      mode,
    },
    900000 // 15 minutes — Gemini 4 Argon thinking can run for several minutes on a hard PR

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
    180000 // Increased from 30000 → 180 seconds - creating work items can take longer for complex test cases

  );
}

/**
 * Extract Purpose + Scope of Change HTML from full test case HTML.
 * Calls backend POST /api/extract-purpose-scope.
 */
export async function extractPurposeAndScope(html: string, backendUrl: string): Promise<string> {
  const url = buildUrl(backendUrl, '/api/extract-purpose-scope');
  const response = await postJson<{ extracted: string }>(url, { html }, 30000);
  return response.extracted;
}

/**
 * Parameters for posting a comment on a PR.
 *
 * `connection` is the backend base URL that exposes the `/post-pr-comment` endpoint.
 */
export interface PostPRCommentParams {
  prId: number;
  projectName: string;
  repositoryId: string;
  workItemId?: number;
  connection: string;
  commentContent?: string;
}

export interface PostPRCommentResponse {
  success: boolean;
}

/**
 * Post comment on PR linking to created work item, or with custom content if provided.
 */
export async function postPRComment({
  prId,
  projectName,
  repositoryId,
  workItemId,
  connection,
  commentContent
}: PostPRCommentParams): Promise<PostPRCommentResponse> {
  const url = buildUrl(connection, '/post-pr-comment');

  const response = await postJson<PostPRCommentResponse>(
    url,
    { prId, projectName, repositoryId, workItemId, commentContent },
    180000 // Increased from 10 seconds → 180 seconds - posting comments can take longer if the PR has a lot of activity or if there are API rate limits 
  );

  return {
    success: response.success === true,
  };
}

export interface PostPRInlineCommentsParams {
  prId: number;
  projectName: string;
  repositoryId: string;
  connection: string;
  inlineComments: InlineCommentPayload[];
}

export interface PostPRInlineCommentsResponse {
  posted: number;
  failed: number;
  skipped: number;
}

export async function postPRInlineComments({
  prId,
  projectName,
  repositoryId,
  connection,
  inlineComments,
}: PostPRInlineCommentsParams): Promise<PostPRInlineCommentsResponse> {
  const url = buildUrl(connection, '/post-pr-inline-comments');
  const response = await postJson<PostPRInlineCommentsResponse>(
    url,
    { prId, projectName, repositoryId, inlineComments },
    180000
  );

  return {
    posted: response.posted ?? 0,
    failed: response.failed ?? 0,
    skipped: response.skipped ?? 0,
  };
}

// --- POST PR LABEL VAULTED ---
// export interface PostPRLabelParams {
//   prId: number;
//   projectName: string;
//   repositoryId: string;
//   labelName: string;
//   connection: string;
// }
// export async function postPRLabel({
//   prId,
//   projectName,
//   repositoryId,
//   labelName,
//   connection
// }: PostPRLabelParams): Promise<void> {
//   const url = buildUrl(connection, '/post-pr-label');
//   await postJson<{ success: boolean }>(url, { prId, projectName, repositoryId, labelName }, 30000);
// }