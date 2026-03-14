/**
 * @jest-environment node
 */

jest.mock('node-fetch', () => jest.fn());

jest.mock('../../src/backend/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../src/backend/ado-client', () => ({
  generateUnifiedDiff: jest.fn().mockReturnValue({
    diffContent: '@@ -1,2 +1,2 @@\n-old\n+new',
    linesAdded: 4,
    linesDeleted: 2,
  }),
  DIFF_MAX_CHARS_PER_FILE: 8000,
  fetchPRDiffFallback: jest.fn().mockResolvedValue({
    changes: [{ filePath: 'fallback.ts', changeType: 'edit', linesAdded: 1, linesDeleted: 1, diffContent: 'fallback' }],
    totalChanges: 1,
    sourceCommitId: 'fallback-source',
    targetCommitId: 'fallback-target',
  }),
}));

import fetch from 'node-fetch';
import { fetchFileContentFromRest, fetchPRDiff } from '../../src/backend/fetchPRdiff';
import { fetchPRDiffFallback, generateUnifiedDiff } from '../../src/backend/ado-client';

function createFetchResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  text = '',
  json,
  contentType = 'text/plain',
}: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  text?: string;
  json?: unknown;
  contentType?: string;
}) {
  return {
    ok,
    status,
    statusText,
    headers: {
      get: jest.fn().mockReturnValue(contentType),
    },
    text: jest.fn().mockResolvedValue(text),
    json: jest.fn().mockResolvedValue(json),
  };
}

describe('fetchPRdiff backend path', () => {
  const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns raw text content from Azure DevOps item requests', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({
        text: 'console.log("hello");',
      }) as never
    );

    const content = await fetchFileContentFromRest(
      'myorg',
      'MyProject',
      'repo-1',
      '/src/file.ts',
      'commit-1',
      'oauth-token'
    );

    expect(content).toBe('console.log("hello");');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/_apis/git/repositories/repo-1/items'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token',
        }),
      })
    );
  });

  it('returns the wrapped content field when Azure DevOps responds with JSON', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({
        contentType: 'application/json',
        json: { content: 'wrapped file content' },
      }) as never
    );

    const content = await fetchFileContentFromRest(
      'myorg',
      'MyProject',
      'repo-1',
      '/src/file.ts',
      'commit-2',
      'oauth-token'
    );

    expect(content).toBe('wrapped file content');
  });

  it('throws a descriptive error when the REST item call fails', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: 'denied',
      }) as never
    );

    await expect(
      fetchFileContentFromRest(
        'myorg',
        'MyProject',
        'repo-1',
        '/src/file.ts',
        'commit-3',
        'oauth-token'
      )
    ).rejects.toThrow('REST getItem failed (403 Forbidden): denied');
  });

  it('falls back to the iteration diff helper when commit metadata is missing', async () => {
    const connection = {
      getGitApi: jest.fn().mockResolvedValue({
        getPullRequest: jest.fn().mockResolvedValue({
          lastMergeSourceCommit: undefined,
          lastMergeTargetCommit: undefined,
        }),
      }),
    };

    const result = await fetchPRDiff(
      'MyProject',
      'repo-1',
      42,
      connection as never,
      'myorg',
      'oauth-token'
    );

    expect(fetchPRDiffFallback).toHaveBeenCalledWith('MyProject', 'repo-1', 42, connection);
    expect(result).toEqual({
      changes: [{ filePath: 'fallback.ts', changeType: 'edit', linesAdded: 1, linesDeleted: 1, diffContent: 'fallback' }],
      totalChanges: 1,
      sourceCommitId: 'fallback-source',
      targetCommitId: 'fallback-target',
    });
  });

  it('builds diffs for edited, added, and deleted files while skipping ignored assets', async () => {
    mockFetch
      .mockResolvedValueOnce(createFetchResponse({ text: 'old line\nold extra' }) as never)
      .mockResolvedValueOnce(createFetchResponse({ text: 'new line\nnew extra' }) as never)
      .mockResolvedValueOnce(createFetchResponse({ text: 'export const added = true;\nsecond line' }) as never)
      .mockResolvedValueOnce(createFetchResponse({ text: 'removed line\nremoved extra' }) as never);

    const gitApi = {
      getPullRequest: jest.fn().mockResolvedValue({
        lastMergeSourceCommit: { commitId: 'source-123' },
        lastMergeTargetCommit: { commitId: 'target-456' },
      }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 7 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [
          { item: { path: '/src/edited.ts' }, changeType: 'edit' },
          { item: { path: '/src/added.ts' }, changeType: 'add' },
          { item: { path: '/src/deleted.ts' }, changeType: 'delete' },
          { item: { path: '/assets/logo.png' }, changeType: 'add' },
        ],
      }),
    };
    const connection = {
      getGitApi: jest.fn().mockResolvedValue(gitApi),
    };

    const result = await fetchPRDiff(
      'MyProject',
      'repo-1',
      99,
      connection as never,
      'myorg',
      'oauth-token'
    );

    expect(generateUnifiedDiff).toHaveBeenCalledWith(
      '/src/edited.ts',
      'old line\nold extra',
      'new line\nnew extra',
      8000
    );
    expect(result.totalChanges).toBe(4);
    expect(result.sourceCommitId).toBe('source-123');
    expect(result.targetCommitId).toBe('target-456');
    expect(result.changes).toEqual([
      {
        filePath: '/src/edited.ts',
        changeType: 'edit',
        linesAdded: 4,
        linesDeleted: 2,
        diffContent: '@@ -1,2 +1,2 @@\n-old\n+new',
      },
      {
        filePath: '/src/added.ts',
        changeType: 'add',
        linesAdded: 2,
        linesDeleted: 0,
        diffContent: expect.stringContaining('+++ b//src/added.ts'),
      },
      {
        filePath: '/src/deleted.ts',
        changeType: 'delete',
        linesAdded: 0,
        linesDeleted: 2,
        diffContent: expect.stringContaining('--- a//src/deleted.ts'),
      },
    ]);
  });

  it('uses a fallback diff entry when content fetch fails for a changed file', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const connection = {
      getGitApi: jest.fn().mockResolvedValue({
        getPullRequest: jest.fn().mockResolvedValue({
          lastMergeSourceCommit: { commitId: 'source-123' },
          lastMergeTargetCommit: { commitId: 'target-456' },
        }),
        getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
        getPullRequestIterationChanges: jest.fn().mockResolvedValue({
          changeEntries: [{ item: { path: '/src/added.ts' }, changeType: 'add' }],
        }),
      }),
    };

    const result = await fetchPRDiff(
      'MyProject',
      'repo-1',
      100,
      connection as never,
      'myorg',
      'oauth-token'
    );

    expect(result.changes).toEqual([
      {
        filePath: '/src/added.ts',
        changeType: 'add',
        linesAdded: 10,
        linesDeleted: 3,
        diffContent:
          'File: /src/added.ts\nChange type: add\n[Content fetch failed - possibly binary file, too large, or access restricted]',
      },
    ]);
  });
});
