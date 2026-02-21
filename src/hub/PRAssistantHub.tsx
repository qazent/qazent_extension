/**
 * Main PR Assistant Hub Component
 */

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as SDK from 'azure-devops-extension-sdk';
import { CommonServiceIds, IHostNavigationService } from 'azure-devops-extension-api';
import { GitRestClient, GitServiceIds } from 'azure-devops-extension-api/Git';

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

  // Initialize extension and load PR context
  React.useEffect(() => {
    const init = async () => {
      try {
        await SDK.init();
        await SDK.ready();

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
      // Get navigation service to determine current context
      const navService = await SDK.getService<IHostNavigationService>(CommonServiceIds.HostNavigationService);
      const state = await navService.getCurrentState();

      // Get Git service
      const gitClient = await SDK.getService<GitRestClient>(GitServiceIds.GitRestClient);

      // Extract PR context from route
      // Route typically contains repositoryId and pullRequestId
      const routeValues = state as any;
      const repositoryId = routeValues.repositoryId || routeValues.repository;
      const pullRequestId = routeValues.pullRequestId || routeValues.pullRequest;

      if (!pullRequestId) {
        setError('Please navigate to a Pull Request to use this extension');
        return;
      }

      // Fetch PR data
      const pr = await gitClient.getPullRequest(repositoryId, parseInt(pullRequestId, 10));

      // Set PR data
      setPRData({
        prTitle: pr.title || 'Unknown',
        prId: pr.pullRequestId || 0,
        author: pr.createdBy?.displayName || 'Unknown',
        filesChanged: 0 // Approximate - would need additional API call to get exact count
      });

    } catch (err) {
      setError('Unable to load PR information. Please refresh.');
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
      // Get project and repository context
      const navService = await SDK.getService<IHostNavigationService>(CommonServiceIds.HostNavigationService);
      const state = await navService.getCurrentState();
      const routeValues = state as any;

      const projectName = routeValues.project || 'DefaultProject';
      const repositoryId = routeValues.repositoryId || routeValues.repository || '';

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
      // Get project and repository context
      const navService = await SDK.getService<IHostNavigationService>(CommonServiceIds.HostNavigationService);
      const state = await navService.getCurrentState();
      const routeValues = state as any;

      const projectName = routeValues.project || 'DefaultProject';
      const repositoryId = routeValues.repositoryId || routeValues.repository || '';

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

// Initialize and render
SDK.init().then(() => {
  SDK.ready().then(() => {
    ReactDOM.render(<PRAssistantHub />, document.getElementById('root'));
    SDK.register(SDK.getContributionId(), () => {
      return {
        execute: () => {
          // Extension loaded
        }
      };
    });
  });
});
