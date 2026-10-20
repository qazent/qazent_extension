/**
 * @jest-environment node
 */

import { annotateUnifiedDiffWithLineNumbers, generateUnifiedDiff } from '../../src/backend/ado-client';

describe('generateUnifiedDiff hunk headers', () => {
  it('includes context lines in hunk old/new counts', () => {
    const oldContent = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const newContent = ['a', 'b', 'X', 'd', 'e'].join('\n');

    const { diffContent } = generateUnifiedDiff('src/file.ts', oldContent, newContent, 6000, 1);

    expect(diffContent).toMatch(/@@ -2,3 \+2,3 @@/);
    expect(diffContent).toContain('  b');
    expect(diffContent).toContain('- c');
    expect(diffContent).toContain('+ X');
    expect(diffContent).toContain('  d');
  });

  it('treats a mid-file insertion as added lines, not replacements of the rest of the file', () => {
    const oldContent = ['keep-a', 'keep-b', 'keep-c'].join('\n');
    const newContent = ['keep-a', 'inserted-1', 'inserted-2', 'keep-b', 'keep-c'].join('\n');

    const result = generateUnifiedDiff('src/file.ts', oldContent, newContent, 6000, 1);

    expect(result.linesAdded).toBe(2);
    expect(result.linesDeleted).toBe(0);
    expect(result.diffContent).toContain('+ inserted-1');
    expect(result.diffContent).toContain('+ inserted-2');
    expect(result.diffContent).not.toMatch(/^- keep-b/);
    expect(result.diffContent).not.toMatch(/^- keep-c/);
  });

  it('keeps a realistic mid-file insertion instead of char-truncating it away', () => {
    const prefix = Array.from({ length: 20 }, (_, index) => `keep-before-${index}`);
    const suffix = Array.from({ length: 20 }, (_, index) => `keep-after-${index}`);
    const inserted = Array.from(
      { length: 90 },
      (_, index) => `added-payload-${index}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
    );
    const oldContent = [...prefix, ...suffix].join('\n');
    const newContent = [...prefix, ...inserted, ...suffix].join('\n');

    const result = generateUnifiedDiff('src/file.ts', oldContent, newContent);

    expect(result.linesAdded).toBe(90);
    expect(result.linesDeleted).toBe(0);
    expect(result.diffContent).not.toContain('diff truncated for AI safety');
    expect(result.diffContent).toContain('+ added-payload-0-');
    expect(result.diffContent).toContain('+ added-payload-89-');
  });
});

describe('annotateUnifiedDiffWithLineNumbers', () => {
  it('labels old and new file line numbers for each diff body line', () => {
    const diff = [
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -2,3 +2,3 @@',
      '  b',
      '- c',
      '+ X',
      '  d',
    ].join('\n');

    const annotated = annotateUnifiedDiffWithLineNumbers(diff);

    expect(annotated).toContain('old:2 new:2   b');
    expect(annotated).toContain('old:3 - c');
    expect(annotated).toContain('new:3 + X');
    expect(annotated).toContain('old:4 new:4   d');
  });
});
