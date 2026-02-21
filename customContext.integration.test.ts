/**
 * Integration tests for Custom Context feature
 * Tests the complete flow from frontend to backend to AI
 */

import { generateTestCases as aiGenerateTestCases } from './ai';
import * as backendClient from './src/services/backendClient';
import { PRMetadata, CodeDiff } from './types';

// Mock Google GenAI
const mockGenerateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent }
  }))
}));

// Mock logger
jest.mock('./logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

// Mock fs
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('System prompt for testing.')
}));

// Mock fetch for backend client
global.fetch = jest.fn();

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

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockAIResponse
    });
  });

  describe('Frontend to Backend to AI flow', () => {
    it('should pass custom context through entire pipeline', async () => {
      const customContext = 'Use Jest for testing. Follow TDD practices.';

      // Step 1: Frontend calls backend client
      await backendClient.generateTestCases(
        123,
        'MyProject',
        'repo-123',
        'http://localhost:3000',
        customContext
      );

      // Verify frontend sent customContext to backend
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/generate-tests',
        expect.objectContaining({
          body: expect.stringContaining(customContext)
        })
      );

      // Step 2: Backend would call AI module (simulated)
      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      // Verify AI received the custom context
      const aiCallArgs = mockGenerateContent.mock.calls[0][0];
      const aiPrompt = aiCallArgs.contents[0].parts[0].text;

      expect(aiPrompt).toContain('Repository-Specific Context:');
      expect(aiPrompt).toContain(customContext);
    });

    it('should work without custom context (backward compatibility)', async () => {
      // Frontend calls without custom context
      await backendClient.generateTestCases(
        123,
        'MyProject',
        'repo-123',
        'http://localhost:3000'
      );

      // Should still work
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Backend calls AI without custom context
      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff);

      // AI should not receive custom context section
      const aiCallArgs = mockGenerateContent.mock.calls[0][0];
      const aiPrompt = aiCallArgs.contents[0].parts[0].text;

      expect(aiPrompt).not.toContain('Repository-Specific Context:');
    });

    it('should preserve custom context through retry logic', async () => {
      const customContext = 'Important testing context';

      // Mock AI failure then success
      mockGenerateContent
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValueOnce({ text: JSON.stringify(mockAIResponse) });

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, customContext);

      // Both attempts should include custom context
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);

      const firstPrompt = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text;
      const secondPrompt = mockGenerateContent.mock.calls[1][0].contents[0].parts[0].text;

      expect(firstPrompt).toContain(customContext);
      expect(secondPrompt).toContain(customContext);
    });
  });

  describe('Combined context scenarios', () => {
    it('should handle project default + repo-specific context combination', async () => {
      // Simulating combined context from frontend
      const projectDefault = 'Project-wide: Use TypeScript strict mode';
      const repoSpecific = 'Repo-specific: Focus on security testing';
      const combinedContext = `${projectDefault}\n\n${repoSpecific}`;

      await aiGenerateTestCases(mockPRMetadata, mockCodeDiff, combinedContext);

      const aiCallArgs = mockGenerateContent.mock.calls[0][0];
      const aiPrompt = aiCallArgs.contents[0].parts[0].text;

      // Should contain both parts
      expect(aiPrompt).toContain(projectDefault);
      expect(aiPrompt).toContain(repoSpecific);
      expect(aiPrompt).toContain('Repository-Specific Context:');
    });

    it('should handle very long custom context', async () => {
      const longContext = 'Context line\n'.repeat(100); // 1400+ characters

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
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Backend error' })
      });

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
