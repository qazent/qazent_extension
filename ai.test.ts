/**
 * Unit tests for AI module
 */

import { generateTestCases } from './ai';
import { PRMetadata, CodeDiff } from './types';
import * as logger from './logger';
import * as fs from 'fs';


// Mock GoogleGenAI
jest.mock('@google/genai', () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: jest.fn()
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

describe('generateTestCases', () => {
  let mockPRMetadata: PRMetadata;
  let mockCodeDiff: CodeDiff;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-api-key';

    mockPRMetadata = {
      prId: 123,
      title: 'Add new feature',
      description: 'This adds a new feature',
      author: 'test-user',
      authorEmail: 'test@example.com',
      sourceBranch: 'feature/new-feature',
      targetBranch: 'main',
      branchName: 'new-feature',
      repositoryId: 'repo-123',
      repositoryName: 'test-repo',
      projectName: 'test-project',
      projectId: 'project-123',
      createDate: new Date('2026-02-21')
    };

    mockCodeDiff = {
      totalChanges: 1,
      changes: [
        {
          filePath: 'src/feature.ts',
          changeType: 'edit',
          linesAdded: 10,
          linesDeleted: 2,
          diffContent: '+function newFeature() { return true; }'
        }
      ]
    };

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it('should successfully extract text from AI response and parse JSON', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Feature Functionality',
        purpose: 'Verify the new feature works correctly',
        scopeOfChange: 'Feature module',
        preconditions: ['System is running'],
        testSteps: ['Open app', 'Click feature button', 'Verify result'],
        expectedResults: ['App opens', 'Button responds', 'Feature works'],
        negativeScenarios: ['Test with invalid input'],
        edgeCases: ['Test with empty data'],
        regressionAreas: ['Existing features'],
        dataRequirements: ['Test user account'],
        automationNotes: 'Can be automated with Selenium'
      })
    });

    const { GoogleGenAI } = require('@google/genai');
    GoogleGenAI.mockImplementation(() => ({
      models: { generateContent: mockGenerateContent }
    }));

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Feature Functionality');
    expect(result.testSteps.length).toBe(result.expectedResults.length);
  });

  it('should handle AI response with markdown JSON wrapper', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      text: '```json\n{"title": "Test Title", "purpose": "Test Purpose", "testSteps": ["Step 1"], "expectedResults": ["Result 1"]}\n```'
    });

    const { GoogleGenAI } = require('@google/genai');
    GoogleGenAI.mockImplementation(() => ({
      models: { generateContent: mockGenerateContent }
    }));

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Title');
    expect(result.purpose).toBe('Test Purpose');
  });

  it('should throw error when AI returns empty response', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({ text: '' });

    const { GoogleGenAI } = require('@google/genai');
    GoogleGenAI.mockImplementation(() => ({
      models: { generateContent: mockGenerateContent }
    }));

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('AI returned empty response');
  });

  it('should throw error when AI returns non-JSON text', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      text: 'This is plain text, not JSON'
    });

    const { GoogleGenAI } = require('@google/genai');
    GoogleGenAI.mockImplementation(() => ({
      models: { generateContent: mockGenerateContent }
    }));

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('Failed to parse AI response as JSON');
  });

  it('should fill defaults for missing fields', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      text: JSON.stringify({
        title: 'Minimal Test Case'
      })
    });

    const { GoogleGenAI } = require('@google/genai');
    GoogleGenAI.mockImplementation(() => ({
      models: { generateContent: mockGenerateContent }
    }));

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.purpose).toBe('N/A');
    expect(result.testSteps).toEqual(['Review changes']);
  });

  it('should handle Gemini API errors gracefully', async () => {
    const mockGenerateContent = jest.fn().mockRejectedValue(
      new Error('API rate limit exceeded')
    );

    const { GoogleGenAI } = require('@google/genai');
    GoogleGenAI.mockImplementation(() => ({
      models: { generateContent: mockGenerateContent }
    }));

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('Gemini API error');
  });

  it('should ensure testSteps and expectedResults have same length', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case',
        testSteps: ['Step 1', 'Step 2', 'Step 3'],
        expectedResults: ['Result 1']
      })
    });

    const { GoogleGenAI } = require('@google/genai');
    GoogleGenAI.mockImplementation(() => ({
      models: { generateContent: mockGenerateContent }
    }));

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.expectedResults).toEqual(['Result 1', 'N/A', 'N/A']);
  });
});