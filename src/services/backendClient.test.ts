/**
 * Unit tests for backend client - Custom Context feature
 */

import { generateTestCases } from './backendClient';

// Mock fetch globally
global.fetch = jest.fn();

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
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      });

      const customContext = 'Use Jest for testing';
      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', customContext);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/generate-tests',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      });

      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000');

      const callArgs = (global.fetch as jest.Mock).mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody).toEqual({
        prId: 123,
        projectName: 'MyProject',
        repositoryId: 'repo-456',
        customContext: undefined
      });
    });

    it('should handle empty string customContext', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      });

      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', '');

      const callArgs = (global.fetch as jest.Mock).mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.customContext).toBe('');
    });

    it('should handle multi-line customContext', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      });

      const multiLineContext = `Line 1
Line 2
Line 3`;

      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', multiLineContext);

      const callArgs = (global.fetch as jest.Mock).mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.customContext).toBe(multiLineContext);
    });

    it('should handle special characters in customContext', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      });

      const specialContext = 'Config: {"test": true, "env": "dev"}';

      await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', specialContext);

      const callArgs = (global.fetch as jest.Mock).mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.customContext).toBe(specialContext);
    });
  });

  describe('error handling with customContext', () => {
    it('should handle 400 error with customContext', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Invalid PR data' })
      });

      await expect(
        generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', 'context')
      ).rejects.toThrow('Invalid PR data');
    });

    it('should handle 500 error with customContext', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal server error' })
      });

      await expect(
        generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', 'context')
      ).rejects.toThrow('Test case generation failed. Please try again.');
    });

    it('should handle timeout with customContext', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(() =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, json: async () => mockSuccessResponse }), 35000);
        })
      );

      const promise = generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', 'context');

      jest.advanceTimersByTime(30000);

      await expect(promise).rejects.toThrow('Request timed out. Please try again.');
    });

    it('should handle network error with customContext', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network failure'));

      await expect(
        generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000', 'context')
      ).rejects.toThrow('Unable to connect to backend service');
    });
  });

  describe('backward compatibility', () => {
    it('should work without customContext parameter (4 parameters)', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse
      });

      const result = await generateTestCases(123, 'MyProject', 'repo-456', 'http://localhost:3000');

      expect(result).toEqual(mockSuccessResponse);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
