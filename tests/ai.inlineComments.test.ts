/**
 * @jest-environment node
 */

import { generateTestCases } from '../src/backend/ai';
import { PRMetadata, CodeDiff } from '../src/backend/types';

const mockGenerateContent = jest.fn();
const mockReadFileSync = jest.fn((filePath: string) => {
  const path = String(filePath);
  if (path.includes('system-prompt-inline-comments')) {
    return 'INLINE DIFF COMMENTS MODE. Cite new:N and old:N file line numbers.';
  }
  return 'You are a deep technical reviewer.';
});

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: mockGenerateContent,
    },
  })),
  ThinkingLevel: { HIGH: 'HIGH' },
}));

jest.mock('../src/backend/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('fs', () => ({
  readFileSync: (filePath: string) => mockReadFileSync(filePath),
}));

describe('generateTestCases inline comments mode', () => {
  const mockPRMetadata: PRMetadata = {
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
    createDate: new Date('2026-02-21'),
  };

  const mockCodeDiff: CodeDiff = {
    totalChanges: 1,
    latestIterationId: 2,
    firstComparingIteration: 1,
    changes: [
      {
        filePath: '/src/feature.ts',
        changeType: 'edit',
        linesAdded: 10,
        linesDeleted: 2,
        diffContent: [
          '--- a/src/feature.ts',
          '+++ b/src/feature.ts',
          '@@ -1,2 +1,3 @@',
          '  keep',
          '+function newFeature() { return true; }',
        ].join('\n'),
        changeTrackingId: 1,
        oldLineCount: 20,
        newLineCount: 28,
      },
    ],
  };

  const html = '<h2>Summary</h2><p>A defect.</p><h2>Inline comments</h2><p>One finding.</p><h2>Verdict</h2><p>Request changes</p>';

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-api-key';
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it('keeps the default schema and omits inlineComments for deep review', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ title: 'Review', htmlDescription: html }),
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff, undefined, 'deep-review');
    const schema = mockGenerateContent.mock.calls[0][0].config.responseSchema;
    const prompt = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text as string;

    expect(schema.properties).not.toHaveProperty('inlineComments');
    expect(schema.required).not.toContain('inlineComments');
    expect(prompt).not.toContain('INLINE DIFF COMMENTS MODE');
    expect(result).not.toHaveProperty('inlineComments');
  });

  it('does not request inline comments in QA mode', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ title: 'Test Case', htmlDescription: html + 'x'.repeat(800) }),
    });

    await generateTestCases(mockPRMetadata, mockCodeDiff, undefined, 'qa');
    const schema = mockGenerateContent.mock.calls[0][0].config.responseSchema;
    expect(schema.properties).not.toHaveProperty('inlineComments');
  });

  it('loads the dedicated prompt and schema only for inline-comments mode', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Inline Review: feature',
        htmlDescription: html,
        inlineComments: [
          {
            filePath: '/src/feature.ts',
            line: '4',
            side: 'right',
            contentHtml: '<p onclick="alert(1)">Missing null check</p><script>bad()</script>',
            severity: 'Major',
          },
        ],
      }),
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff, undefined, 'inline-comments');
    const request = mockGenerateContent.mock.calls[0][0];
    const prompt = request.contents[0].parts[0].text as string;

    expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining('system-prompt-inline-comments.txt'));
    expect(request.config.responseSchema.properties).toHaveProperty('inlineComments');
    expect(request.config.responseSchema.required).toContain('inlineComments');
    expect(prompt).toContain('INLINE DIFF COMMENTS MODE');
    expect(prompt).toContain('inlineComments');
    expect(prompt).toMatch(/new:\d+/);
    expect(result.inlineComments).toEqual([
      {
        filePath: '/src/feature.ts',
        line: 4,
        side: 'right',
        contentHtml: '<p>Missing null check</p>',
        severity: 'Major',
      },
    ]);
  });

  it('always attaches suggested code as a readable pre/code block', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Inline Review: feature',
        htmlDescription: html,
        inlineComments: [
          {
            filePath: '/src/feature.ts',
            line: 5,
            offset: 1,
            endOffset: 13,
            side: 'right',
            contentHtml: '<p>Missing null check before <code>filament_preset</code>.</p>',
            suggestedCode: '    if (!item.filament_preset)\n        continue;',
            severity: 'Major',
          },
        ],
      }),
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff, undefined, 'inline-comments');
    const schema = mockGenerateContent.mock.calls[0][0].config.responseSchema;
    const prompt = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text as string;

    expect(schema.properties.inlineComments.items.properties).toHaveProperty('suggestedCode');
    expect(prompt).toMatch(/suggestedCode/);
    expect(result.inlineComments?.[0].contentHtml).toBe(
      '<p>Missing null check before <code>filament_preset</code>.</p><p><strong>Suggested code:</strong></p><pre><code>if (!item.filament_preset)\n    continue;</code></pre>'
    );
    expect(result.inlineComments?.[0].suggestedCode).toBe(
      '    if (!item.filament_preset)\n        continue;'
    );
  });

  it('keeps 1-based highlight offsets from the model payload', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        title: 'Inline Review: feature',
        htmlDescription: html,
        inlineComments: [
          {
            filePath: '/src/feature.ts',
            line: 5,
            offset: 1,
            endOffset: 13,
            side: 'right',
            contentHtml: '<p>Should we add a comment about <code>value</code>?</p>',
            severity: 'Minor',
          },
        ],
      }),
    });

    const result = await generateTestCases(mockPRMetadata, mockCodeDiff, undefined, 'inline-comments');
    const schema = mockGenerateContent.mock.calls[0][0].config.responseSchema;
    const prompt = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text as string;

    expect(schema.properties.inlineComments.items.properties).toHaveProperty('offset');
    expect(schema.properties.inlineComments.items.properties).toHaveProperty('endOffset');
    expect(prompt).toMatch(/offset/);
    expect(result.inlineComments).toEqual([
      {
        filePath: '/src/feature.ts',
        line: 5,
        side: 'right',
        contentHtml: '<p>Should we add a comment about <code>value</code>?</p>',
        severity: 'Minor',
        offset: 1,
        endOffset: 13,
      },
    ]);
  });
});
