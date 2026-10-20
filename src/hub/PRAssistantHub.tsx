/**
 * Main PR Assistant Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';

import { CommonServiceIds, getClient, IExtensionDataService, IProjectPageService } from 'azure-devops-extension-api';

import { FluentProvider, webLightTheme, Radio, RadioGroup } from '@fluentui/react-components';

import { PRInfoSection } from './PRInfoSection';
import { GenerateButton } from './GenerateButton';
import { AIActivityFeed } from './AIActivityFeed';
import { ENABLE_LICENSE_ENFORCEMENT } from '../config/featureFlags';
import { PRData, AIContextDocument } from '../types/extension-types';
import * as backendClient from '../services/backendClient';
import type { IContribution, IExtensionContextWithContributions } from '../types/extension-types';
import { GitRestClient } from 'azure-devops-extension-api/Git';
import { getLicenseStatus } from '../license/api';
import type { LicenseStatusResponse } from '../license/api';
import { LicenseGateMessage } from '../license/LicenseGateMessage';
import { LicenseCheckScreen } from '../license/LicenseCheckScreen';
import { useElapsedTimer } from '../hooks/useElapsedTimer';

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
  'https://api.qazent.com');  // Default backend URL, should be overridden by config

  type LicenseGateStatus = LicenseStatusResponse['status'] | 'loading';
  const [licenseCheckState, setLicenseCheckState] = React.useState<'loading' | 'success' | 'timeout'>(
    ENABLE_LICENSE_ENFORCEMENT ? 'loading' : 'success'
  );
  const [licenseStatus, setLicenseStatus] = React.useState<LicenseGateStatus>(
    ENABLE_LICENSE_ENFORCEMENT ? 'loading' : 'active'
  );
  const [licenseError, setLicenseError] = React.useState(false);
  const licenseAbortRef = React.useRef<AbortController | null>(null);

  const runCheckLicense = React.useCallback((baseUrl: string) => {
    if (!ENABLE_LICENSE_ENFORCEMENT) {
      setLicenseStatus('active');
      setLicenseCheckState('success');
      setLicenseError(false);
      return;
    }

    setLicenseCheckState('loading');
    setLicenseError(false);
    licenseAbortRef.current?.abort();
    const controller = new AbortController();
    licenseAbortRef.current = controller;
    getLicenseStatus(baseUrl, controller.signal)
      .then((data) => {
        setLicenseStatus(data.status);
        setLicenseCheckState('success');
      })
      .catch((err) => {
        // Ignore abort: timeout or Retry aborted the request; state is handled elsewhere
        if (err?.name === 'AbortError') return;
        setLicenseStatus('none');
        setLicenseError(true);
        setLicenseCheckState('success');
      });
  }, []);

  const isLicenseChecking = ENABLE_LICENSE_ENFORCEMENT && licenseCheckState === 'loading';
  const { elapsedSeconds, timedOut } = useElapsedTimer(isLicenseChecking, { timeoutSeconds: 90 });

  const [repositoryId, setRepositoryId] = React.useState<string>('');
  const [projectName, setProjectName] = React.useState<string>('');
  const [projectId, setProjectId] = React.useState<string>('');
  const [customContext, setCustomContext] = React.useState<string>('');
  const [currentStep, setCurrentStep] = React.useState<number | null>(null);
  const [completedSteps, setCompletedSteps] = React.useState<number[]>([]);
  const [postCommentOnPR, setPostCommentOnPR] = React.useState<boolean>(true);
  const [outputType, setOutputType] = React.useState<boolean>(false);
  const [mode, setMode] = React.useState<'qa' | 'review' | 'deep-review' | 'inline-comments'>('qa');


  React.useEffect(() => {
  const init = async () => {
    try {
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
      const baseUrl = backend || 'https://api.qazent.com';

      if (ENABLE_LICENSE_ENFORCEMENT) {
        runCheckLicense(baseUrl);
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
}, [runCheckLicense]);

  // Timeout: at 90s abort the request and show error + Retry
  React.useEffect(() => {
    if (!ENABLE_LICENSE_ENFORCEMENT) {
      return;
    }

    if (timedOut && licenseCheckState === 'loading') {
      licenseAbortRef.current?.abort();
      setLicenseCheckState('timeout');
    }
  }, [timedOut, licenseCheckState]);

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
        SDK.getExtensionContext().id,
        await SDK.getAccessToken()
      );
    
      // Load project default first
      const projectDefault = await dataManager.getDocument('ai-contexts', 'project-default');
      if (projectDefault && (projectDefault as AIContextDocument).contextText && (projectDefault as AIContextDocument).contextText.trim()) {
        contextParts.push((projectDefault as AIContextDocument).contextText.trim());
      }

      // Load repo-specific and append (not replace); use same doc id as SettingsHub: repo-${id}
      const repoDocId = repositoryId ? `repo-${repositoryId}` : null;
      const repoContext = repoDocId
        ? await dataManager.getDocument('ai-contexts', repoDocId).catch(() => null)
        : null;
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
      let workItemCommentPosted = false;
      let detailsCommentPosted = false;
      let inlinePosted = 0;
      let inlineFailed = 0;
      let inlineComments: backendClient.InlineCommentPayload[] = [];
      let skippedInlineCount = 0;
      const isInlineCommentsMode = mode === 'inline-comments';

      const postInlineOverlay = async () => {
        if (!isInlineCommentsMode || inlineComments.length === 0) {
          return;
        }
        try {
          const inlineResult = await backendClient.postPRInlineComments({
            prId: prData.prId,
            projectName,
            repositoryId,
            connection: backendUrl,
            inlineComments,
          });
          inlinePosted = inlineResult.posted;
          inlineFailed = inlineResult.failed;
        } catch (err) {
          console.warn('Inline PR comments failed:', err);
          inlineFailed = inlineComments.length;
        }
      };

      const appendInlineDetails = (details: string) => {
        const extra: string[] = [];
        if (inlinePosted > 0) {
          extra.push(`Posted ${inlinePosted} inline comments on the Files tab.`);
        }
        if (skippedInlineCount > 0) {
          extra.push(`${skippedInlineCount} findings could not be attached to a diff line.`);
        }
        if (inlineFailed > 0) {
          extra.push(`${inlineFailed} inline comments failed to post.`);
        }
        return extra.length > 0 ? `${details} ${extra.join(' ')}` : details;
      };

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
        customContext,
        mode
      );

      // Extract test case and commit IDs from response
      setCompletedSteps(prev => [...prev, 2]);
      setCurrentStep(3);
      inlineComments = response.inlineComments ?? [];
      skippedInlineCount = response.skippedInlineComments?.length ?? 0;
      const generatedTestCase = {
        title: response.title,
        htmlDescription: response.htmlDescription
      };
      const sourceCommitId = response.sourceCommitId;
      const targetCommitId = response.targetCommitId;

      // Validate commit IDs
      if (!sourceCommitId || !targetCommitId) {
        throw new Error('Backend did not return commit IDs. Please refresh and try again.');
      }

      if (outputType) {
        // outputType mode: skip work item creation, post full HTML directly as PR comment
        let fullOutputCommentPosted = false;
        setCompletedSteps(prev => [...prev, 3]);

        setCurrentStep(4);
        await new Promise(resolve => setTimeout(resolve, 400));
        setCompletedSteps(prev => [...prev, 4]);

        setCurrentStep(5);
        try {
          const fullOutputResponse = await backendClient.postPRComment({
            prId: prData.prId,
            projectName,
            repositoryId,
            connection: backendUrl,
            commentContent: generatedTestCase.htmlDescription
          });
          fullOutputCommentPosted = fullOutputResponse.success === true;
        } catch (err) {
          console.warn('Full output PR comment failed:', err);
        }
        await postInlineOverlay();
        setCompletedSteps(prev => [...prev, 5]);

        setCurrentStep(6);
        await new Promise(resolve => setTimeout(resolve, 400));
        setCompletedSteps(prev => [...prev, 6]);

        setCurrentStep(7);
        await new Promise(resolve => setTimeout(resolve, 400));
        setCompletedSteps(prev => [...prev, 7]);
        setCurrentStep(null);

        // Show success message for outputType mode
        setSuccessMessage({
          text: fullOutputCommentPosted
            ? 'Analysis posted on the pull request'
            : 'Analysis completed',
          url: 'result.workItemUrl',
          details: appendInlineDetails(
            fullOutputCommentPosted
              ? 'The full output was added as a PR comment. Open the pull request to review it.'
              : 'The analysis finished but could not be posted as a PR comment. Please try again.'
          )
        });
        setTimeout(() => setSuccessMessage(null), 60000);


      } else {
        // Default mode: create work item, then optionally post comment

        // Step 5: Immediately call /create-work-item with ALL required fields
        setCompletedSteps(prev => [...prev, 3]);
        setCurrentStep(4);
        let result: { workItemId: number; workItemUrl: string } | null = null;
        let workItemError: unknown = null;
        try {
          result = await backendClient.createWorkItem(
            generatedTestCase as any,
            prData.prId,
            projectName,
            repositoryId,
            backendUrl,
            projectId,
            sourceCommitId,
            targetCommitId
          );
        } catch (err) {
          workItemError = err;
          console.warn('Work item creation failed:', err);
        }

        // Step 6: Post main comment on PR (optional)
        setCompletedSteps(prev => [...prev, 4]);
        if (result && postCommentOnPR) {
          setCurrentStep(5);
          try {
            const commentResponse = await backendClient.postPRComment({
              prId: prData.prId,
              projectName,
              repositoryId,
              workItemId: result.workItemId,
              connection: backendUrl
            });
            workItemCommentPosted = commentResponse.success === true;
          } catch (err) {
            console.warn('PR comment failed but work item was created:', err);
          }

          // Step 6b: Extract Purpose and Scope of Change and post as additional PR comment
          try {
            const scopeHtml = await backendClient.extractPurposeAndScope(generatedTestCase.htmlDescription, backendUrl);
            if (scopeHtml && scopeHtml.length > 0) {
              const detailsCommentResponse = await backendClient.postPRComment({
                prId: prData.prId,
                projectName,
                repositoryId,
                workItemId: result.workItemId,
                connection: backendUrl,
                commentContent: scopeHtml
              });
              detailsCommentPosted = detailsCommentResponse.success === true;
            }
          } catch (err) {
            console.warn('Failed to post Purpose and Scope of Change comment:', err);
          }
          setCompletedSteps(prev => [...prev, 5]);
        }
        await postInlineOverlay();
        if (!result && inlinePosted === 0) {
          throw workItemError instanceof Error
            ? workItemError
            : new Error('Failed to create work item');
        }
        
        setCurrentStep(6);
        await new Promise(resolve => setTimeout(resolve, 400));
        setCompletedSteps(prev => [...prev, 6]);

        setCurrentStep(7);
        await new Promise(resolve => setTimeout(resolve, 400));
        setCompletedSteps(prev => [...prev, 7]);

        // Step 7: Show success message
        setCurrentStep(null);
        const detailParts: string[] = [];
        if (detailsCommentPosted) {
          detailParts.push('A PR comment with the output was posted successfully.');
        } else if (workItemCommentPosted) {
          detailParts.push('A work item was created successfully.');
        } else if (postCommentOnPR) {
          detailParts.push('Work item created, but the summaryPR comment was not posted successfully.');
        }
        if (detailParts.length === 0) detailParts.push('Work item created. No comment was added.');
        
        if (!result) {
          setSuccessMessage({
            text: 'Inline comments posted',
            url: '',
            details: appendInlineDetails('The work item could not be created.')
          });
        } else {
          // if radio button is set to comment then dont link the success message to the work item
          if (detailsCommentPosted) setSuccessMessage({
            text: "Output posted as PR comment!",
            url: '',
            details: appendInlineDetails('A PR comment with the output was posted successfully.')
          });
          // if radio button is set to full then link the success message to the work item
          if (!outputType && postCommentOnPR) {
            setSuccessMessage({
              text: "Work item created successfully!",
              url: result.workItemUrl,
              details: appendInlineDetails('Got it! The work item has been created.')
            });
          }
        }
        setTimeout(() => setSuccessMessage(null), 60000);
      }


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

  const containerStyle = {
    padding: '32px',
    maxWidth: '1100px',
    margin: '0 auto' as const,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '24px'
  };

  const showLicenseCheckScreen =
    ENABLE_LICENSE_ENFORCEMENT &&
    (licenseCheckState === 'loading' || licenseCheckState === 'timeout');
  const showLicenseGate =
    ENABLE_LICENSE_ENFORCEMENT &&
    licenseCheckState === 'success' &&
    licenseStatus !== 'active';
  const showMainContent =
    !ENABLE_LICENSE_ENFORCEMENT ||
    (licenseCheckState === 'success' && licenseStatus === 'active');

  return (
  <FluentProvider theme={webLightTheme}>
    <div style={containerStyle}>
      {showLicenseCheckScreen && (
        <LicenseCheckScreen
          elapsedSeconds={elapsedSeconds}
          timedOut={licenseCheckState === 'timeout'}
          onRetry={() => runCheckLicense(backendUrl)}
        />
      )}
      {showLicenseGate && (
        <LicenseGateMessage showNetworkHint={licenseError} />
      )}
      {showMainContent && (
        <>
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
          Click the button below to run analysis on this pull request using the title, description, code changes, commit messages, and custom context. Depending on your mode and output options, results appear as structured test cases or a code review — as a work item, a PR comment, or both.
        </p>
        <p style={{ marginTop: '12px' }}>
          This process may take some time, especially for larger pull requests or when the backend is under heavy load. Please wait after clicking
          <strong> Analyze</strong>. If something goes wrong, an error message will appear above.
        </p>
        <p style={{ marginTop: '12px', marginBottom: 0 }}>
          Analysis uses the latest Gemini 4 Argon model.
        </p>
      </div>

 {/* Optional: Post comment / Add label */}
