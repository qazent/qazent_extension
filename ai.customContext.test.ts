/**
 * Unit tests for AI module - Custom Context feature
 */

import { generateTestCases } from './ai';
import { PRMetadata, CodeDiff } from './types';

// Mock GoogleGenAI
const mockGenerateContent = jest.fn();

jest.mock('@google/genai', () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: mockGenerateContent
      }
    }))
  };
});

// Mock logger
jest.mock('./logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

// Mock fs for system prompt loading
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('You are a test case generator.')
}));

describe('AI Custom Context Integration', () => {
  let mockPRMetadata: PRMetadata;
  let mockCodeDiff: CodeDiff;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-api-key';

    mockPRMetadata = {
      prId: 123,
      title: 'Add authentication',
      description: 'Implements JWT authentication',
      author: 'developer',
      authorEmail: 'dev@example.com',
      sourceBranch: 'feature/auth',
      targetBranch: 'main',
      branchName: 'auth',
      repositoryId: 'repo-123',
      repositoryName: 'backend-api',
      projectId: 'proj-456',
      projectName: 'MyProject',
      createDate: new Date('2024-01-01')
    };

    mockCodeDiff = {
      totalChanges: 2,
      changes: [
        {
          filePath: 'src/auth.ts',
          changeType: 'add',
          linesAdded: 50,
          linesDeleted: 0,
          diffContent: '+function authenticate() { ... }'
        }
      ]
    };

    // Default mock response
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Authentication',
        htmlDescription: '<html><body>Test description</body></html>'
      })
    });
  });

  describe('with customContext parameter', () => {
    it('should include custom context in the prompt sent to AI', async () => {
      const customContext = 'Use Jest for testing. Follow TDD practices.';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      // Verify generateContent was called
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      // Extract the prompt that was sent
      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      // Verify custom context is included in the prompt
      expect(sentPrompt).toContain('Repository-Specific Context:');
      expect(sentPrompt).toContain(customContext);
    });

    it('should place custom context after PR details but before output format instructions', async () => {
      const customContext = 'Testing framework: Mocha';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      // Verify order: PR metadata comes before custom context
      const prTitleIndex = sentPrompt.indexOf('PR Title:');
      const contextIndex = sentPrompt.indexOf('Repository-Specific Context:');
      const jsonFormatIndex = sentPrompt.indexOf('Please provide test cases');

      expect(prTitleIndex).toBeLessThan(contextIndex);
      expect(contextIndex).toBeLessThan(jsonFormatIndex);
    });

    it('should handle multi-line custom context correctly', async () => {
      const customContext = `Testing Guidelines:
- Use TypeScript strict mode
- Follow company security policies
- Include edge cases for authentication`;

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      expect(sentPrompt).toContain('Testing Guidelines:');
      expect(sentPrompt).toContain('TypeScript strict mode');
      expect(sentPrompt).toContain('edge cases for authentication');
    });

    it('should handle custom context with special characters', async () => {
      const customContext = 'Framework: Jest. Config: {"verbose": true}';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      expect(sentPrompt).toContain('{"verbose": true}');
    });

    it('should trim whitespace from custom context', async () => {
      const customContext = '   Use TDD approach   ';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      // Should not contain leading/trailing whitespace around the context section
      expect(sentPrompt).toContain('Repository-Specific Context:\n   Use TDD approach   ');
    });
  });

  describe('without customContext parameter', () => {
    it('should work without custom context (backward compatibility)', async () => {
      await generateTestCases(mockPRMetadata, mockCodeDiff);

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      // Should not include custom context section
      expect(sentPrompt).not.toContain('Repository-Specific Context:');
    });

    it('should not include custom context when undefined', async () => {
      await generateTestCases(mockPRMetadata, mockCodeDiff, undefined);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      expect(sentPrompt).not.toContain('Repository-Specific Context:');
    });

    it('should not include custom context when empty string', async () => {
      await generateTestCases(mockPRMetadata, mockCodeDiff, '');

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      expect(sentPrompt).not.toContain('Repository-Specific Context:');
    });

    it('should not include custom context when only whitespace', async () => {
      await generateTestCases(mockPRMetadata, mockCodeDiff, '   \n  \t  ');

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      expect(sentPrompt).not.toContain('Repository-Specific Context:');
    });
  });

  describe('combined with existing PR metadata', () => {
    it('should include both PR details and custom context', async () => {
      const customContext = 'Use integration tests for authentication';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      // Verify PR metadata is present
      expect(sentPrompt).toContain('PR Title: Add authentication');
      expect(sentPrompt).toContain('Author: developer');
      expect(sentPrompt).toContain('Source Branch: feature/auth');

      // Verify custom context is present
      expect(sentPrompt).toContain('Repository-Specific Context:');
      expect(sentPrompt).toContain('Use integration tests for authentication');
    });

    it('should include code diff and custom context together', async () => {
      const customContext = 'Focus on security testing';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const sentPrompt = callArgs.contents[0].parts[0].text;

      // Verify code diff is present
      expect(sentPrompt).toContain('File: src/auth.ts');
      expect(sentPrompt).toContain('Type: add');
      expect(sentPrompt).toContain('+function authenticate()');

      // Verify custom context is present
      expect(sentPrompt).toContain('Focus on security testing');
    });
  });

  describe('error handling with custom context', () => {
    it('should propagate AI errors even when custom context is provided', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('AI service unavailable'));

      const customContext = 'Use TDD';

      await expect(
        generateTestCases(mockPRMetadata, mockCodeDiff, customContext)
      ).rejects.toThrow('AI service unavailable');
    });

    it('should retry with custom context on first failure', async () => {
      mockGenerateContent
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValueOnce({
          text: JSON.stringify({
            title: 'Test Case',
            htmlDescription: '<html>Test</html>'
          })
        });

      const customContext = 'Retry-safe context';

      const result = await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      // Should have retried and succeeded
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(result.title).toBe('Test Case');

      // Both calls should include the custom context
      const firstCallPrompt = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text;
      const secondCallPrompt = mockGenerateContent.mock.calls[1][0].contents[0].parts[0].text;

      expect(firstCallPrompt).toContain('Retry-safe context');
      expect(secondCallPrompt).toContain('Retry-safe context');
    });
  });
});
