/**
 * Main PR Assistant Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';
import { getClient } from 'azure-devops-extension-api';
import { GitRestClient } from 'azure-devops-extension-api/Git';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

import { PRInfoSection } from './PRInfoSection';
import { GenerateButton } from './GenerateButton';
import { TestCaseCard } from './TestCaseCard';
import { PRData, GeneratedTestCase } from '../types/extension-types';
import * as backendClient from '../services/backendClient';

const PRAssistantHub: React.FC = () => {
  const [prData, setPRData] = React.useState<PRData | null>(null);
  const [testCase, setTestCase] = React.useState<GeneratedTestCase | null>(null);
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [isCreatingWorkItem, setIsCreatingWorkItem] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
  const [backendUrl, setBackendUrl] = React.useState<string>('http://localhost:3000');
  const [repositoryId, setRepositoryId] = React.useState<string>('');
  const [projectName, setProjectName] = React.useState<string>('');

  React.useEffect(() => {
    const init = async () => {
      try {
        // REQUIRED: Initialize Azure DevOps SDK before any API calls
        await SDK.init();
        await SDK.ready();

        const config = SDK.getConfiguration();

        // Load backend URL from extension config
        if (config && config.backendUrl) {
          setBackendUrl(config.backendUrl as string);
        }

        await loadPRContext(config);
      } catch (err) {
        setError('Failed to initialize extension: ' + (err instanceof Error ? err.message : String(err)));
      }
    };

    init();
  }, []);

  const loadPRContext = async (config: any) => {
    try {
      // PR context comes from configuration, not webContext
      const prContext = config?.pullRequest;

      if (!prContext) {
        setError('Please navigate to a Pull Request page to use this extension.');
        return;
      }

      const pullRequestId = prContext.pullRequestId;
      const repoId = prContext.repository?.id;
      const project = prContext.repository?.project?.name;

      if (!repoId || !project) {
        setError('Unable to determine repository or project from PR context.');
        return;
      }

      const gitClient = getClient(GitRestClient);

      // Fetch PR details
      const prDetails = await gitClient.getPullRequest(repoId, pullRequestId, project);

      const authorName =
        prDetails.createdBy?.displayName ||
        prDetails.createdBy?.uniqueName ||
        'Unknown Author';

      // Count changed files
      let fileCount = 0;
      try {
        const iterations = await gitClient.getPullRequestIterations(repoId, pullRequestId, project);
        if (iterations?.length) {
          const lastIteration = iterations[iterations.length - 1];
          const changes = await gitClient.getPullRequestIterationChanges(
            repoId,
            pullRequestId,
            lastIteration.id!,
            project
          );
          fileCount = changes.changeEntries?.length || 0;
        }
      } catch (changeErr) {
        console.warn('Unable to fetch PR changes:', changeErr);
      }

      setRepositoryId(repoId);
      setProjectName(project);

      setPRData({
        prTitle: prDetails.title || `PR #${pullRequestId}`,
        prId: pullRequestId,
        author: authorName,
        filesChanged: fileCount
      });

    } catch (err) {
      setError('Unable to load Pull Request details: ' + (err instanceof Error ? err.message : String(err)));
      console.error('Error loading PR context:', err);
    }
  };

  const handleGenerateTests = async () => {
    if (!prData) {
      setError('PR information not loaded');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setTestCase(null);
    setSuccessMessage(null);

    try {
      if (!repositoryId || !projectName) {
        throw new Error('Repository or project information missing. Please refresh the page.');
      }

      const generatedTestCase = await backendClient.generateTestCases(
        prData.prId,
        projectName,
        repositoryId,
        backendUrl
      );

      setTestCase(generatedTestCase);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test case generation failed');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyToClipboard = () => {
    setSuccessMessage('Copied to clipboard!');
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleCreateWorkItem = async () => {
    if (!testCase || !prData) return;

    setIsCreatingWorkItem(true);
    setError(null);
    setSuccessMessage(null);

    try {
      if (!repositoryId || !projectName) {
        throw new Error('Repository or project information missing. Please refresh the page.');
      }

      const result = await backendClient.createWorkItem(
        testCase,
        prData.prId,
        projectName,
        repositoryId,
        backendUrl
      );

      setSuccessMessage(`Work item created successfully! View it here: ${result.workItemUrl}`);

      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create work item');
    } finally {
      setIsCreatingWorkItem(false);
    }
  };

  return (
    <FluentProvider theme={webLightTheme}>
      <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
        {error && (
          <div style={{
            backgroundColor: '#fde7e9',
            border: '1px solid #e81123',
            color: '#e81123',
            padding: '12px',
            marginBottom: '16px',
            borderRadius: '4px'
          }}>
            {error}
          </div>
        )}

        {successMessage && (
          <div style={{
            backgroundColor: '#dff6dd',
            border: '1px solid #107c10',
            color: '#107c10',
            padding: '12px',
            marginBottom: '16px',
            borderRadius: '4px'
          }}>
            {successMessage}
          </div>
        )}

        <PRInfoSection
          prTitle={prData?.prTitle}
          prId={prData?.prId}
          author={prData?.author}
          filesChanged={prData?.filesChanged}
        />

        <GenerateButton
          isLoading={isGenerating}
          isDisabled={!prData}
          onClick={handleGenerateTests}
        />

        <TestCaseCard
          testCase={testCase}
          onCopyToClipboard={handleCopyToClipboard}
          onCreateWorkItem={handleCreateWorkItem}
          isCreatingWorkItem={isCreatingWorkItem}
        />
      </div>
    </FluentProvider>
  );
};

export { PRAssistantHub };