/**
 * @jest-environment node
 */

import { generateUnifiedDiff } from '../../src/backend/ado-client';
import { CodeDiff } from '../../src/backend/types';
import {
  applySuggestedCode,
  buildPullRequestThreadContext,
  buildThreadContext,
  getLineTextFromUnifiedDiff,
  resolveInlineCommentThreads,
} from '../../src/backend/inline-comment-threads';

function makeDiff(overrides: Partial<CodeDiff> = {}): CodeDiff {
  return {
    totalChanges: 2,
    latestIterationId: 2,
    changes: [
      {
        filePath: '/src/edited.ts',
        changeType: 'edit',
        linesAdded: 4,
        linesDeleted: 2,
        diffContent: '@@ diff @@',
        changeTrackingId: 7,
        oldLineCount: 20,
        newLineCount: 22,
      },
      {
        filePath: 'src/deleted.ts',
        changeType: 'delete',
        linesAdded: 0,
        linesDeleted: 8,
        diffContent: '@@ delete @@',
        changeTrackingId: 8,
        oldLineCount: 8,
        newLineCount: 0,
      },
      {
        filePath: '/src/added.ts',
        changeType: 'add',
        linesAdded: 5,
        linesDeleted: 0,
        diffContent: '@@ add @@',
        changeTrackingId: 9,
        oldLineCount: 0,
        newLineCount: 5,
      },
    ],
    ...overrides,
  };
}

describe('buildThreadContext', () => {
  it('anchors add/edit comments on the right file', () => {
    expect(buildThreadContext({ filePath: 'src/edited.ts', line: 5, side: 'right', lineLength: 13 })).toEqual({
      filePath: '/src/edited.ts',
      leftFileEnd: null,
      leftFileStart: null,
      rightFileEnd: { line: 5, offset: 13 },
      rightFileStart: { line: 5, offset: 1 },
    });
  });

  it('anchors delete comments on the left file', () => {
    expect(buildThreadContext({ filePath: '/src/deleted.ts', line: 3, side: 'left' })).toEqual({
      filePath: '/src/deleted.ts',
      leftFileEnd: { line: 3, offset: 1 },
      leftFileStart: { line: 3, offset: 1 },
      rightFileEnd: null,
      rightFileStart: null,
    });
  });

  it('highlights an explicit character span like the ADO sample request', () => {
    expect(
      buildThreadContext({
        filePath: '/new_feature.cpp',
        line: 5,
        side: 'right',
        startOffset: 1,
        endOffset: 13,
      })
    ).toEqual({
      filePath: '/new_feature.cpp',
      leftFileEnd: null,
      leftFileStart: null,
      rightFileEnd: { line: 5, offset: 13 },
      rightFileStart: { line: 5, offset: 1 },
    });
  });
});

describe('getLineTextFromUnifiedDiff', () => {
  const oldContent = ['keep-a', 'keep-b', 'keep-c'].join('\n');
  const newContent = ['keep-a', '    filament_preset = item.filament_preset;', 'keep-b', 'keep-c'].join('\n');
  const { diffContent } = generateUnifiedDiff('src/edited.ts', oldContent, newContent);

  it('reads the new-file line that a right-side comment should highlight', () => {
    expect(getLineTextFromUnifiedDiff(diffContent, 2, 'right')).toBe(
      '    filament_preset = item.filament_preset;'
    );
  });

  it('reads the old-file line that a left-side comment should highlight', () => {
    expect(getLineTextFromUnifiedDiff(diffContent, 2, 'left')).toBe('keep-b');
  });
});

describe('applySuggestedCode', () => {
  it('appends a suggested replacement as a pre/code block', () => {
    expect(
      applySuggestedCode('<p>Missing null check before <code>filament_preset</code>.</p>', {
        suggestedCode: '    if (!item.filament_preset)\n        continue;',
      })
    ).toBe(
      '<p>Missing null check before <code>filament_preset</code>.</p><p><strong>Suggested code:</strong></p><pre><code>    if (!item.filament_preset)\n        continue;</code></pre>'
    );
  });

  it('does not duplicate an existing suggested-code section', () => {
    const html =
      '<p>Missing null check.</p><p><strong>Suggested code:</strong></p><pre><code>if (!x) continue;</code></pre>';
    expect(applySuggestedCode(html, { suggestedCode: 'if (!x) continue;' })).toBe(html);
  });
});

