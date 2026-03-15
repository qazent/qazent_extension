/**
 * Unit tests for AI module - Custom Context feature
 */

import { generateTestCases } from '../src/backend/ai';
import { PRMetadata, CodeDiff } from '../src/backend/types';
import { MIN_VALID_HTML } from './utils/fixtures';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MAX_FILES_WITH_DIFF, TARGET_USER_PROMPT_TOKENS } from '../src/backend/diff-config';

//
// ---- Types for the mock ----
//
interface GenerateContentArgs {
  contents: Array<{
    parts: Array<{ text: string }>;
  }>;
}

interface GenerateContentResponse {
  text: string;
}

// Jest.Mock generics are NOT supported in your environment.
// So we define the function signature ourselves:
type GenerateContentFn = (args: GenerateContentArgs) => Promise<GenerateContentResponse>;

// And cast the mock to that signature:
const mockGenerateContent = jest.fn() as jest.MockedFunction<GenerateContentFn>;

function getCallArgs(callIndex = 0) {
  return mockGenerateContent.mock.calls[callIndex][0] as {
    contents: { parts: { text: string }[] }[];
  };
}

//
// ---- Mock GoogleGenAI ----
//
jest.mock('@google/genai', () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: mockGenerateContent
      }
    }))
  };
});

//
// ---- Mock logger ----
//
jest.mock('../src/backend/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

//
// ---- Mock fs ----
//
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('You are a test case generator.')
}));

