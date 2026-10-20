/**
 * @jest-environment node
 */

import { MAX_INLINE_COMMENTS, toAdoThreadFilePath } from '../../src/backend/diff-config';

describe('toAdoThreadFilePath', () => {
  it('prefixes a leading slash for ADO threadContext.filePath', () => {
    expect(toAdoThreadFilePath('src/auth.ts')).toBe('/src/auth.ts');
  });

  it('keeps a single leading slash when the path already has one', () => {
    expect(toAdoThreadFilePath('/src/auth.ts')).toBe('/src/auth.ts');
  });

  it('collapses extra leading slashes', () => {
    expect(toAdoThreadFilePath('///src/auth.ts')).toBe('/src/auth.ts');
  });
});

describe('MAX_INLINE_COMMENTS', () => {
  it('caps inline findings at 10', () => {
    expect(MAX_INLINE_COMMENTS).toBe(10);
  });
});
