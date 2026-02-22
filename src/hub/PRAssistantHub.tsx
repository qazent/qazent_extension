/**
 * Main PR Assistant Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';
import { getClient } from 'azure-devops-extension-api';
import { GitRestClient } from 'azure-devops-extension-api/Git';
import { CommonServiceIds, IExtensionDataService } from 'azure-devops-extension-api';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

import { PRInfoSection } from './PRInfoSection';
import { GenerateButton } from './GenerateButton';
import { TestCaseCard } from './TestCaseCard';
import { PRData, GeneratedTestCase, AIContextDocument } from '../types/extension-types';
import * as backendClient from '../services/backendClient';
import type { IContribution, IExtensionContextWithContributions } from '../types/extension-types';

const PRAssistantHub: React.FC = () => {
  const [prData, setPRData] = React.useState<PRData | null>(null);
  const [testCase, setTestCase] = React.useState<GeneratedTestCase | null>(null);
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [isCreatingWorkItem, setIsCreatingWorkItem] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
 
  const [backendUrl, setBackendUrl] = React.useState<string>(
  'https://rathely-rubidic-katelin.ngrok-free.dev/');  // Default backend URL, should be overridden by config  // Default backend URL, should be overridden by config

  const [repositoryId, setRepositoryId] = React.useState<string>('');
  const [projectName, setProjectName] = React.useState<string>('');
  const [customContext, setCustomContext] = React.useState<string>('');
  const [loadingProgress, setLoadingProgress] = React.useState<number>(0);
  const [estimatedTimeRemaining, setEstimatedTimeRemaining] = React.useState<number>(0);


  React.useEffect(() => {
  const init = async () => {
    try {
      await SDK.init();
      await SDK.ready();

      // 1. Get extension context (cast to extended type)
      const extContext = SDK.getExtensionContext() as unknown as IExtensionContextWithContributions;

      // 2. Identify the current contribution
      const contributionId = SDK.getContributionId();

      const contribution = extContext.contributions?.find(
        (c: IContribution) => c.id === contributionId
      );

      // 3. Read backendUrl from contribution properties
      const backend = contribution?.properties?.backendUrl;
      if (backend) {
        setBackendUrl(backend);
      }

      // 4. Load PR context
      const config = SDK.getConfiguration();
      await loadPRContext(config);

    } catch (err) {
      setError(
        'Failed to initialize extension: ' +
          (err instanceof Error ? err.message : String(err))
      );
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
      const customcontext = prContext.customContext || '';

       if (customcontext) {
        setCustomContext(customcontext);
      } else {
        await loadCustomContext(project, repoId);
      }

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
      setCustomContext(''); // Clear context while loading

      // Load custom context for this repository
      await loadCustomContext(project, repoId);

      setPRData({
        prTitle: prDetails.title || `PR #${pullRequestId}`,
        prId: pullRequestId,
        author: authorName,
        filesChanged: fileCount,
      });

      if (!loadCustomContext) {
        setError('Failed to load custom context for this repository. Please try again.');
      }

    } catch (err) {
      setError('Unable to load Pull Request details: ' + (err instanceof Error ? err.message : String(err)));
      console.error('Error loading PR context:', err);
    }
  };
// Load custom context from extension data storage, combining project default and repo-specific contexts
// TODO: Consider caching this context in session storage to avoid repeated loads on every render

// TODO: USE PROJECTID IF ORGANIZATION SUPPORT IS ADDED IN THE FUTURE, CURRENTLY USING PROJECT NAME AS KEY PART OF STORAGE
  const loadCustomContext = async (_projectId: string, repositoryId: string) => {
    try {
      // Build combined context: project default + repo-specific
      const contextParts: string[] = [];

      const dataService = await SDK.getService<IExtensionDataService>(
        CommonServiceIds.ExtensionDataService
      );
      const dataManager = await dataService.getExtensionDataManager(
        'QAZent.pr-assistant-extension',
        await SDK.getAccessToken()
      );
    
      // Load project default first
      const projectDefault = await dataManager.getDocument('ai-contexts', 'project-default');
      if (projectDefault && (projectDefault as AIContextDocument).contextText && (projectDefault as AIContextDocument).contextText.trim()) {
        contextParts.push((projectDefault as AIContextDocument).contextText.trim());
      }

      // Load repo-specific and append (not replace)
      const repoContext = await dataManager.getDocument('ai-contexts', repositoryId);
      if (repoContext && (repoContext as AIContextDocument).contextText && (repoContext as AIContextDocument).contextText.trim()) {
        contextParts.push((repoContext as AIContextDocument).contextText.trim());
      }

      // Combine with double newline separator
      const combinedContext = contextParts.join('\n\n');
      setCustomContext(combinedContext);
    } catch (err) {
      console.warn('Failed to load custom context:', err);
      // Non-fatal error - continue without context
    }
  };

  const handleGenerateTests = async () => {
    if (!prData) {
      setError('PR information not loaded');
      setIsGenerating(false);
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
        backendUrl,
        customContext
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
    if (!testCase || !prData) {
      setError('Test case not generated or PR data not available');
      setIsCreatingWorkItem(false);
      return;
    }

    // Validate backendUrl is loaded from extension context
    if (!backendUrl || backendUrl === '') {
      setError('Backend URL not configured. Please refresh the extension.');
      setIsCreatingWorkItem(false);
      return;
    }

    // Validate backendUrl is not a relative URL or malformed
    if (!backendUrl.startsWith('http://') && !backendUrl.startsWith('https://')) {
      setError('Invalid backend URL configuration. Please contact support.');
      setIsCreatingWorkItem(false);
      return;
    }

    setIsCreatingWorkItem(true);
    setError(null);
    setSuccessMessage(null);
    setLoadingProgress(0);
    setEstimatedTimeRemaining(35);

    // Start progress simulation
    const progressInterval = setInterval(() => {
      setLoadingProgress(prev => {
        // Slow down as we approach 90%
        if (prev >= 90) return prev + 0.5;
        if (prev >= 70) return prev + 1;
        if (prev >= 30) return prev + 2;
        return prev + 3;
      });

      setEstimatedTimeRemaining(prev => {
        const newTime = prev - 0.5;
        return newTime > 5 ? newTime : 5;
      });
    }, 500);

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

      // Complete progress
      clearInterval(progressInterval);
      setLoadingProgress(100);
      setEstimatedTimeRemaining(0);

      setSuccessMessage(`Work item created successfully! View it here: ${result.workItemUrl}`);

      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (err) {
      clearInterval(progressInterval);
      setLoadingProgress(0);
      setEstimatedTimeRemaining(0);

      let errorMessage = 'Failed to create work item';

      if (err instanceof Error) {
        if (err.message.includes('timed out')) {
          errorMessage = 'Request timed out. The backend is taking longer than expected. Please try again.';
        } else if (err.message.includes('Unable to connect')) {
          errorMessage = 'Cannot connect to backend service. Please check your network connection.';
        } else if (err.message.includes('403')) {
          errorMessage = 'Access forbidden. Please check backend URL configuration.';
        } else if (err.message.includes('404')) {
          errorMessage = 'Backend endpoint not found. Please verify backend service is running.';
        } else {
          errorMessage = `Error: ${err.message}`;
        }
      }

      setError(errorMessage);
      console.error('Create work item error:', err);
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

        {isCreatingWorkItem && (
          <div style={{
            backgroundColor: '#f3f2f1',
            border: '1px solid #8a8886',
            padding: '16px',
            marginBottom: '16px',
            borderRadius: '4px'
          }}>
            <div style={{ marginBottom: '8px', fontWeight: 'bold' }}>
              Creating Work Item...
            </div>
            <div style={{
              width: '100%',
              height: '8px',
              backgroundColor: '#e1dfdd',
              borderRadius: '4px',
              overflow: 'hidden',
              marginBottom: '8px'
            }}>
              <div style={{
                width: `${loadingProgress}%`,
                height: '100%',
                backgroundColor: '#0078d4',
                transition: 'width 0.3s ease'
              }} />
            </div>
            <div style={{ fontSize: '12px', color: '#605e5c' }}>
              Estimated time remaining: {Math.ceil(estimatedTimeRemaining)} seconds
            </div>
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