describe('buildPullRequestThreadContext', () => {
  it('uses iteration 1 vs latest, including a single-iteration PR', () => {
    expect(buildPullRequestThreadContext({ changeTrackingId: 4, latestIterationId: 1 })).toEqual({
      changeTrackingId: 4,
      iterationContext: {
        firstComparingIteration: 1,
        secondComparingIteration: 1,
      },
    });
  });

  it('does not hardcode secondComparingIteration as 2', () => {
    expect(buildPullRequestThreadContext({ changeTrackingId: 11, latestIterationId: 3 })).toEqual({
      changeTrackingId: 11,
      iterationContext: {
        firstComparingIteration: 1,
        secondComparingIteration: 3,
      },
    });
  });

  it('uses the provided firstComparingIteration when it is valid', () => {
    expect(
      buildPullRequestThreadContext({
        changeTrackingId: 11,
        latestIterationId: 5,
        firstComparingIteration: 2,
      })
    ).toEqual({
      changeTrackingId: 11,
      iterationContext: {
        firstComparingIteration: 2,
        secondComparingIteration: 5,
      },
    });
  });
});

describe('resolveInlineCommentThreads', () => {
  it('builds a valid ADO thread for a right-side edit', () => {
    const result = resolveInlineCommentThreads(
      [
        {
          filePath: 'src/edited.ts',
          line: 5,
          side: 'right',
          contentHtml: '<p>Null check is missing</p>',
          severity: 'Major',
        },
      ],
      makeDiff()
    );

    expect(result.skippedInlineComments).toEqual([]);
    expect(result.inlineComments).toHaveLength(1);
    expect(result.inlineComments[0]).toEqual({
      comments: [
        {
          parentCommentId: 0,
          content: '<p>Null check is missing</p>',
          commentType: 1,
        },
      ],
      status: 1,
      threadContext: {
        filePath: '/src/edited.ts',
        leftFileEnd: null,
        leftFileStart: null,
        rightFileEnd: { line: 5, offset: 1 },
        rightFileStart: { line: 5, offset: 1 },
      },
      pullRequestThreadContext: {
        changeTrackingId: 7,
        iterationContext: {
          firstComparingIteration: 1,
          secondComparingIteration: 2,
        },
      },
    });
  });

  it('builds a left-side thread for a deleted file', () => {
    const result = resolveInlineCommentThreads(
      [{ filePath: '/src/deleted.ts', line: 2, side: 'left', contentHtml: '<p>Dead path</p>' }],
      makeDiff()
    );

    expect(result.skippedInlineComments).toEqual([]);
    expect(result.inlineComments[0].threadContext.leftFileStart).toEqual({ line: 2, offset: 1 });
    expect(result.inlineComments[0].threadContext.rightFileStart).toBeNull();
    expect(result.inlineComments[0].pullRequestThreadContext.changeTrackingId).toBe(8);
  });

  it('skips unknown files', () => {
    const result = resolveInlineCommentThreads(
      [{ filePath: '/no/such.ts', line: 1, side: 'right', contentHtml: '<p>x</p>' }],
      makeDiff()
    );
    expect(result.inlineComments).toEqual([]);
    expect(result.skippedInlineComments).toEqual([
      { filePath: '/no/such.ts', line: 1, reason: 'unknown_file' },
    ]);
  });

  it('accepts numeric line numbers sent as strings', () => {
    const result = resolveInlineCommentThreads(
      [{ filePath: 'src/edited.ts', line: '5' as unknown as number, side: 'right', contentHtml: '<p>ok</p>' }],
      makeDiff()
    );
    expect(result.skippedInlineComments).toEqual([]);
    expect(result.acceptedComments).toEqual([
      { filePath: 'src/edited.ts', line: 5, side: 'right', contentHtml: '<p>ok</p>' },
    ]);
    expect(result.inlineComments[0].threadContext.rightFileStart).toEqual({ line: 5, offset: 1 });
  });

  it('keeps comments when line counts are missing (fallback diffs)', () => {
    const result = resolveInlineCommentThreads(
      [{ filePath: '/src/edited.ts', line: 5, side: 'right', contentHtml: '<p>fallback</p>' }],
      makeDiff({
        changes: [
          {
            filePath: '/src/edited.ts',
            changeType: 'edit',
            linesAdded: 4,
            linesDeleted: 2,
            diffContent: '@@ fallback @@',
            changeTrackingId: 7,
          },
        ],
      })
    );
    expect(result.skippedInlineComments).toEqual([]);
    expect(result.inlineComments).toHaveLength(1);
  });

  it('highlights the non-whitespace span of the target diff line', () => {
    const oldContent = ['keep-a', 'keep-b', 'keep-c'].join('\n');
    const newContent = ['keep-a', '    filament_preset = item.filament_preset;', 'keep-b', 'keep-c'].join('\n');
    const { diffContent } = generateUnifiedDiff('/src/edited.ts', oldContent, newContent);
    const lineText = '    filament_preset = item.filament_preset;';

    const result = resolveInlineCommentThreads(
      [{ filePath: '/src/edited.ts', line: 2, side: 'right', contentHtml: '<p>Use the selected filament</p>' }],
      makeDiff({
        changes: [
          {
            filePath: '/src/edited.ts',
            changeType: 'edit',
            linesAdded: 1,
            linesDeleted: 0,
            diffContent,
            changeTrackingId: 7,
            oldLineCount: 3,
            newLineCount: 4,
          },
        ],
      })
    );

    expect(result.inlineComments[0].threadContext.rightFileStart).toEqual({
      line: 2,
      offset: lineText.search(/\S/) + 1,
    });
    expect(result.inlineComments[0].threadContext.rightFileEnd).toEqual({
      line: 2,
      offset: lineText.length,
    });
  });

  it('highlights inline code even when a suggested pre/code block is present', () => {
    const oldContent = ['keep-a', 'keep-b'].join('\n');
    const newContent = ['keep-a', '    filament_preset = item.filament_preset;'].join('\n');
    const { diffContent } = generateUnifiedDiff('/src/edited.ts', oldContent, newContent);
    const lineText = '    filament_preset = item.filament_preset;';
    const snippet = 'filament_preset';

    const result = resolveInlineCommentThreads(
      [
        {
          filePath: '/src/edited.ts',
          line: 2,
          side: 'right',
          contentHtml:
            '<p>Null check <code>filament_preset</code></p><p><strong>Suggested code:</strong></p><pre><code>if (!item.filament_preset)\n    continue;</code></pre>',
        },
      ],
      makeDiff({
        changes: [
          {
            filePath: '/src/edited.ts',
            changeType: 'edit',
            linesAdded: 1,
            linesDeleted: 0,
            diffContent,
            changeTrackingId: 7,
            oldLineCount: 2,
            newLineCount: 2,
          },
        ],
      })
    );

    expect(result.inlineComments[0].threadContext.rightFileStart).toEqual({
      line: 2,
      offset: lineText.indexOf(snippet) + 1,
    });
    expect(result.inlineComments[0].threadContext.rightFileEnd).toEqual({
      line: 2,
      offset: lineText.indexOf(snippet) + snippet.length,
    });
  });

  it('highlights a quoted code snippet on the target line', () => {
    const oldContent = ['keep-a', 'keep-b'].join('\n');
    const newContent = ['keep-a', '    filament_preset = item.filament_preset;'].join('\n');
    const { diffContent } = generateUnifiedDiff('/src/edited.ts', oldContent, newContent);
    const lineText = '    filament_preset = item.filament_preset;';
    const snippet = 'filament_preset';

    const result = resolveInlineCommentThreads(
      [
        {
          filePath: '/src/edited.ts',
          line: 2,
          side: 'right',
          contentHtml: '<p>Null check <code>filament_preset</code></p>',
        },
      ],
      makeDiff({
        changes: [
          {
            filePath: '/src/edited.ts',
            changeType: 'edit',
            linesAdded: 1,
            linesDeleted: 0,
            diffContent,
            changeTrackingId: 7,
            oldLineCount: 2,
            newLineCount: 2,
          },
        ],
      })
    );

    expect(result.inlineComments[0].threadContext.rightFileStart).toEqual({
      line: 2,
      offset: lineText.indexOf(snippet) + 1,
    });
    expect(result.inlineComments[0].threadContext.rightFileEnd).toEqual({
      line: 2,
      offset: lineText.indexOf(snippet) + snippet.length,
    });
  });

  it('uses explicit offset/endOffset from the comment payload when they fit the line', () => {
    const oldContent = ['int value = 42;'].join('\n');
    const newContent = ['int value = 42;'].join('\n');
    const { diffContent } = generateUnifiedDiff('/src/edited.ts', oldContent, newContent);

    const result = resolveInlineCommentThreads(
      [
        {
          filePath: '/src/edited.ts',
          line: 1,
          side: 'right',
          contentHtml: '<p>Should we add a comment about what this value means?</p>',
          offset: 1,
          endOffset: 13,
        },
      ],
      makeDiff({
        changes: [
          {
            filePath: '/src/edited.ts',
            changeType: 'edit',
            linesAdded: 0,
            linesDeleted: 0,
            diffContent,
            changeTrackingId: 7,
            oldLineCount: 1,
            newLineCount: 1,
          },
        ],
      })
    );

    expect(result.inlineComments[0].threadContext.rightFileStart).toEqual({ line: 1, offset: 1 });
    expect(result.inlineComments[0].threadContext.rightFileEnd).toEqual({ line: 1, offset: 13 });
  });

  it('uses firstComparingIteration from the diff when resolving', () => {
    const result = resolveInlineCommentThreads(
      [{ filePath: 'src/edited.ts', line: 5, side: 'right', contentHtml: '<p>ok</p>' }],
      makeDiff({ firstComparingIteration: 2, latestIterationId: 4 })
    );
    expect(result.inlineComments[0].pullRequestThreadContext.iterationContext).toEqual({
      firstComparingIteration: 2,
      secondComparingIteration: 4,
    });
  });

  it('skips non-positive or out-of-range lines', () => {
    const result = resolveInlineCommentThreads(
      [
        { filePath: '/src/edited.ts', line: 0, side: 'right', contentHtml: '<p>x</p>' },
        { filePath: '/src/edited.ts', line: 99, side: 'right', contentHtml: '<p>x</p>' },
      ],
      makeDiff()
    );
    expect(result.inlineComments).toEqual([]);
    expect(result.skippedInlineComments).toEqual([
      { filePath: '/src/edited.ts', line: 0, reason: 'invalid_line' },
      { filePath: '/src/edited.ts', line: 99, reason: 'invalid_line' },
    ]);
  });

  it('skips right-side comments on deletes and left-side comments on adds', () => {
    const result = resolveInlineCommentThreads(
      [
        { filePath: '/src/deleted.ts', line: 1, side: 'right', contentHtml: '<p>x</p>' },
        { filePath: '/src/added.ts', line: 1, side: 'left', contentHtml: '<p>x</p>' },
      ],
      makeDiff()
    );
    expect(result.inlineComments).toEqual([]);
    expect(result.skippedInlineComments).toEqual([
      { filePath: '/src/deleted.ts', line: 1, reason: 'side_mismatch' },
      { filePath: '/src/added.ts', line: 1, reason: 'side_mismatch' },
    ]);
  });

  it('skips findings when iteration metadata is missing', () => {
    const result = resolveInlineCommentThreads(
      [{ filePath: '/src/edited.ts', line: 5, side: 'right', contentHtml: '<p>x</p>' }],
      makeDiff({
        latestIterationId: undefined,
        changes: [
          {
            filePath: '/src/edited.ts',
            changeType: 'edit',
            linesAdded: 1,
            linesDeleted: 1,
            diffContent: '@@',
            oldLineCount: 10,
            newLineCount: 10,
          },
        ],
      })
    );
    expect(result.inlineComments).toEqual([]);
    expect(result.skippedInlineComments[0].reason).toBe('missing_iteration');
  });

  it('keeps the 10 highest-severity valid comments', () => {
    const raw = [
      ...Array.from({ length: 8 }, (_, i) => ({
        filePath: '/src/edited.ts',
        line: i + 1,
        side: 'right' as const,
        contentHtml: `<p>nit ${i}</p>`,
        severity: 'Nit' as const,
      })),
      {
        filePath: '/src/edited.ts',
        line: 9,
        side: 'right' as const,
        contentHtml: '<p>blocker</p>',
        severity: 'Blocker' as const,
      },
      {
        filePath: '/src/edited.ts',
        line: 10,
        side: 'right' as const,
        contentHtml: '<p>major</p>',
        severity: 'Major' as const,
      },
      {
        filePath: '/src/edited.ts',
        line: 11,
        side: 'right' as const,
        contentHtml: '<p>extra nit</p>',
        severity: 'Nit' as const,
      },
    ];

    const result = resolveInlineCommentThreads(raw, makeDiff());
    expect(result.inlineComments).toHaveLength(10);
    expect(result.inlineComments[0].comments[0].content).toBe('<p>blocker</p>');
    expect(result.inlineComments[1].comments[0].content).toBe('<p>major</p>');
    expect(result.inlineComments.map((thread) => thread.comments[0].content)).not.toContain('<p>extra nit</p>');
  });
});
