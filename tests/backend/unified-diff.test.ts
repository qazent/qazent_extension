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
