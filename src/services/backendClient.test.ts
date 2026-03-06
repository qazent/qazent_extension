/**
 * Unit tests for backend client - Custom Context feature
 */

import { generateTestCases } from './backendClient';
import { afterEach, describe, it, expect, beforeEach, jest } from '@jest/globals';

// ---- Typed fetch mock ----
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<any>;
const fetchMock = jest.fn() as jest.MockedFunction<FetchFn>;
(global as any).fetch = fetchMock;

// ---- Helper type for reading request body safely ----
interface FetchRequestInit {
  body: string;
}

describe('Backend Client - Custom Context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  const mockSuccessResponse = {
    title: 'Test Case: Feature',
    purpose: 'Test the new feature',
    scopeOfChange: 'Authentication module',
    preconditions: ['User logged out'],
    testSteps: ['Step 1', 'Step 2'],
    expectedResults: ['Result 1'],
    negativeScenarios: ['Invalid credentials'],
    edgeCases: ['Empty input'],
    regressionAreas: ['Login flow'],
    dataRequirements: ['Test user'],
    automationNotes: 'Can be automated'
  };

  describe('generateTestCases with customContext', () => {
    it('should include customContext in request body when provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      } as any);

      const customContext = 'Use Jest for testing';
      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', customContext);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/generate-tests',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            prId: 123,
            projectName: 'MyProject',
            repositoryId: 'repo-456',
            customContext: 'Use Jest for testing'
          })
        })
      );
    });

    it('should include customContext as undefined when not provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      } as any);

      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000');

      const callArgs = fetchMock.mock.calls[0] as [string, FetchRequestInit];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody).toEqual({
        prId: 123,
        projectName: 'MyProject',
        repositoryId: 'repo-456',
        customContext: undefined
      });
    });

    it('should handle empty string customContext', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      } as any);

      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', '');

      const callArgs = fetchMock.mock.calls[0] as [string, FetchRequestInit];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.customContext).toBe('');
    });

    it('should handle multi-line customContext', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      } as any);

      const multiLineContext = `Line 1
Line 2
Line 3`;

      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', multiLineContext);

      const callArgs = fetchMock.mock.calls[0] as [string, FetchRequestInit];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.customContext).toBe(multiLineContext);
    });

    it('should handle special characters in customContext', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      } as any);

      const specialContext = 'Config: {"test": true, "env": "dev"}';

      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', specialContext);

      const callArgs = fetchMock.mock.calls[0] as [string, FetchRequestInit];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.customContext).toBe(specialContext);
    });
  });

  describe('error handling with customContext', () => {
    it('should handle 400 error with customContext', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Invalid PR data' })
      } as any);

      await expect(
        generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', 'context')
      ).rejects.toThrow('Invalid PR data');
    });

    it('should handle 500 error with customContext', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal server error' })
      } as any);

      await expect(
        generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', 'context')
      ).rejects.toThrow('Backend service failed. Please try again.');
    });

    it('should handle timeout with customContext', async () => {
      // Simulate abort (e.g. from timeout): fetch rejects with AbortError
      fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

      await expect(
        generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', 'context')
      ).rejects.toThrow('Request timed out. Please try again.');
    });

    it('should handle network error with customContext', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network failure'));

      await expect(
        generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', 'context')
      ).rejects.toThrow('Network failure');
    });
  });

  describe('backward compatibility', () => {
    it('should work without customContext parameter (4 parameters)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      } as any);

      const result = await generateTestCases(
        123,
        'MyProject',
        'repo-456',
        'http://localhost:3000'
      );

      expect(result).toEqual(mockSuccessResponse);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});