/**
 * Main PR Assistant Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';
import * as DevOps from 'azure-devops-extension-api';

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

  // Load PR context and configuration on mount
  React.useEffect(() => {
    const init = async () => {
      try {
        // Get backend URL from extension configuration
        const config = SDK.getConfiguration();
        if (config && config.backendUrl) {
          setBackendUrl(config.backendUrl as string);
        }

        // Load PR context
        await loadPRContext();

      } catch (err) {
        setError('Failed to initialize extension: ' + (err instanceof Error ? err.message : String(err)));
      }
    };

    init();
  }, []);

  const loadPRContext = async () => {
    try {
      // Get Azure DevOps context from SDK
      const webContext = SDK.getWebContext();

      // Check if we're in a PR context
      if (!webContext.project || !webContext.pullRequest || !webContext.repository) {
        setError('Please navigate to a Pull Request page to use this extension');
        return;
      }

      const pullRequestId = webContext.pullRequest.pullRequestId;
      const repoId = webContext.repository.id;
      const project = webContext.project.name;

      // Store repository and project info for later use
      setRepositoryId(repoId);
      setProjectName(project);

      // Get Git client from Azure DevOps API
      const gitClient = DevOps.getClient(DevOps.GitRestClient);

      // Fetch full PR details
      const prDetails = await gitClient.getPullRequest(repoId, pullRequestId, project);

      // Get PR author
      const authorName = prDetails.createdBy?.displayName || prDetails.createdBy?.uniqueName || 'Unknown Author';

      // Fetch PR changes to count files
      let fileCount = 0;
      try {
        // Get the last iteration to get latest changes
        if (prDetails.lastMergeSourceCommit) {
          const iterations = await gitClient.getPullRequestIterations(repoId, pullRequestId, project);
          if (iterations && iterations.length > 0) {
            const lastIteration = iterations[iterations.length - 1];
            const changes = await gitClient.getPullRequestIterationChanges(
              repoId,
              pullRequestId,
              lastIteration.id!,
              project
            );
            fileCount = changes.changeEntries?.length || 0;
          }
        }
      } catch (changeErr) {
        // If fetching changes fails, just set to 0
        console.warn('Unable to fetch PR changes:', changeErr);
        fileCount = 0;
      }

      // Set PR data with real values from API
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
      // Use repository and project info from state (loaded via SDK)
      if (!repositoryId) {
        throw new Error('Repository information not available. Please refresh the page.');
      }

      if (!projectName) {
        throw new Error('Project information not available. Please refresh the page.');
      }

      const generatedTestCase = await backendClient.generateTestCases(
        prData.prId,
        projectName,
        repositoryId,
        backendUrl
      );

      setTestCase(generatedTestCase);
      setIsGenerating(false);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test case generation failed');
      setIsGenerating(false);
    }
  };

  const handleCopyToClipboard = () => {
    setSuccessMessage('Copied to clipboard!');
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleCreateWorkItem = async () => {
    if (!testCase || !prData) {
      return;
    }

    setIsCreatingWorkItem(true);
    setError(null);
    setSuccessMessage(null);

    try {
      // Use repository and project info from state (loaded via SDK)
      if (!repositoryId) {
        throw new Error('Repository information not available. Please refresh the page.');
      }

      if (!projectName) {
        throw new Error('Project information not available. Please refresh the page.');
      }

      const result = await backendClient.createWorkItem(
        testCase,
        prData.prId,
        projectName,
        repositoryId,
        backendUrl
      );

      setSuccessMessage(`Work item created successfully! View it here: ${result.workItemUrl}`);
      setIsCreatingWorkItem(false);

      // Auto-dismiss success message after 5 seconds
      setTimeout(() => setSuccessMessage(null), 5000);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create work item');
      setIsCreatingWorkItem(false);
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Error Message */}
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

      {/* Success Message */}
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

      {/* PR Info Section */}
      <PRInfoSection
        prTitle={prData?.prTitle}
        prId={prData?.prId}
        author={prData?.author}
        filesChanged={prData?.filesChanged}
      />

      {/* Generate Button */}
      <GenerateButton
        isLoading={isGenerating}
        isDisabled={!prData}
        onClick={handleGenerateTests}
      />

      {/* Test Case Card */}
      <TestCaseCard
        testCase={testCase}
        onCopyToClipboard={handleCopyToClipboard}
        onCreateWorkItem={handleCreateWorkItem}
        isCreatingWorkItem={isCreatingWorkItem}
      />
    </div>
  );
};

export { PRAssistantHub };
