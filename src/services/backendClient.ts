/**
 * Backend API client for extension
 */

import { GeneratedTestCase, WorkItemResponse, ApiErrorResponse } from '../types/extension-types';

/**
 * Generate test cases for a PR
 */
export async function generateTestCases(
  prId: number,
  projectName: string,
  repositoryId: string,
  backendUrl: string
): Promise<GeneratedTestCase> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const response = await fetch(`${backendUrl}/generate-tests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prId,
        projectName,
        repositoryId
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData: ApiErrorResponse = await response.json();

      if (response.status === 400) {
        throw new Error('Invalid PR data');
      } else if (response.status === 404) {
        throw new Error('PR not found');
      } else if (response.status === 500) {
        throw new Error('Test case generation failed. Please try again.');
      } else {
        throw new Error(errorData.message || errorData.error || 'Unknown error occurred');
      }
    }

    const testCase: GeneratedTestCase = await response.json();
    return testCase;

  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timed out. Please try again.');
      }
      if (error.message.includes('fetch')) {
        throw new Error('Unable to connect to backend service');
      }
      throw error;
    }

    throw new Error('Unable to connect to backend service');
  }
}

/**
 * Create a work item from test case
 */
export async function createWorkItem(
  testCase: GeneratedTestCase,
  prId: number,
  projectName: string,
  repositoryId: string,
  backendUrl: string
): Promise<WorkItemResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

  try {
    const response = await fetch(`${backendUrl}/create-work-item`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        testCase,
        prId,
        projectName,
        repositoryId
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData: ApiErrorResponse = await response.json();

      if (response.status === 400) {
        throw new Error('Invalid test case data');
      } else if (response.status === 500) {
        throw new Error('Work item creation failed');
      } else {
        throw new Error(errorData.message || errorData.error || 'Unknown error occurred');
      }
    }

    const result: WorkItemResponse = await response.json();
    return result;

  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      if (error.message.includes('fetch')) {
        throw new Error('Unable to connect to backend service');
      }
      throw error;
    }

    throw new Error('Unable to connect to backend service');
  }
}