<div
  style={{
    background: 'white',
    padding: '16px 24px',
    borderRadius: '12px',
    boxShadow: '0 4px 14px rgba(0,0,0,0.06)',
    border: '1px solid #e1e1e1',
    marginTop: '12px'
  }}
>
  <div style={{ fontSize: '14px', fontWeight: 600, color: '#444', marginBottom: '10px' }}>
    Output options
  </div>

  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
    {/* Mode */}
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '4px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#555' }}>Mode</div>
      <RadioGroup
        value={mode}
        onChange={(_e, data) => {
          setMode(data.value as 'qa' | 'review' | 'deep-review' | 'inline-comments');
        }}
        disabled={isGenerating}
      >
        <Radio value="qa" label="QA Mode" />
        <Radio value="review" label="Code Review Mode" />
        <Radio value="deep-review" label="Deep Technical Review Mode" />
        <Radio value="inline-comments" label="Inline Diff Comments Mode" />
      </RadioGroup>
    </div>

    {/* Output Type (RadioGroup replacing checkboxes) */}
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#555' }}>PR Output</div>
      
      <RadioGroup
        value={postCommentOnPR ? 'summary' : 'full'}
        onChange={(_e, data) => {
          const value = data.value as 'summary' | 'full';
          if (value === 'summary') {
            setPostCommentOnPR(true);
            setOutputType(false);
          } else {
            setPostCommentOnPR(false);
            setOutputType(true);
          }
        }}
        disabled={isGenerating}
      >
        <Radio
          value="summary"
          label="Post full output as a work item with a link to the PR"
        />

        <Radio
          value="full"
          label="Post full output as a comment on the PR"
        />
      </RadioGroup>
    </div>

  </div>
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
        />
      </div>
        </>
      )}
    </div>
  </FluentProvider>
);
};

export { PRAssistantHub };
