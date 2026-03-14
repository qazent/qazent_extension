/**
 * Unit tests for AI module
 */

import { generateTestCases, extractJSON } from '../src/backend/ai';
import { PRMetadata, CodeDiff } from '../src/backend/types';
import { MIN_VALID_HTML } from './utils/fixtures';


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

// Mock logger (path used by src/backend/ai.ts)
jest.mock('../src/backend/utils/logger', () => ({
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

  it('should return htmlDescription with raw HTML', async () => {
    const html = '<h2>Purpose</h2><p>Verify the new feature works correctly.</p><h2>Scope of Change</h2><p>Feature module.</p><h2>Preconditions</h2><p>None.</p><h2>Test Steps & Expected Results</h2><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>Step 1</td><td>Result 1</td></tr></table><h2>Negative Scenarios</h2><p>None.</p><h2>Edge Cases</h2><p>None.</p><h2>Regression Areas</h2><p>None.</p><h2>Data Requirements</h2><p>None.</p><h2>Automation Notes</h2><p>Automate with unit tests.</p>' + 'x'.repeat(2500);
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Feature Functionality',
        htmlDescription: html
      })
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Feature Functionality');
    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
    expect(result.htmlDescription).toContain('<table>');
    expect(result.htmlDescription).toContain('Verify the new feature works correctly.');
    expect(result.htmlDescription).not.toContain('<script');
  });

  it('should return htmlDescription with multi-line HTML', async () => {
    const mockHtml = `<h2>Purpose</h2><p>Verify the new feature works correctly</p>
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
<h2>Automation Notes</h2><p>Can be automated with Selenium</p>` + 'x'.repeat(2600);

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Feature Functionality',
        htmlDescription: mockHtml
      })
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Feature Functionality');
    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
    expect(result.htmlDescription).toContain('<table>');
  });

  it('should handle AI response with markdown JSON wrapper', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '```json\n' + JSON.stringify({ title: 'Test Case: Test Title', htmlDescription: MIN_VALID_HTML }) + '\n```'
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Test Title');
    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
    expect(result.htmlDescription).toContain('<h2>Automation Notes</h2>');
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
    mockGenerateContent
      .mockResolvedValueOnce({ text: 'Invalid JSON on first attempt' })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'Test Case: Retry Success',
          htmlDescription: MIN_VALID_HTML
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

  it('should parse when AI returns raw HTML with } inside htmlDescription value', async () => {
    const rawHtmlWithBrace = '<h2>Purpose</h2><p>Test with code } and more</p><h2>Scope of Change</h2><p>Scope</p><h2>Preconditions</h2><p>None</p><h2>Test Steps & Expected Results</h2><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>Step 1</td><td>Result 1</td></tr></table><h2>Negative Scenarios</h2><p>None</p><h2>Edge Cases</h2><p>None</p><h2>Regression Areas</h2><p>None</p><h2>Data Requirements</h2><p>None</p><h2>Automation Notes</h2><p>Unit tests</p>' + 'x'.repeat(2600);
    const responseText = JSON.stringify({
      title: 'Test Case: Brace in HTML',
      htmlDescription: rawHtmlWithBrace
    });
    mockGenerateContent.mockResolvedValue({ text: responseText });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Brace in HTML');
    expect(result.htmlDescription).toContain('code } and more');
    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
  });

  it('should parse when AI returns markdown-wrapped JSON with htmlDescription', async () => {
    const responseText = '```json\n' + JSON.stringify({
      title: 'Test Case: Raw HTML in wrapper',
      htmlDescription: MIN_VALID_HTML
    }) + '\n```';
    mockGenerateContent.mockResolvedValue({ text: responseText });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Raw HTML in wrapper');
    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
    expect(result.htmlDescription).toContain('<h2>Automation Notes</h2>');
  });

  it('should sanitize unsafe HTML before returning generated output', async () => {
    const unsafeHtml =
      '<h2 onclick="alert(1)">Purpose</h2>' +
      '<p>Safe</p>' +
      '<script>alert(2)</script>' +
      '<h2>Scope of Change</h2><p>Scope</p>' +
      '<h2>Preconditions</h2><p>None</p>' +
      '<h2>Test Steps & Expected Results</h2><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>1</td><td>OK</td></tr></table>' +
      '<h2>Negative Scenarios</h2><p>None</p>' +
      '<h2>Edge Cases</h2><p>None</p>' +
      '<h2>Regression Areas</h2><p>None</p>' +
      '<h2>Data Requirements</h2><p>None</p>' +
      '<h2>Automation Notes</h2><p>Unit tests.</p>' +
      'x'.repeat(2600);

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Sanitized',
        htmlDescription: unsafeHtml
      })
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
    expect(result.htmlDescription).toContain('<p>Safe</p>');
    expect(result.htmlDescription).not.toContain('onclick');
    expect(result.htmlDescription).not.toContain('<script');
    expect(result.htmlDescription).not.toContain('alert(');
  });

  it('should accept legacy htmlDescriptionBase64 and decode to htmlDescription', async () => {
    const html = '<h2>Purpose</h2><p>Legacy.</p><h2>Scope of Change</h2><p>Scope.</p><h2>Preconditions</h2><p>None.</p><h2>Test Steps & Expected Results</h2><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>1</td><td>OK</td></tr></table><h2>Negative Scenarios</h2><p>None.</p><h2>Edge Cases</h2><p>None.</p><h2>Regression Areas</h2><p>None.</p><h2>Data Requirements</h2><p>None.</p><h2>Automation Notes</h2><p>Unit tests.</p>' + 'x'.repeat(2600);
    const base64Value = Buffer.from(html, 'utf-8').toString('base64');
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Legacy',
        htmlDescriptionBase64: base64Value
      })
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Legacy');
    expect(result.htmlDescription).toContain('<h2>Purpose</h2>');
    expect(result.htmlDescription).toContain('<h2>Automation Notes</h2>');
    expect(result.htmlDescription).not.toContain('<script');
  });
});

describe('extractJSON', () => {
  it('should return full JSON when } appears inside htmlDescription string value', () => {
    const inner = '<p>Step with } character</p>';
    const json = '{"title":"Test Case: Title","htmlDescription":"' + inner.replace(/"/g, '\\"') + '"}';
    const wrapped = '```json\n' + json + '\n```';
    const extracted = extractJSON(wrapped);
    expect(extracted).toBe(json);
    const parsed = JSON.parse(extracted);
    expect(parsed.title).toBe('Test Case: Title');
    expect(parsed.htmlDescription).toBe(inner);
  });

  it('should use brace-matching so first balanced object is returned', () => {
    const json = '{"title":"T","htmlDescription":"<p>text } here</p>"}';
    const extracted = extractJSON(json);
    expect(extracted).toBe(json);
    const parsed = JSON.parse(extracted);
    expect(parsed.htmlDescription).toBe('<p>text } here</p>');
  });

  it('should strip markdown fences and return first { } object', () => {
    const json = '{"title":"X","htmlDescription":"<p>short</p>"}';
    const withFences = '```json\n' + json + '\n```';
    const extracted = extractJSON(withFences);
    expect(extracted).toBe(json);
  });
});