//
// ---- Test Suite ----
//
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

    // Default mock response (must pass AI truncation validation: length >= 2500, has Automation Notes)
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Authentication',
        htmlDescription: MIN_VALID_HTML
      })
    });
  });

  //
  // ---- Tests with customContext ----
  //
  describe('with customContext parameter', () => {
    it('should include custom context in the prompt sent to AI', async () => {
      const customContext = 'Use Jest for testing. Follow TDD practices.';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).toContain('Repository-Specific Context:');
      expect(sentPrompt).toContain(customContext);
    });

    it('should place custom context after PR details but before output format instructions', async () => {
      const customContext = 'Testing framework: Mocha';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      const prTitleIndex = sentPrompt.indexOf('PR Title:');
      const contextIndex = sentPrompt.indexOf('Repository-Specific Context:');
      const jsonFormatIndex = sentPrompt.indexOf('Return JSON only:');

      expect(prTitleIndex).toBeLessThan(contextIndex);
      expect(contextIndex).toBeLessThan(jsonFormatIndex);
    });

    it('should handle multi-line custom context correctly', async () => {
      const customContext = `Testing Guidelines:
- Use TypeScript strict mode
- Follow company security policies
- Include edge cases for authentication`;

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).toContain('Testing Guidelines:');
      expect(sentPrompt).toContain('TypeScript strict mode');
      expect(sentPrompt).toContain('edge cases for authentication');
    });

    it('should handle custom context with special characters', async () => {
      const customContext = 'Framework: Jest. Config: {"verbose": true}';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).toContain('{"verbose": true}');
    });

    it('should trim whitespace from custom context', async () => {
      const customContext = '   Use TDD approach   ';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).toContain('Repository-Specific Context:\n   Use TDD approach   ');
    });
  });

  //
  // ---- Tests without customContext ----
  //
  describe('without customContext parameter', () => {
    it('should work without custom context (backward compatibility)', async () => {
      await generateTestCases(mockPRMetadata, mockCodeDiff);

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).not.toContain('Repository-Specific Context:');
    });

    it('should not include custom context when undefined', async () => {
      await generateTestCases(mockPRMetadata, mockCodeDiff, undefined);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).not.toContain('Repository-Specific Context:');
    });

    it('should not include custom context when empty string', async () => {
      await generateTestCases(mockPRMetadata, mockCodeDiff, '');

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).not.toContain('Repository-Specific Context:');
    });

    it('should not include custom context when only whitespace', async () => {
      await generateTestCases(mockPRMetadata, mockCodeDiff, '   \n  \t  ');

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).not.toContain('Repository-Specific Context:');
    });
  });

  //
  // ---- Combined metadata + context ----
  //
  describe('combined with existing PR metadata', () => {
    it('should include both PR details and custom context', async () => {
      const customContext = 'Use integration tests for authentication';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).toContain('PR Title: Add authentication');
      expect(sentPrompt).toContain('Author: developer');
      expect(sentPrompt).toContain('Source Branch: feature/auth');

      expect(sentPrompt).toContain('Repository-Specific Context:');
      expect(sentPrompt).toContain('Use integration tests for authentication');
    });

    it('should include code diff and custom context together', async () => {
      const customContext = 'Focus on security testing';

      await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).toContain('src/auth.ts');
      expect(sentPrompt).toContain('(add)');
      expect(sentPrompt).toContain('+function authenticate()');
      expect(sentPrompt).toContain('Key changes (diffs):');

      expect(sentPrompt).toContain('Focus on security testing');
    });
  });

  //
  // ---- Error handling ----
  //
  describe('error handling with custom context', () => {
    it('should propagate AI errors even when custom context is provided', async () => {
      mockGenerateContent.mockRejectedValue(new Error('AI service unavailable'));

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
            htmlDescription: MIN_VALID_HTML
          })
        });

      const customContext = 'Retry-safe context';

      const result = await generateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(result.title).toBe('Test Case');

      const firstCallPrompt = getCallArgs(0).contents[0].parts[0].text;
      const secondCallPrompt = getCallArgs(1).contents[0].parts[0].text;

      expect(firstCallPrompt).toContain('Retry-safe context');
      expect(secondCallPrompt).toContain('Retry-safe context');
    });
  });

  describe('compressed prompt and compression report', () => {
    it('should return compressionReport with summary and sectionsRemoved', async () => {
      const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

      expect(result.compressionReport).toBeDefined();
      expect(result.compressionReport!.compressionSummary).toBeDefined();
      expect(result.compressionReport!.compressionSummary.length).toBeGreaterThan(0);
      expect(Array.isArray(result.compressionReport!.sectionsRemoved)).toBe(true);
      expect(result.compressionReport!.sectionsRemoved.length).toBeGreaterThan(0);
    });

    it('should send prompt with compact format (bullet file list, key changes)', async () => {
      await generateTestCases(mockPRMetadata, mockCodeDiff);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).toContain('Files changed: 2');
      expect(sentPrompt).toContain('- src/auth.ts (add) +50 -0');
      expect(sentPrompt).toContain('Key changes (diffs):');
      expect(sentPrompt).toContain('--- src/auth.ts ---');
      expect(sentPrompt).toContain('Return JSON only:');
    });

    it('should keep prompt under token target for typical PR', async () => {
      const result = await generateTestCases(mockPRMetadata, mockCodeDiff);
      const sentPrompt = getCallArgs().contents[0].parts[0].text;
      const estimatedTokens = Math.ceil(sentPrompt.length / 4);

      expect(estimatedTokens).toBeLessThanOrEqual(TARGET_USER_PROMPT_TOKENS + 500);
      expect(result.title).toBeDefined();
      expect(result.htmlDescription).toBeDefined();
    });

    it('prioritizes diff blocks for the top files and summarizes the rest', async () => {
      mockCodeDiff = {
        totalChanges: MAX_FILES_WITH_DIFF + 10,
        changes: Array.from({ length: MAX_FILES_WITH_DIFF + 10 }, (_, index) => ({
          filePath: `src/file-${index}.ts`,
          changeType: index % 3 === 0 ? 'add' : 'edit',
          linesAdded: index + 5,
          linesDeleted: index % 2,
          diffContent: [
            `--- a/src/file-${index}.ts`,
            `+++ b/src/file-${index}.ts`,
            '@@ -1,1 +1,2 @@',
            '- old line',
            `+ new line ${index}`,
          ].join('\n'),
        })),
      };

      await generateTestCases(mockPRMetadata, mockCodeDiff);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).toContain(`Files analyzed in detail: ${MAX_FILES_WITH_DIFF + 10}`);
      expect(sentPrompt).toContain(
        `(${10} analyzed files are summarized above without full diff blocks to preserve prompt quality)`
      );
      expect(sentPrompt).toContain('--- src/file-39.ts ---');
    });
  });
});