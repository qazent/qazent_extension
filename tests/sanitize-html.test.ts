const mockWarn = jest.fn();

jest.mock('../src/backend/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: (...args: unknown[]) => mockWarn(...args),
}));

import { sanitizeHTML } from '../src/backend/utils/sanitize-html';

describe('sanitizeHTML', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('preserves expected formatting tags for generated work item content', () => {
    const input =
      '<h2>Summary</h2><p><strong>Verify</strong> output.</p><table><tr><th scope="col">Step</th><th>Expected</th></tr><tr><td colspan="2">Done</td></tr></table>';

    expect(sanitizeHTML(input)).toBe(input);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('preserves safe table attributes used by generated output', () => {
    const input =
      '<table border="1" cellspacing="0" cellpadding="5"><tr><th>Step</th><th>Expected</th></tr><tr><td>1</td><td>OK</td></tr></table>';

    expect(sanitizeHTML(input)).toBe(input);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('removes disallowed tags and dangerous attributes', () => {
    const input = [
      '<h2 onclick="alert(1)">Purpose</h2>',
      '<p>Safe<script>alert("xss")</script></p>',
      '<img src=x onerror="alert(2)">',
      '<a href="javascript:alert(3)" target="_blank">Bad link</a>',
    ].join('');

    const output = sanitizeHTML(input);

    expect(output).toContain('<h2>Summary</h2>');
    expect(output).toContain('<p>Safe</p>');
    expect(output).toContain('<a target="_blank" rel="noopener noreferrer">Bad link</a>');
    expect(output).not.toContain('onclick');
    expect(output).not.toContain('<script');
    expect(output).not.toContain('alert(');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('href="javascript:');
    expect(mockWarn).toHaveBeenCalledWith(
      'HTML sanitization modified content',
      expect.objectContaining({
        source: 'unknown',
        originalLength: input.length,
        sanitizedLength: output.length,
      })
    );
  });

  it('keeps suggested code readable and relatively indented inside pre/code', () => {
    const input =
      '<p>Add a null check.</p><p><strong>Suggested code:</strong></p><pre><code>    if (!item.filament_preset)\n        continue;</code></pre>';

    expect(sanitizeHTML(input)).toBe(
      '<p>Add a null check.</p><p><strong>Suggested code:</strong></p><pre><code>if (!item.filament_preset)\n    continue;</code></pre>'
    );
  });

  it('includes source metadata in sanitization warnings', () => {
    sanitizeHTML('<p onclick="alert(1)">Scope</p>', {
      source: 'ado.postPRComment',
      prId: 42,
      projectName: 'project-name',
      workItemId: 9001,
    });

    expect(mockWarn).toHaveBeenCalledWith(
      'HTML sanitization modified content',
      expect.objectContaining({
        source: 'ado.postPRComment',
        prId: 42,
        projectName: 'project-name',
        workItemId: 9001,
      })
    );
  });
});
