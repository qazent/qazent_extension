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

jest.mock('../../src/backend/ado-client', () => {
  const actual = jest.requireActual('../../src/backend/ado-client');
  return {
    ...actual,
    generateUnifiedDiff: jest.fn().mockReturnValue({
      diffContent: '@@ -1,2 +1,2 @@\n-old\n+new',
      linesAdded: 4,
      linesDeleted: 2,
    }),
    fetchPRDiffFallback: jest.fn().mockResolvedValue({
      changes: [{ filePath: 'fallback.ts', changeType: 'edit', linesAdded: 1, linesDeleted: 1, diffContent: 'fallback' }],
      totalChanges: 1,
      sourceCommitId: 'fallback-source',
      targetCommitId: 'fallback-target',
    }),
  };
});

import fetch from 'node-fetch';
import { fetchFileContentFromRest, fetchPRDiff } from '../../src/backend/fetchPRdiff';
import { fetchAllIterationChangeEntries, fetchPRDiffFallback, generateUnifiedDiff } from '../../src/backend/ado-client';
import { ITERATION_CHANGES_PAGE_SIZE } from '../../src/backend/diff-config';

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
    );
    expect(result.totalChanges).toBe(4);
    expect(result.filteredChanges).toBe(1);
    expect(result.truncatedChanges).toBe(0);
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
        diffContent: expect.stringContaining('+++ b/src/added.ts'),
      },
      {
        filePath: '/src/deleted.ts',
        changeType: 'delete',
        linesAdded: 0,
        linesDeleted: 2,
        diffContent: expect.stringContaining('--- a/src/deleted.ts'),
      },
    ]);
  });

  it('treats an empty added file as a valid diff instead of a fetch failure', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({ text: '' }) as never);

    const connection = {
      getGitApi: jest.fn().mockResolvedValue({
        getPullRequest: jest.fn().mockResolvedValue({
          lastMergeSourceCommit: { commitId: 'source-123' },
          lastMergeTargetCommit: { commitId: 'target-456' },
        }),
        getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
        getPullRequestIterationChanges: jest.fn().mockResolvedValue({
          changeEntries: [{ item: { path: '/src/empty.ts' }, changeType: 'add' }],
        }),
      }),
    };

    const result = await fetchPRDiff(
      'MyProject',
      'repo-1',
      101,
      connection as never,
      'myorg',
      'oauth-token'
    );

    expect(result.changes).toEqual([
      {
        filePath: '/src/empty.ts',
        changeType: 'add',
        linesAdded: 0,
        linesDeleted: 0,
        diffContent: expect.stringContaining('+++ b/src/empty.ts'),
      },
    ]);
    expect(result.changes[0].diffContent).not.toContain('Content fetch failed');
  });

  it('prefers semantically meaningful regions over import-heavy headers for added files', async () => {
    const importBlock = Array.from({ length: 35 }, (_, index) => `import dep${index} from 'pkg-${index}';`).join('\n');
    const addedFileContent = [
      importBlock,
      '',
      'const helper = () => "ready";',
      '',
      'export async function submitOrder(order: OrderInput) {',
      '  const validatedOrder = validateOrder(order);',
      '  await saveOrder(validatedOrder);',
      '  return { ok: true, id: validatedOrder.id };',
      '}',
      '',
      'export const orderRoutes = router.post("/orders", submitOrder);',
    ].join('\n');

    mockFetch.mockResolvedValueOnce(createFetchResponse({ text: addedFileContent }) as never);

    const connection = {
      getGitApi: jest.fn().mockResolvedValue({
        getPullRequest: jest.fn().mockResolvedValue({
          lastMergeSourceCommit: { commitId: 'source-123' },
          lastMergeTargetCommit: { commitId: 'target-456' },
        }),
        getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
        getPullRequestIterationChanges: jest.fn().mockResolvedValue({
          changeEntries: [{ item: { path: '/src/orders.ts' }, changeType: 'add' }],
        }),
      }),
    };

    const result = await fetchPRDiff(
      'MyProject',
      'repo-1',
      102,
      connection as never,
      'myorg',
      'oauth-token'
    );

    expect(result.changes[0].linesAdded).toBe(45);
    expect(result.changes[0].diffContent).toContain('export async function submitOrder');
    expect(result.changes[0].diffContent).toContain('router.post("/orders", submitOrder)');
    expect(result.changes[0].diffContent).toContain('... (');
    expect(result.changes[0].diffContent).not.toContain("import dep0 from 'pkg-0';");
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
        linesDeleted: 0,
        diffContent:
          'File: /src/added.ts\nChange type: add\n[Content fetch failed - possibly binary file, too large, or access restricted]',
      },
    ]);
  });

  it('recovers added file content when Azure DevOps classifies it as edit but the old side is missing', async () => {
    mockFetch
      .mockResolvedValueOnce(
        createFetchResponse({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: 'TF401174: Item does not exist',
        }) as never
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          text: [
            "import { acp } from './client';",
            '',
            'export async function executeAcpTask(input: TaskInput) {',
            '  return acp.run(input);',
            '}',
          ].join('\n'),
        }) as never
      );

    const connection = {
      getGitApi: jest.fn().mockResolvedValue({
        getPullRequest: jest.fn().mockResolvedValue({
          lastMergeSourceCommit: { commitId: 'source-123' },
          lastMergeTargetCommit: { commitId: 'target-456' },
        }),
        getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
        getPullRequestIterationChanges: jest.fn().mockResolvedValue({
          changeEntries: [{ item: { path: '/server/src/adapters/acp/execute.ts' }, changeType: 'edit' }],
        }),
      }),
    };

    const result = await fetchPRDiff(
      'MyProject',
      'repo-1',
      103,
      connection as never,
      'myorg',
      'oauth-token'
    );

    expect(result.changes).toEqual([
      expect.objectContaining({
        filePath: '/server/src/adapters/acp/execute.ts',
        changeType: 'add',
        linesAdded: 5,
        linesDeleted: 0,
        diffContent: expect.stringContaining('export async function executeAcpTask'),
      }),
    ]);
    expect(result.changes[0].diffContent).not.toContain('Content fetch failed');
  });

  it('fetches all paged iteration changes through the helper', async () => {
    const firstPageEntries = Array.from({ length: ITERATION_CHANGES_PAGE_SIZE }, (_, index) => ({
      item: { path: `/src/file-${index}.ts` },
      changeType: 'edit',
    }));
    const secondPageEntries = [
      { item: { path: '/src/final.ts' }, changeType: 'add' },
    ];
    const gitApi = {
      getPullRequestIterationChanges: jest.fn()
        .mockResolvedValueOnce({ changeEntries: firstPageEntries })
        .mockResolvedValueOnce({ changeEntries: secondPageEntries }),
    };

    const entries = await fetchAllIterationChangeEntries(
      gitApi as never,
      'repo-1',
      42,
      7,
      'MyProject'
    );

    expect(entries).toHaveLength(ITERATION_CHANGES_PAGE_SIZE + 1);
    expect(gitApi.getPullRequestIterationChanges).toHaveBeenNthCalledWith(
      1,
      'repo-1',
      42,
      7,
      'MyProject',
      ITERATION_CHANGES_PAGE_SIZE,
      0
    );
    expect(gitApi.getPullRequestIterationChanges).toHaveBeenNthCalledWith(
      2,
      'repo-1',
      42,
      7,
      'MyProject',
      ITERATION_CHANGES_PAGE_SIZE,
      ITERATION_CHANGES_PAGE_SIZE
    );
  });
});
