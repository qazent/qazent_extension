/**
 * Unit tests for AI module
 */

import { generateTestCases, extractJSON, extractPurposeAndScope } from '../src/backend/ai';
import { PRMetadata, CodeDiff } from '../src/backend/types';
import { MIN_VALID_HTML, NUMBERED_H3_VALID_HTML } from './utils/fixtures';


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

  it('retries with relaxed section thresholds after truncation failure', async () => {
    const firstAttemptHtml = [
      '<h3>1. Purpose</h3><p>Initial response is a bit too sparse for first-pass validation.</p>',
      '<h3>2. Scope of Change</h3><p>Only a few sections were generated.</p>',
      '<h3>3. Preconditions</h3><p>Backend is running.</p>',
      '<h3>4. Test Steps &amp; Expected Results</h3><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>1</td><td>Retry kicks in</td></tr></table>',
      'x'.repeat(1200),
    ].join('');

    const secondAttemptHtml = [
      '<h3>1. Purpose</h3><p>Retry returns one additional section.</p>',
      '<h3>2. Scope of Change</h3><p>Validation accepts this on retry.</p>',
      '<h3>3. Preconditions</h3><p>Backend is running.</p>',
      '<h3>4. Test Steps &amp; Expected Results</h3><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>1</td><td>Retry succeeds</td></tr></table>',
      '<h3>5. Negative Scenarios</h3><p>Still reject clearly truncated junk.</p>',
      'x'.repeat(1200),
    ].join('');

    mockGenerateContent
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'Test Case: Retry needed',
          htmlDescription: firstAttemptHtml
        })
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'Test Case: Retry succeeds',
          htmlDescription: secondAttemptHtml
        })
      });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(result.title).toBe('Test Case: Retry succeeds');
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

  it('accepts numbered h3 headings as valid structured output', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Numbered H3',
        htmlDescription: NUMBERED_H3_VALID_HTML
      })
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Numbered H3');
    expect(result.htmlDescription).toContain('<h3>1. Purpose</h3>');
    expect(result.htmlDescription).toContain('<h3>11. Automation Notes</h3>');
  });

  it('accepts inline formatting inside headings', async () => {
    const html = [
      '<h2><strong>Purpose</strong></h2><p>Verify the new heading parser.</p>',
      '<h2>Scope of Change</h2><p>Applies to AI validation and extraction.</p>',
      '<h2>Preconditions</h2><p>PR data is available.</p>',
      '<h2>Test Steps &amp; Expected Results</h2><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>1</td><td>Validation succeeds</td></tr></table>',
      '<h2>Negative Scenarios</h2><p>Reject short junk responses.</p>',
      '<h2>Edge Cases</h2><p>Allow numbered and formatted headings.</p>',
      '<h2><strong>Automation Notes</strong></h2><p>Unit tests cover parsing.</p>',
      'x'.repeat(900),
    ].join('');

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Formatted headings',
        htmlDescription: html
      })
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Formatted headings');
    expect(result.htmlDescription).toContain('<h2><strong>Automation Notes</strong></h2>');
  });

  it('accepts shorter valid output when heading structure is present', async () => {
    const html = [
      '<h3>1. Purpose</h3><p>Shorter output is still valid for small diffs.</p>',
      '<h3>2. Scope of Change</h3><p>Only AI validation logic changed.</p>',
      '<h3>3. Preconditions</h3><p>Run against a small backend PR.</p>',
      '<h3>4. Test Steps &amp; Expected Results</h3><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>1</td><td>HTTP 200 returned</td></tr></table>',
      '<h3>5. Negative Scenarios</h3><p>Malformed JSON still fails.</p>',
      '<h3>6. Automation Notes</h3><p>Automate with existing unit tests.</p>',
      'x'.repeat(500),
    ].join('');

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Short valid output',
        htmlDescription: html
      })
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.title).toBe('Test Case: Short valid output');
    expect(result.htmlDescription.length).toBeGreaterThanOrEqual(800);
  });

  it('preserves safe table attributes through sanitization', async () => {
    const html = [
      '<h2>Purpose</h2><p>Verify safe table attributes are preserved.</p>',
      '<h2>Scope of Change</h2><p>Generated HTML includes formatted tables.</p>',
      '<h2>Preconditions</h2><p>AI returns supported table markup.</p>',
      '<h2>Test Steps &amp; Expected Results</h2><table border="1" cellspacing="0" cellpadding="5"><tr><th>Step</th><th>Expected Result</th></tr><tr><td>1</td><td>Attributes remain</td></tr></table>',
      '<h2>Negative Scenarios</h2><p>Disallowed scripts are still removed.</p>',
      '<h2>Edge Cases</h2><p>Sanitizer keeps safe formatting.</p>',
      '<h2>Automation Notes</h2><p>Snapshot sanitized table markup.</p>',
      'x'.repeat(900),
    ].join('');

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Table attributes',
        htmlDescription: html
      })
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff);

    expect(result.htmlDescription).toContain('<table border="1" cellspacing="0" cellpadding="5">');
  });

  it('still rejects obviously truncated structured output', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Truncated',
        htmlDescription: '<h2>Automation Notes</h2><p>Use Playwright.</p>'
      })
    });

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('AI response truncated - missing sections');
  });

  it('does not treat paragraph mentions of automation notes as a valid section', async () => {
    const html = [
      '<h2>Purpose</h2><p>Refer to the automation notes section for follow-up work.</p>',
      '<p>This output is intentionally long but structurally incomplete.</p>',
      '<p>' + 'x'.repeat(900) + '</p>',
    ].join('');

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Test Case: Paragraph mention only',
        htmlDescription: html
      })
    });

    await expect(generateTestCases(mockPRMetadata, mockCodeDiff))
      .rejects.toThrow('AI response truncated - missing sections');
  });
});

describe('extractPurposeAndScope', () => {
  it('returns remaining content when numbered h3 headings have no later h2 boundary', () => {
    const html = [
      '<h3>1. Purpose</h3><p>Describe the change.</p>',
      '<h3>2. Scope of Change</h3><p>List impacted modules.</p>',
      '<h3>3. Preconditions</h3><p>Have a seeded environment.</p>',
    ].join('');

    expect(extractPurposeAndScope(html)).toBe(html);
  });

  it('returns empty string when no purpose heading is present', () => {
    expect(extractPurposeAndScope('<h3>Scope of Change</h3><p>Only scope.</p>')).toBe('');
  });

  it('keeps h3 subsections inside the Scope of Change section until the next h2', () => {
    const html = [
      '<h2>Purpose</h2><p>Summarize the change.</p>',
      '<h2>Scope of Change</h2>',
      '<h3>Backend</h3><p>API details.</p>',
      '<h3>Frontend</h3><p>UI details.</p>',
      '<h2>Preconditions</h2><p>Next major section.</p>',
    ].join('');

    expect(extractPurposeAndScope(html)).toBe(
      '<h2>Purpose</h2><p>Summarize the change.</p><h2>Scope of Change</h2><h3>Backend</h3><p>API details.</p><h3>Frontend</h3><p>UI details.</p>'
    );
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