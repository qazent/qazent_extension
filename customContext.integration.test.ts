/**
 * Integration tests for Custom Context feature
 * Tests the complete flow from frontend to backend to AI
 */

import { generateTestCases as aiGenerateTestCases } from './ai';
import * as backendClient from './src/services/backendClient';
import { PRMetadata, CodeDiff } from './types';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

//
// ---- Types for the AI mock ----
//
interface GenerateContentArgs {
  contents: Array<{
    parts: Array<{ text: string }>;
  }>;
}

interface GenerateContentResponse {
  text: string;
}

type GenerateContentFn = (args: GenerateContentArgs) => Promise<GenerateContentResponse>;
const mockGenerateContent = jest.fn() as jest.MockedFunction<GenerateContentFn>;

function getCallArgs() {
  return mockGenerateContent.mock.calls[0][0] as {
    contents: { parts: { text: string }[] }[];
  };
}

//
// ---- Mock Google GenAI ----
//
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent }
  }))
}));

//
// ---- Mock logger ----
//
jest.mock('./logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

//
// ---- Mock fs ----
//
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('System prompt for testing.')
}));

//
// ---- Mock fetch (backend client) ----
//
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<any>;
const fetchMock = jest.fn() as jest.MockedFunction<FetchFn>;
(global as any).fetch = fetchMock;

//
// ---- Test Suite ----
//
describe('Custom Context - End-to-End Integration', () => {
  const mockPRMetadata: PRMetadata = {
    prId: 123,
    title: 'Add authentication feature',
    description: 'Implements JWT auth',
    author: 'developer',
    authorEmail: 'dev@test.com',
    sourceBranch: 'feature/auth',
    targetBranch: 'main',
    branchName: 'auth',
    repositoryId: 'repo-123',
    repositoryName: 'backend-api',
    projectId: 'proj-456',
    projectName: 'MyProject',
    createDate: new Date('2024-01-01')
  };

  const mockCodeDiff: CodeDiff = {
    totalChanges: 1,
    changes: [
      {
        filePath: 'src/auth.ts',
        changeType: 'add',
        linesAdded: 100,
        linesDeleted: 0,
        diffContent: '+export function authenticate() { ... }'
      }
    ]
  };

  const mockAIResponse = {
    title: 'Test Case: Authentication',
    htmlDescription: '<html><body>Test case for authentication</body></html>'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(mockAIResponse)
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mockAIResponse
    } as any);
  });

  describe('Frontend to Backend to AI flow', () => {
    it('should pass custom context through entire pipeline', async () => {
      const customContext = 'Use Jest for testing. Follow TDD practices.';

      await backendClient.generateTestCases(
        123,
        'MyProject',
        'repo-123',
        'http://localhost:3000',
        customContext
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/generate-tests',
        expect.objectContaining({
          body: expect.stringContaining(customContext)
        })
      );

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const sentPrompt = getCallArgs().contents[0].parts[0].text;

      expect(sentPrompt).toContain('Repository-Specific Context:');
      expect(sentPrompt).toContain(customContext);
    });

    it('should work without custom context (backward compatibility)', async () => {
      await backendClient.generateTestCases(
        123,
        'MyProject',
        'repo-123',
        'http://localhost:3000'
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff);

      const aiCallArgs = mockGenerateContent.mock.calls[0][0];
      const aiPrompt = aiCallArgs.contents[0].parts[0].text;

      expect(aiPrompt).not.toContain('Repository-Specific Context:');
    });

    it('should preserve custom context through retry logic', async () => {
      const customContext = 'Important testing context';

      mockGenerateContent
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValueOnce({ text: JSON.stringify(mockAIResponse) });

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);

      const firstPrompt = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text;
      const secondPrompt = mockGenerateContent.mock.calls[1][0].contents[0].parts[0].text;

      expect(firstPrompt).toContain(customContext);
      expect(secondPrompt).toContain(customContext);
    });
  });

  describe('Combined context scenarios', () => {
    it('should handle project default + repo-specific context combination', async () => {
      const projectDefault = 'Project-wide: Use TypeScript strict mode';
      const repoSpecific = 'Repo-specific: Focus on security testing';
      const combinedContext = `${projectDefault}\n\n${repoSpecific}`;

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, combinedContext);

      const aiCallArgs = mockGenerateContent.mock.calls[0][0];
      const aiPrompt = aiCallArgs.contents[0].parts[0].text;

      expect(aiPrompt).toContain(projectDefault);
      expect(aiPrompt).toContain(repoSpecific);
      expect(aiPrompt).toContain('Repository-Specific Context:');
    });

    it('should handle very long custom context', async () => {
      const longContext = 'Context line\n'.repeat(100);

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, longContext);

      const aiCallArgs = mockGenerateContent.mock.calls[0][0];
      const aiPrompt = aiCallArgs.contents[0].parts[0].text;

      expect(aiPrompt).toContain(longContext);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('should handle special characters in custom context', async () => {
      const specialContext = 'Config: {"test": true, "format": "json"}';

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, specialContext);

      const aiCallArgs = mockGenerateContent.mock.calls[0][0];
      const aiPrompt = aiCallArgs.contents[0].parts[0].text;

      expect(aiPrompt).toContain(specialContext);
    });
  });

  describe('Error handling across layers', () => {
    it('should propagate AI errors to frontend', async () => {
      mockGenerateContent.mockRejectedValue(new Error('AI service down'));

      await expect(
        aiGenerateTestCases(mockPRMetadata, mockCodeDiff, 'context')
      ).rejects.toThrow('AI service down');
    });

    it('should propagate backend errors to frontend', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Backend error' })
      } as any);

      await expect(
        backendClient.generateTestCases(123, 'Project', 'repo', 'http://localhost:3000', 'context')
      ).rejects.toThrow();
    });
  });

  describe('Context positioning in prompt', () => {
    it('should place custom context after PR metadata and before output instructions', async () => {
      const customContext = 'Testing framework: Jest';

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const aiCallArgs = mockGenerateContent.mock.calls[0][0];
      const aiPrompt = aiCallArgs.contents[0].parts[0].text;

      const prTitleIndex = aiPrompt.indexOf('PR Title:');
      const contextIndex = aiPrompt.indexOf('Repository-Specific Context:');
      const outputIndex = aiPrompt.indexOf('Please provide test cases');

      expect(prTitleIndex).toBeGreaterThan(-1);
      expect(contextIndex).toBeGreaterThan(prTitleIndex);
      expect(outputIndex).toBeGreaterThan(contextIndex);
    });

    it('should include code diff before custom context', async () => {
      const customContext = 'Focus on edge cases';

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      const aiCallArgs = mockGenerateContent.mock.calls[0][0];
      const aiPrompt = aiCallArgs.contents[0].parts[0].text;

      const diffIndex = aiPrompt.indexOf('Detailed Changes:');
      const contextIndex = aiPrompt.indexOf('Repository-Specific Context:');

      expect(diffIndex).toBeLessThan(contextIndex);
    });
  });
});