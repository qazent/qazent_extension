/**
 * Main PR Assistant Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';

import { CommonServiceIds, getClient, IExtensionDataService, IProjectPageService } from 'azure-devops-extension-api';

import { FluentProvider, webLightTheme } from '@fluentui/react-components';

import { PRInfoSection } from './PRInfoSection';
import { GenerateButton } from './GenerateButton';
import { AIActivityFeed } from './AIActivityFeed';
import { PRData, AIContextDocument } from '../types/extension-types';
import * as backendClient from '../services/backendClient';
import type { IContribution, IExtensionContextWithContributions } from '../types/extension-types';
import { GitRestClient } from 'azure-devops-extension-api/Git';

const PRAssistantHub: React.FC = () => {
  const [prData, setPRData] = React.useState<PRData | null>(null);
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

// INTERFACE FOR SUCCESS MESSAGE DATA
  interface SuccessMessageData {
  text: string;
  url: string;
  details: string;
}
const [successMessage, setSuccessMessage] = React.useState<SuccessMessageData | null>(null);

 
  const [backendUrl, setBackendUrl] = React.useState<string>(
  'https://api.qazent.com');  // Default backend URL, should be overridden by config  // Default backend URL, should be overridden by config

  const [repositoryId, setRepositoryId] = React.useState<string>('');
  const [projectName, setProjectName] = React.useState<string>('');
  const [projectId, setProjectId] = React.useState<string>('');
  const [customContext, setCustomContext] = React.useState<string>('');
  const [countdown, setCountdown] = React.useState<number | null>(null);
  const [currentStep, setCurrentStep] = React.useState<number | null>(null);
  const [completedSteps, setCompletedSteps] = React.useState<number[]>([]);


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

  // Countdown timer: ticks down from 180s while generating, clears on success/error/completion
  React.useEffect(() => {
    if (!isGenerating || successMessage !== null || error !== null) {
      setCountdown(null);
      return;
    }

    if (countdown === null) {
      setCountdown(180); // Start countdown at 180 seconds (3 minutes)
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
    setCurrentStep(null);
    setCompletedSteps([]);

    try {
      // Step 3: Validate metadata
      setCurrentStep(1);
      if (!repositoryId || !projectName) {
        throw new Error('Repository or project information missing. Please refresh the page.');
      }
      if (!projectId) {
        throw new Error('Project ID not loaded. Please refresh the page.');
      }

      // Step 4: Call /generate-tests (backend returns test case + commit IDs)
      setCompletedSteps([1]);
      setCurrentStep(2);
      const response = await backendClient.generateTestCases(
        prData.prId,
        projectName,
        repositoryId,
        backendUrl,
        customContext
      );

      // Extract test case and commit IDs from response
      setCompletedSteps(prev => [...prev, 2]);
      setCurrentStep(3);
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
      setCompletedSteps(prev => [...prev, 3]);
      setCurrentStep(4);
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

            // Step 6: Post comment on PR
      setCompletedSteps(prev => [...prev, 4]);
      setCurrentStep(5);

      try {
        await backendClient.postPRComment(
          prData.prId,
          projectName,
          repositoryId,
          result.workItemId,
          backendUrl,
        );
      } catch (err) {
        console.warn('PR comment failed but work item was created:', err);
      }

      // Step 7: Show success message
      setCompletedSteps(prev => [...prev, 5]);
      setCurrentStep(null);
      setSuccessMessage({
        text: "Work item created successfully!",
        url: result.workItemUrl,
        details: "A comment has been posted on this PR with the test case details."
      });
      setTimeout(() => setSuccessMessage(null), 60000); // Clear success message after 60 seconds


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
          errorMessage = `Please contact support. Error: ${err.message}`;
        }
      }

      setError(errorMessage);
      console.error('Generate and create work item error:', err);
    }
    finally {      
      setIsGenerating(false);
    }
  };

 return (
  <FluentProvider theme={webLightTheme}>
    <div
      style={{
        padding: '32px',
        maxWidth: '1100px',
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px'
      }}
    >
      {/* Error message */}
      {error && (
        <div
          style={{
            backgroundColor: '#fde7e9',
            border: '1px solid #e81123',
            color: '#a80000',
            padding: '16px 20px',
            borderRadius: '8px',
            fontSize: '15px',
            boxShadow: '0 2px 6px rgba(0,0,0,0.08)'
          }}
        >
          {error}
        </div>
      )}
      {/* Success Message */}

    {successMessage && (
  <div
    style={{
      background: 'white',
      padding: '20px 24px',
      borderRadius: '12px',
      boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
      border: '1px solid #c7eac7',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      color: '#0b6a0b',
      fontSize: '15px',
      fontWeight: 500
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <div
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          backgroundColor: '#0b6a0b',
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '18px',
          fontWeight: 'bold'
        }}
      >
        ✓
      </div>
      <span>{successMessage.text}</span>
    </div>

    <a
      href={successMessage.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: '#0b6a0b',
        fontWeight: 600,
        textDecoration: 'none',
        padding: '6px 10px',
        borderRadius: '6px',
        background: '#e8f5e8',
        width: 'fit-content',
        transition: 'background 0.2s ease, color 0.2s ease'
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.background = '#d9f0d9';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.background = '#e8f5e8';
      }}
    >
      View work item →
    </a>

    <span style={{ fontSize: '14px', color: '#2d662d' }}>
      {successMessage.details}
    </span>
  </div>
)}



      {/* PR Info Card */}
      <div
        style={{
          background: 'white',
          padding: '24px',
          borderRadius: '12px',
          boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
          border: '1px solid #e1e1e1'
        }}
      >
        <PRInfoSection
          prTitle={prData?.prTitle}
          prId={prData?.prId}
          author={prData?.author}
          filesChanged={prData?.filesChanged}
        />
      </div>

      {/* Description text */}
      <div
        style={{
          background: 'white',
          padding: '20px 24px',
          borderRadius: '12px',
          boxShadow: '0 4px 14px rgba(0,0,0,0.06)',
          border: '1px solid #e1e1e1',
          fontSize: '15px',
          lineHeight: '1.55',
          color: '#444'
        }}
      >
        <p style={{ margin: 0 }}>
          Click the button below to generate AI‑driven test cases based on the pull request title, description, code changes, custom context, and overall change impact. A work item will be created automatically, and a comment will be posted on the PR with the generated test coverage details.
        </p>
        <p style={{ marginTop: '12px' }}>
          This process may take some time, especially for larger pull requests or when the backend is under heavy load. Please wait after clicking
          <strong> "Generate"</strong>. If something goes wrong, an error message will appear above.
        </p>
      </div>

      {/* AI Activity Feed - shows during generation */}
      {isGenerating && (
        <AIActivityFeed
          currentStep={currentStep}
          completedSteps={completedSteps}
        />
      )}

      {/* Generate button */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          marginTop: '8px'
        }}
      >
        <GenerateButton
          isLoading={isGenerating}
          isDisabled={!prData}
          onClick={handleGenerateTests}
          countdown={countdown}
        />
      </div>
    </div>
  </FluentProvider>
);
};

export { PRAssistantHub };