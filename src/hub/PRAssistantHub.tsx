/**
 * Main PR Assistant Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';

import { CommonServiceIds, getClient, IExtensionDataService, IProjectPageService } from 'azure-devops-extension-api';

import { FluentProvider, webLightTheme } from '@fluentui/react-components';

import { PRInfoSection } from './PRInfoSection';
import { GenerateButton } from './GenerateButton';
import { PRData, AIContextDocument } from '../types/extension-types';
import * as backendClient from '../services/backendClient';
import type { IContribution, IExtensionContextWithContributions } from '../types/extension-types';
import { GitRestClient } from 'azure-devops-extension-api/Git';

const PRAssistantHub: React.FC = () => {
  const [prData, setPRData] = React.useState<PRData | null>(null);
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
 
  const [backendUrl, setBackendUrl] = React.useState<string>(
  'https://api.qazent.com');  // Default backend URL, should be overridden by config  // Default backend URL, should be overridden by config

  const [repositoryId, setRepositoryId] = React.useState<string>('');
  const [projectName, setProjectName] = React.useState<string>('');
  const [projectId, setProjectId] = React.useState<string>('');
  const [customContext, setCustomContext] = React.useState<string>('');
  const [countdown, setCountdown] = React.useState<number | null>(null);


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

      // 4. Get project ID (GUID) for artifact URI construction
      const projectService = await SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService);
      const project = await projectService.getProject();
      if (project?.id) {
        setProjectId(project.id);
      }

      // 5. Load PR context
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

  // Countdown timer: ticks down from 90s while generating, clears on success/error/completion
  React.useEffect(() => {
    if (!isGenerating || successMessage !== null || error !== null) {
      setCountdown(null);
      return;
    }

    if (countdown === null) {
      setCountdown(90);
      return;
    }

    if (countdown === 0) {
      setCountdown(null);
      return;
    }

    const interval = setInterval(() => {
      setCountdown(prev => prev !== null && prev > 0 ? prev - 1 : prev);
    }, 1000);

    return () => clearInterval(interval);
  }, [isGenerating, successMessage, error, countdown]);


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

      const gitClient = await getClient(GitRestClient);
  

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
    // Step 1: Validate PR data
    if (!prData) {
      setError('PR information not loaded');
      return;
    }

    // Step 2: Set loading state
    setIsGenerating(true);
    setError(null);
    setSuccessMessage(null);

    try {
      // Step 3: Validate metadata
      if (!repositoryId || !projectName) {
        throw new Error('Repository or project information missing. Please refresh the page.');
      }
      if (!projectId) {
        throw new Error('Project ID not loaded. Please refresh the page.');
      }

      // Step 4: Call /generate-tests (backend returns test case + commit IDs)
      const response = await backendClient.generateTestCases(
        prData.prId,
        projectName,
        repositoryId,
        backendUrl,
        customContext
      );

      // Extract test case and commit IDs from response
      const generatedTestCase = {
        title: response.title,
        htmlDescriptionBase64: response.htmlDescriptionBase64
      };
      const sourceCommitId = response.sourceCommitId;
      const targetCommitId = response.targetCommitId;

      // Validate commit IDs
      if (!sourceCommitId || !targetCommitId) {
        throw new Error('Backend did not return commit IDs. Please refresh and try again.');
      }

      // Step 5: Immediately call /create-work-item with ALL required fields
      const result = await backendClient.createWorkItem(
        generatedTestCase as any,
        prData.prId,
        projectName,
        repositoryId,
        backendUrl,
        projectId,
        sourceCommitId,
        targetCommitId
      );

      // Step 6: Post comment on PR (non-blocking)
      backendClient.postPRComment(
        prData.prId,
        projectName,
        repositoryId,
        result.workItemId,
        backendUrl,
      ).catch(err => {
        console.warn('PR comment failed but work item was created:', err);
      });

      

      // Step 7: Show success message
      setSuccessMessage(
        `Work item created successfully! View it here: ${result.workItemUrl}\n\n` +
        `A comment has been posted on this PR with the test case details.`
      );

      // Auto-dismiss success message after 20 seconds
      setTimeout(() => setSuccessMessage(null), 20000);

    } catch (err) {
      // Step 8: Handle errors
      let errorMessage = 'Failed to generate test cases and create work item';

      if (err instanceof Error) {
        if (err.message.includes('timed out')) {
          errorMessage = 'Request timed out. The backend is taking longer than expected. Please wait, could be due to backend cold start or complex PR. If the issue persists, please contact support.';
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
      console.error('Generate and create work item error:', err);
    } finally {
      // Step 9: Clear loading state
      setIsGenerating(false);
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
          countdown={countdown}
        />
      </div>
    </FluentProvider>
  );
};

export { PRAssistantHub };