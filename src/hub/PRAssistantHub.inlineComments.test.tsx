/**
 * Unit tests for exclusive Inline Diff Comments mode in PRAssistantHub
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PRAssistantHub } from './PRAssistantHub';
import * as SDK from 'azure-devops-extension-sdk';
import { CommonServiceIds } from 'azure-devops-extension-api';
import * as backendClient from '../services/backendClient';

const mockGetPullRequest = jest.fn();
const mockGetPullRequestIterations = jest.fn();
const mockGetPullRequestIterationChanges = jest.fn();

jest.mock('../config/featureFlags', () => ({
  ENABLE_LICENSE_ENFORCEMENT: false,
}));

jest.mock('azure-devops-extension-api', () => ({
  getClient: jest.fn(() => ({
    getPullRequest: mockGetPullRequest,
    getPullRequestIterations: mockGetPullRequestIterations,
    getPullRequestIterationChanges: mockGetPullRequestIterationChanges,
  })),
  CommonServiceIds: {
    ProjectPageService: 'ms.vss-work-web.project-page-service',
    ExtensionDataService: 'ms.vss-features.extension-data-service',
  },
  getService: jest.fn(),
}));

jest.mock('../services/backendClient', () => ({
  generateTestCases: jest.fn(),
  createWorkItem: jest.fn(),
  postPRComment: jest.fn(),
  extractPurposeAndScope: jest.fn(),
  postPRInlineComments: jest.fn(),
}));

const inlineComment = {
  filePath: '/src/a.ts',
  line: 4,
  side: 'right' as const,
  contentHtml: '<p>Finding</p>',
  severity: 'Major' as const,
};

describe('PRAssistantHub inline diff comments', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (SDK.init as jest.Mock).mockResolvedValue(undefined);
    (SDK.ready as jest.Mock).mockResolvedValue(undefined);
    (SDK.getConfiguration as jest.Mock).mockReturnValue({
      pullRequest: {
        pullRequestId: 123,
        repository: {
          id: 'repo-123',
          project: { name: 'TestProject' },
        },
      },
    });
    (SDK.getService as jest.Mock).mockImplementation((serviceId: string) => {
      if (serviceId === CommonServiceIds.ProjectPageService) {
        return Promise.resolve({
          getProject: jest.fn().mockResolvedValue({ id: 'proj-123', name: 'TestProject' }),
        });
      }
      return Promise.resolve({
        getExtensionDataManager: jest.fn().mockResolvedValue({
          getDocument: jest.fn().mockResolvedValue(null),
          setDocument: jest.fn(),
        }),
      });
    });
    (SDK.getAccessToken as jest.Mock).mockResolvedValue('mock-token');
    (SDK.getUser as jest.Mock).mockReturnValue({ displayName: 'Test User' });

    mockGetPullRequest.mockResolvedValue({
      pullRequestId: 123,
      title: 'Test PR',
      createdBy: { displayName: 'Author' },
    });
    mockGetPullRequestIterations.mockResolvedValue([{ id: 1 }]);
    mockGetPullRequestIterationChanges.mockResolvedValue({
      changeEntries: [{ item: { path: '/file1.ts' } }],
    });

    (backendClient.generateTestCases as jest.Mock).mockResolvedValue({
      title: 'Review',
      htmlDescription: '<h2>Findings</h2><p>A defect.</p>',
      sourceCommitId: 'src',
      targetCommitId: 'tgt',
      inlineComments: [inlineComment],
      skippedInlineComments: [],
    });
    (backendClient.createWorkItem as jest.Mock).mockResolvedValue({
      workItemId: 77,
      workItemUrl: 'https://dev.azure.com/work/77',
    });
    (backendClient.postPRComment as jest.Mock).mockResolvedValue({ success: true });
    (backendClient.extractPurposeAndScope as jest.Mock).mockResolvedValue('<p>Scope</p>');
    (backendClient.postPRInlineComments as jest.Mock).mockResolvedValue({
      posted: 1,
      failed: 0,
      skipped: 0,
    });
  });

  async function renderReadyHub() {
    render(<PRAssistantHub />);
    await waitFor(() => {
      expect(screen.getByText('Deep Technical Review Mode')).toBeInTheDocument();
    });
  }

  it('shows inline comments as an exclusive mode, not a Deep Review overlay', async () => {
    await renderReadyHub();
    expect(screen.getByLabelText('Inline Diff Comments Mode')).toBeInTheDocument();
    expect(screen.queryByLabelText('Comment on specific diff lines')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Deep Technical Review Mode'));
    expect(screen.queryByLabelText('Comment on specific diff lines')).not.toBeInTheDocument();
  });

  it('posts inline comments after the existing output path in inline-comments mode', async () => {
    await renderReadyHub();
    await userEvent.click(screen.getByLabelText('Inline Diff Comments Mode'));
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await waitFor(
      () => {
        expect(backendClient.postPRInlineComments).toHaveBeenCalled();
      },
      { timeout: 8000 }
    );

    expect(backendClient.generateTestCases).toHaveBeenCalledWith(
      123,
      'TestProject',
      'repo-123',
      expect.any(String),
      '',
      'inline-comments'
    );
    expect(backendClient.createWorkItem).toHaveBeenCalled();
    expect(backendClient.postPRComment).toHaveBeenCalled();
    expect(backendClient.postPRInlineComments).toHaveBeenCalledWith({
      prId: 123,
      projectName: 'TestProject',
      repositoryId: 'repo-123',
      connection: expect.any(String),
      inlineComments: [inlineComment],
    });
    expect(await screen.findByText(/Posted 1 inline comments on the Files tab/i)).toBeInTheDocument();
  });

  it('still succeeds when inline posting fails', async () => {
    (backendClient.postPRInlineComments as jest.Mock).mockRejectedValueOnce(new Error('ADO down'));
    await renderReadyHub();
    await userEvent.click(screen.getByLabelText('Inline Diff Comments Mode'));
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await waitFor(
      () => {
        expect(backendClient.createWorkItem).toHaveBeenCalled();
      },
      { timeout: 8000 }
    );
    expect(await screen.findByText(/inline comments failed to post/i, {}, { timeout: 8000 })).toBeInTheDocument();
  });

  it('still posts inline comments when work item creation fails', async () => {
    (backendClient.createWorkItem as jest.Mock).mockRejectedValueOnce(new Error('Boards down'));
    await renderReadyHub();
    await userEvent.click(screen.getByLabelText('Inline Diff Comments Mode'));
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await waitFor(
      () => {
        expect(backendClient.postPRInlineComments).toHaveBeenCalled();
      },
      { timeout: 8000 }
    );
    expect(await screen.findByText(/Posted 1 inline comments on the Files tab/i)).toBeInTheDocument();
  });
});
