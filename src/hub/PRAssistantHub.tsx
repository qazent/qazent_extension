/**
 * Main PR Assistant Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';
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
      // Get the host page context from Azure DevOps SDK
      const config = SDK.getConfiguration();

      if (!config || !config.pullRequestId) {
        setError('Unable to load PR context from Azure DevOps');
        return;
      }

      // Azure DevOps provides PR context when extension is shown in PR tab
      const pullRequestId = config.pullRequestId as number;

      // Set PR data (basic info without full API call)
      setPRData({
        prTitle: 'PR #' + pullRequestId,
        prId: pullRequestId,
        author: 'Unknown Author', // Can be fetched via API if needed
        filesChanged: 0 // Can be fetched via API if needed
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
      // Extract project and repository from URL
      const params = new URLSearchParams(window.location.search);
      const projectName = params.get('project') || 'DefaultProject';
      const repositoryId = params.get('repositoryId') || params.get('repo') || '';

      if (!repositoryId) {
        throw new Error('Unable to determine repository. Please refresh the page.');
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
      // Extract project and repository from URL
      const params = new URLSearchParams(window.location.search);
      const projectName = params.get('project') || 'DefaultProject';
      const repositoryId = params.get('repositoryId') || params.get('repo') || '';

      if (!repositoryId) {
        throw new Error('Unable to determine repository. Please refresh the page.');
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
    <FluentProvider theme={webLightTheme}>
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
    </FluentProvider>
  );
};

export { PRAssistantHub };
