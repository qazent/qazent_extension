/**
 * Unit tests for AI module
 */

import { generateTestCases } from './ai';
import { PRMetadata, CodeDiff } from './types';


// Mock GoogleGenAI with a controlled mock function
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
    mockGenerateContent.mockClear();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it('should successfully extract text from AI response and parse JSON', async () => {
    const mockHtmlDescription = `<h2>Purpose</h2><p>Verify the new feature works correctly</p>
<h2>Scope of Change</h2><p>Feature module</p>
<h2>Preconditions</h2><ul><li>System is running</li></ul>
<h2>Test Steps & Expected Results</h2>
<table><tr><th>Step</th><th>Expected Result</th></tr>
<tr><td>Open app</td><td>App opens</td></tr>
<tr><td>Click feature button</td><td>Button responds</td></tr>
<tr><td>Verify result</td><td>Feature works</td></tr></table>
<h2>Negative Scenarios</h2><ul><li>Test with invalid input</li></ul>
<h2>Edge Cases</h2><ul><li>Test with empty data</li></ul>
<h2>Regression Areas</h2><ul><li>Existing features</li></ul>
<h2>Data Requirements</h2><ul><li>Test user account</li></ul>
<h2>Automation Notes</h2><p>Can be automated with Selenium</p>`;

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Feature Functionality',
        htmlDescription: mockHtmlDescription
      })
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Feature Functionality');
    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
    expect(result.htmlDescription).toContain('<table>');
  });

  it('should handle AI response with markdown JSON wrapper', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '```json\n{"title": "Test Case: Test Title", "htmlDescription": "<h2>Purpose</h2><p>Test Purpose</p><h2>Scope of Change</h2><p>Test</p><h2>Preconditions</h2><p>None</p><h2>Test Steps & Expected Results</h2><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>Step 1</td><td>Result 1</td></tr></table><h2>Negative Scenarios</h2><p>None</p><h2>Edge Cases</h2><p>None</p><h2>Regression Areas</h2><p>None</p><h2>Data Requirements</h2><p>None</p><h2>Automation Notes</h2><p>Automate with unit tests</p>"}\n```'
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Test Title');
    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
    expect(result.htmlDescription).toContain('<p>Test Purpose</p>');
  });

  it('should throw error when AI returns empty response', async () => {
    mockGenerateContent.mockResolvedValue({ text: '' });

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('AI returned empty response');
  });

  it('should throw error when AI returns non-JSON text', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'This is plain text, not JSON'
    });

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('Failed to generate test cases after 2 attempts');
  });

  it('should throw error when required fields are missing', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Incomplete'
      })
    });

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('Missing required field: htmlDescription');
  });

  it('should handle Gemini API errors gracefully', async () => {
    mockGenerateContent.mockRejectedValue(
      new Error('API rate limit exceeded')
    );

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('Failed to generate test cases after 2 attempts');
  });

  it('should retry once on parsing failure then succeed', async () => {
    const mockHtmlDescription = `<h2>Purpose</h2><p>Retry test</p>
<h2>Scope of Change</h2><p>Test module</p>
<h2>Preconditions</h2><p>None</p>
<h2>Test Steps & Expected Results</h2>
<table><tr><th>Step</th><th>Expected Result</th></tr>
<tr><td>Step 1</td><td>Result 1</td></tr></table>
<h2>Negative Scenarios</h2><p>None</p>
<h2>Edge Cases</h2><p>None</p>
<h2>Regression Areas</h2><p>None</p>
<h2>Data Requirements</h2><p>None</p>
<h2>Automation Notes</h2><p>Unit tests</p>`;

    mockGenerateContent
      .mockResolvedValueOnce({ text: 'Invalid JSON on first attempt' })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'Test Case: Retry Success',
          htmlDescription: mockHtmlDescription
        })
      });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(result.title).toBe('Test Case: Retry Success');
    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
  });

  it('should throw after two failed attempts', async () => {
    mockGenerateContent
      .mockRejectedValueOnce(new Error('First failure'))
      .mockRejectedValueOnce(new Error('Second failure'));

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('Failed to generate test cases after 2 attempts');

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

});