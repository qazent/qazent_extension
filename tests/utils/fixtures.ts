/**
 * Shared test fixtures for PRMetadata, CodeDiff, etc.
 */

import type { PRMetadata, CodeDiff } from '../../src/backend/types';

/** Minimal HTML that passes AI truncation validation (length >= 2500, has Automation Notes) */
export const MIN_VALID_HTML =
  '<h2>Purpose</h2><p>Verify.</p><h2>Scope of Change</h2><p>Scope.</p><h2>Preconditions</h2><p>None.</p><h2>Test Steps & Expected Results</h2><table><tr><th>Step</th><th>Expected Result</th></tr><tr><td>1</td><td>OK</td></tr></table><h2>Negative Scenarios</h2><p>None.</p><h2>Edge Cases</h2><p>None.</p><h2>Regression Areas</h2><p>None.</p><h2>Data Requirements</h2><p>None.</p><h2>Automation Notes</h2><p>Unit tests.</p>' +
  'x'.repeat(2600);

export const defaultPRMetadata: PRMetadata = {
  prId: 123,
  title: 'Add authentication',
  description: 'Implements JWT authentication',
  author: 'developer',
  authorEmail: 'dev@example.com',
  sourceBranch: 'feature/auth',
  targetBranch: 'main',
  branchName: 'auth',
  repositoryId: 'repo-123',
  repositoryName: 'backend-api',
  projectId: 'proj-456',
  projectName: 'MyProject',
  createDate: new Date('2024-01-01'),
};

export const defaultCodeDiff: CodeDiff = {
  totalChanges: 1,
  changes: [
    {
      filePath: 'src/auth.ts',
      changeType: 'add',
      linesAdded: 50,
      linesDeleted: 0,
      diffContent: '+function authenticate() { ... }',
    },
  ],
};

/** Minimal PRMetadata for ado-client URI tests */
export const adoPRMetadata: PRMetadata = {
  prId: 2,
  title: 'Test PR',
  description: 'Some description',
  repositoryId: 'e5f6g7h8-i9j0-1234-5678-abcdef123456',
  repositoryName: 'my-repo',
  projectName: 'my-project',
  projectId: 'a1b2c3d4-e5f6-7890-abcd-1234567890ab',
  sourceBranch: 'refs/heads/feature/test',
  targetBranch: 'refs/heads/main',
  author: 'John Doe',
  authorEmail: 'john@example.com',
  createDate: new Date(),
  branchName: 'feature/test',
};
