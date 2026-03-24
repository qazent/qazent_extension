/**
 * AI Assistant Context Settings Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';
import { getClient, IExtensionDataManager } from 'azure-devops-extension-api';
import { GitRestClient, GitRepository } from 'azure-devops-extension-api/Git';
import { CommonServiceIds, IProjectPageService, IExtensionDataService } from 'azure-devops-extension-api';
import { FluentProvider, webLightTheme, Field, Textarea, Button } from '@fluentui/react-components';
import { ArrowUploadRegular, DeleteRegular } from '@fluentui/react-icons';
import { Combobox, Option } from '@fluentui/react-combobox';
import { AIContextDocument } from '../types/extension-types';
import type { IContribution, IExtensionContextWithContributions } from '../types/extension-types';
import { getLicenseStatus } from '../license/api';
import type { LicenseStatusResponse } from '../license/api';
import { LicenseGateMessage } from '../license/LicenseGateMessage';
import { LicenseCheckScreen } from '../license/LicenseCheckScreen';
import { useElapsedTimer } from '../hooks/useElapsedTimer';
// --- WEBHOOK AUTO-GENERATION DISABLED ---
// This infrastructure requires token storage for async webhook processing.
// SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
// The webhook flow has no frontend wiring to push tokens to the backend.
// Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
// To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
// See architecture notes in this file for details.
// import * as configService from '../services/configService';
// import * as webhookService from '../services/webhookService';
// import { WebhookSubscription } from '../services/webhookService';

const PROJECT_DEFAULT_LABEL = "Project Default (applies to all repos)";

/** Max custom context length: ~3–4 paragraphs (matches server limit). */
const MAX_CONTEXT_LENGTH = 3000;

type LicenseGateStatus = LicenseStatusResponse['status'] | 'loading';

const DEFAULT_BACKEND_URL = 'https://api.qazent.com';

export const SettingsHub: React.FC = () => {
  const [licenseCheckState, setLicenseCheckState] = React.useState<'loading' | 'success' | 'timeout'>('loading');
  const [licenseStatus, setLicenseStatus] = React.useState<LicenseGateStatus>('loading');
  const [licenseError, setLicenseError] = React.useState(false);
  const licenseAbortRef = React.useRef<AbortController | null>(null);
  const baseUrlRef = React.useRef<string>(DEFAULT_BACKEND_URL);

  const runCheckLicense = React.useCallback((baseUrl: string) => {
    baseUrlRef.current = baseUrl;
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

  const isLicenseChecking = licenseCheckState === 'loading';
  const { elapsedSeconds, timedOut } = useElapsedTimer(isLicenseChecking, { timeoutSeconds: 90 });

  const [projectId, setProjectId] = React.useState<string>('');
  const [repositories, setRepositories] = React.useState<GitRepository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = React.useState<string>('project-default');
  const [selectedRepoName, setSelectedRepoName] = React.useState<string>(PROJECT_DEFAULT_LABEL);
  const [contextText, setContextText] = React.useState<string>('');
  const [loadedDocument, setLoadedDocument] = React.useState<any | null>(null);
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [isSaving, setIsSaving] = React.useState<boolean>(false);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // --- WEBHOOK AUTO-GENERATION DISABLED ---
  // This infrastructure requires token storage for async webhook processing.
  // SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
  // The webhook flow has no frontend wiring to push tokens to the backend.
  // Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
  // To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
  // See architecture notes in this file for details.
  /*
  const [webhooks, setWebhooks] = React.useState<WebhookSubscription[]>([]);
  const [webhookLoading, setWebhookLoading] = React.useState<boolean>(false);
  const [isAutoGenEnabled, setIsAutoGenEnabled] = React.useState<boolean>(false);
  const [webhookStatusMessage, setWebhookStatusMessage] = React.useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [showManualSetup, setShowManualSetup] = React.useState<boolean>(false);
  */

// -----------------------------
// Helpers
// -----------------------------

const normalizeId = (id: string) =>
  id === "project-default" ? "project-default" : `repo-${id}`;

const now = () => new Date().toISOString();

// --- WEBHOOK AUTO-GENERATION DISABLED --- errorMessageFromError only used by webhook functions
/*
const errorMessageFromError = (error: any): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unexpected error occurred';
};
*/

// Cached services
const dataServiceRef = React.useRef<IExtensionDataService | null>(null);
const projectServiceRef = React.useRef<IProjectPageService | null>(null);

// -----------------------------
// Component Initialization
// -----------------------------

React.useEffect(() => {
  const init = async () => {
    try {
      if (!(SDK as any)._initialized) {
        await SDK.init();
        await SDK.ready();
        (SDK as any)._initialized = true;
      }

      if (!projectServiceRef.current) {
        projectServiceRef.current = await SDK.getService<IProjectPageService>(
          CommonServiceIds.ProjectPageService
        );
      }

      const project = await projectServiceRef.current.getProject();
      if (!project) {
        setErrorMessage("Unable to determine current project context");
        setIsLoading(false);
        return;
      }

      setProjectId(project.id);

      // Resolve backendUrl from contribution (same pattern as PRAssistantHub)
      const extContext = SDK.getExtensionContext() as unknown as IExtensionContextWithContributions;
      const contributionId = SDK.getContributionId();
      const contribution = extContext.contributions?.find((c: IContribution) => c.id === contributionId);
      const baseUrl = contribution?.properties?.backendUrl || DEFAULT_BACKEND_URL;

      // License check (runs in parallel; UI shows LicenseCheckScreen with timer)
      runCheckLicense(baseUrl);

      const gitClient = getClient(GitRestClient);
      const repos = await gitClient.getRepositories(project.id);
      setRepositories(repos);

      await loadContext("project-default");

      setIsLoading(false);
    } catch (err) {
      setErrorMessage(
        "Failed to initialize: " +
          (err instanceof Error ? err.message : String(err))
      );
      setIsLoading(false);
    }
  };

  init();
}, [runCheckLicense]);

  // Timeout: at 90s abort the request and show error + Retry
  React.useEffect(() => {
    if (timedOut && licenseCheckState === 'loading') {
      licenseAbortRef.current?.abort();
      setLicenseCheckState('timeout');
    }
  }, [timedOut, licenseCheckState]);

// --- WEBHOOK AUTO-GENERATION DISABLED ---
// This infrastructure requires token storage for async webhook processing.
// SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
// The webhook flow has no frontend wiring to push tokens to the backend.
// Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
// To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
// See architecture notes in this file for details.
/*
const loadWebhookData = async () => {
  setWebhookLoading(true);
  try {
    const allWebhooks = await webhookService.listWebhookSubscriptions();
    setWebhooks(allWebhooks);

    const enabled = await webhookService.isAutoGenerationEnabled(projectId);
    setIsAutoGenEnabled(enabled);
  } catch (error) {
    const errorMsg = errorMessageFromError(error);
    setWebhookStatusMessage({
      type: 'error',
      text: `Failed to load webhooks: ${errorMsg}`
    });
  } finally {
    setWebhookLoading(false);
  }
};

React.useEffect(() => {
  if (projectId) {
    loadWebhookData();
  }
}, [projectId]);
*/

// -----------------------------
// Ensure collection exists
// -----------------------------

const ensureCollectionExists = async (dataManager: IExtensionDataManager) => {
  const defaultDocument = {
    id: "project-default",
    contextText: "",
    updatedAt: now(),
    updatedBy: SDK.getUser().displayName
  };
  try {
    const doc = await dataManager.getDocument("ai-contexts", "project-default");
    if (doc == null) {
      await dataManager.setDocument("ai-contexts", defaultDocument);
    }
  } catch (_err: any) {
    try {
      await dataManager.setDocument("ai-contexts", defaultDocument);
    } catch (setErr) {
      throw setErr;
    }
  }
};

// -----------------------------
// Load context
// -----------------------------

const loadContext = async (repoId: string) => {
  try {
    setIsLoading(true);
    setErrorMessage(null);

    if (!dataServiceRef.current) {
      dataServiceRef.current = await SDK.getService<IExtensionDataService>(
        CommonServiceIds.ExtensionDataService
      );
    }

    const dataManager = await dataServiceRef.current.getExtensionDataManager(
      SDK.getExtensionContext().id,
      await SDK.getAccessToken()
    );

    await ensureCollectionExists(dataManager);

    const safeId = normalizeId(repoId);

    const document = await dataManager.getDocument("ai-contexts", safeId);

    setLoadedDocument(document);
    setContextText((document as AIContextDocument)?.contextText ?? "");
  } catch (err: any) {
    const typeKey = err?.typeKey || "";
    const message = err?.message ?? "";
    const status = err?.status ?? err?.statusCode;
    const isNotFound =
      typeKey === "DocumentNotFoundException" ||
      typeKey === "CollectionNotFoundException" ||
      status === 404 ||
      /not found|does not exist|404/i.test(String(message));

    if (isNotFound) {
      setLoadedDocument(null);
      setContextText("");
    } else {
      setErrorMessage(
      `We couldn't load your saved context.  
    Please try again in a moment.`

      );
    }
  } finally {
    setIsLoading(false);
  }
};

// -----------------------------
// Repo change
// -----------------------------

const handleRepoChange = async (_event: any, data: any) => {
  const newRepoId = data.optionValue || "project-default";

  let newRepoName: string;
  if (newRepoId === "project-default") {
    newRepoName = PROJECT_DEFAULT_LABEL;
  } else {
    const repo = repositories.find((r) => r.id === newRepoId);
    newRepoName = repo?.name ?? data.optionText ?? newRepoId;
  }

  setSelectedRepoId(newRepoId);
  setSelectedRepoName(newRepoName);
  await loadContext(newRepoId);
};

// -----------------------------
// Save context (with retry)
// -----------------------------

const handleSave = async () => {
  try {
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!dataServiceRef.current) {
      dataServiceRef.current = await SDK.getService<IExtensionDataService>(
        CommonServiceIds.ExtensionDataService
      );
    }

    const dataManager = await dataServiceRef.current.getExtensionDataManager(
      SDK.getExtensionContext().id,
      await SDK.getAccessToken()
    );

    const user = SDK.getUser();
    const safeId = normalizeId(selectedRepoId);

    const baseDocument = loadedDocument || { id: safeId };

    const updatedFields: Partial<AIContextDocument> = {
      id: safeId,
      projectId,
      contextText,
      updatedAt: now(),
      updatedBy: user.displayName
    };

    if (selectedRepoId !== "project-default") {
      const repo = repositories.find((r) => r.id === selectedRepoId);
      if (!repo) throw new Error("Selected repository not found");

      updatedFields.repositoryId = selectedRepoId;
      updatedFields.repositoryName = repo.name;
    }

    const document = { ...baseDocument, ...updatedFields };

    let savedDocument;

    try {
      // First attempt — uses document.__etag if present
      savedDocument = await dataManager.setDocument("ai-contexts", document);
    } catch (err: any) {
      if (err?.typeKey === "InvalidDocumentVersionException") {
        const latest = await dataManager.getDocument("ai-contexts", safeId);

        const merged = { ...latest, ...updatedFields };

        savedDocument = await dataManager.setDocument("ai-contexts", merged);
      } else {
        throw err;
      }
    }

    setLoadedDocument(savedDocument);

    setSuccessMessage(
      `Context saved successfully for ${
        selectedRepoId === "project-default"
          ? "project default"
          : `repository "${document.repositoryName}"`
      }!`
    );

    setTimeout(() => setSuccessMessage(null), 3000);
  } catch (err) {
    setErrorMessage(
      "Failed to save context. Please try again!"
    );
  } finally {
    setIsSaving(false);
  }
};

// -----------------------------
// Clear
// -----------------------------

const handleClear = () => {
  setContextText("");
  setLoadedDocument(null);
};

// --- WEBHOOK AUTO-GENERATION DISABLED ---
// This infrastructure requires token storage for async webhook processing.
// SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
// The webhook flow has no frontend wiring to push tokens to the backend.
// Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
// To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
// See architecture notes in this file for details.
/*
const handleEnableAutoGeneration = async () => {
  setWebhookLoading(true);
  setWebhookStatusMessage(null);

  try {
    const result = await webhookService.enableAutoGeneration(projectId);

    if (result.skipped) {
      setWebhookStatusMessage({
        type: 'info',
        text: 'Webhooks already configured for this project'
      });
    } else {
      const count = result.created.length + result.updated.length;
      setWebhookStatusMessage({
        type: 'success',
        text: `✅ Successfully created ${count} webhook subscription(s). Auto-generation is now enabled!`
      });
    }

    await loadWebhookData();
  } catch (error) {
    const errorMsg = errorMessageFromError(error);

    if (error instanceof webhookService.AuthError) {
      setWebhookStatusMessage({
        type: 'error',
        text: `${errorMsg} See manual setup instructions below for an alternative approach.`
      });
      setShowManualSetup(true);
    } else {
      setWebhookStatusMessage({
        type: 'error',
        text: `Failed to create webhooks: ${errorMsg}`
      });
    }
  } finally {
    setWebhookLoading(false);
  }
};

const handleDeleteWebhook = async (subscriptionId: string) => {
  if (!confirm('Are you sure you want to delete this webhook?')) {
    return;
  }

  setWebhookLoading(true);
  try {
    await webhookService.deleteWebhookSubscription(subscriptionId);
    setWebhookStatusMessage({
      type: 'success',
      text: 'Webhook deleted successfully'
    });
    await loadWebhookData();
  } catch (error) {
    const errorMsg = errorMessageFromError(error);
    setWebhookStatusMessage({
      type: 'error',
      text: `Failed to delete webhook: ${errorMsg}`
    });
  } finally {
    setWebhookLoading(false);
  }
};
*/

  return (
    <FluentProvider theme={webLightTheme}>
  <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "24px" }}>
    {errorMessage && (
      <div
        style={{
          backgroundColor: "#fde7e9",
          border: "1px solid #e81123",
          color: "#e81123",
          padding: "12px",
          marginBottom: "0",
          borderRadius: "4px",
        }}
      >
        {errorMessage}
      </div>
    )}
    <div
      style={{
        display: "flex",
        gap: "24px",
        alignItems: "flex-start",
      }}
    >
    {(licenseCheckState === 'loading' || licenseCheckState === 'timeout') && (
      <LicenseCheckScreen
        elapsedSeconds={elapsedSeconds}
        timedOut={licenseCheckState === 'timeout'}
        onRetry={() => runCheckLicense(baseUrlRef.current || DEFAULT_BACKEND_URL)}
      />
    )}
    {licenseCheckState === 'success' && licenseStatus !== 'active' && (
      <LicenseGateMessage showNetworkHint={licenseError} />
    )}
    {licenseCheckState === 'success' && licenseStatus === 'active' && (
    <>
    {/* LEFT COLUMN */}
    <div style={{ flex: 1, minWidth: 0 }}>
      <h1 style={{ fontSize: "24px", fontWeight: 600, marginBottom: "8px" }}>
        QAZent AI Assistant - Custom Context Settings
      </h1>

      <p style={{ color: "#605e5c", marginBottom: "24px" }}>
        Configure custom context that will be provided to the AI assistant when
        generating test cases. Set a project-wide default or customize context
        for specific repositories.
      </p>

      {successMessage && (
        <div
          style={{
            backgroundColor: "#fcfcfc",
            border: "1px solid #000000",
            color: "#0edd4c",
            padding: "12px",
            marginBottom: "16px",
            borderRadius: "4px",
          }}
        >
          {successMessage}
        </div>
      )}

      <div style={{ marginBottom: "20px" }}>
        <Field label="Repository">
          <Combobox
            placeholder={
              isLoading && repositories.length === 0
                ? "Loading repositories..."
                : "Select repository"
            }
            value={selectedRepoName}
            onOptionSelect={handleRepoChange}
            disabled={isLoading}
          >
            <Option value="project-default">
              {PROJECT_DEFAULT_LABEL}
            </Option>

            {repositories.map((repo) => (
              <Option key={repo.id} value={repo.id}>
                {repo.name}
              </Option>
            ))}
          </Combobox>
        </Field>
      </div>

 <div style={{ marginBottom: "20px" }}>
  <Field
    label="Custom Context"
    hint="This context will be provided to the AI for all prompts in the selected repository. Keep to 3–4 paragraphs (max 3,000 characters)."
  >
    <div style={{ marginBottom: "8px", color: "#605e5c" }}>
      <Field
        label="Security Hint"
        hint="This information is stored securely in Azure DevOps Data Storage and is only accessible to users with access to this project. Do not include sensitive information such as secrets, credentials, or personally identifiable information."
        style={{ marginBottom: 8 }}
      />
    </div>

    <Textarea
      spellCheck={false}
      rows={20}
      value={contextText}
      onChange={(_e, data) =>
        setContextText((data.value ?? "").slice(0, MAX_CONTEXT_LENGTH))
      }
      disabled={isLoading}
      placeholder="Enter custom context for the AI assistant..."
      style={{ width: "100%" }}
    />

    <div
      style={{
        marginTop: "4px",
        fontSize: "12px",
        color:
          contextText.length >= MAX_CONTEXT_LENGTH ? "#a4262c" : "#605e5c",
      }}
    >
      {contextText.length.toLocaleString()} /{" "}
      {MAX_CONTEXT_LENGTH.toLocaleString()} characters
    </div>
  </Field>
</div>
      <div style={{ display: "flex", gap: "12px", marginBottom: "20px" }}>
        <Button
          appearance="primary"
          disabled={isSaving || isLoading}
          onClick={handleSave}
        >
          {isSaving ? "Saving..." : "Save Context"}

          <div style={{ marginRight: "8px" }}></div>
          <ArrowUploadRegular /> 
        </Button>

        <Button
        appearance="secondary"
        disabled={isSaving || isLoading}
        onClick={handleClear}
      >
        Clear
        <div style={{ marginRight: "8px" }}></div>
        <DeleteRegular />
      </Button>
      </div>
    </div>

    {/* RIGHT COLUMN – GUIDELINES */}
    <div
      style={{
        width: "320px",
        backgroundColor: "#f3f2f1",
        border: "1px solid #edebe9",
        padding: "16px",
        borderRadius: "4px",
        color: "#323130",
        position: "sticky",
        top: "24px",
      }}
    >
      <h3 style={{ marginTop: 0, fontSize: "16px", fontWeight: 600 }}>
        Custom Context Guidelines
      </h3>

      <p style={{ marginBottom: "12px" }}>
        The custom context helps the AI understand your project's conventions,
        domain knowledge, and testing expectations.
      </p>

      <strong>Length:</strong>
      <ul style={{ marginTop: "6px", marginBottom: "12px" }}>
        <li>Keep to 3–4 paragraphs</li>
        <li>Maximum: {MAX_CONTEXT_LENGTH.toLocaleString()} characters (enforced)</li>
        <li>Short, focused, high‑signal information works best</li>
      </ul>

      <strong>Good things to include:</strong>
      <ul style={{ marginTop: "6px", marginBottom: "12px" }}>
        <li>Tech stack</li>
        <li>Domain or business context</li>
        <li>Testing preferences</li>
        <li>Core features of the application</li>
        <li>Platform details (desktop, web, etc.)</li>
        <li>Tools used for testing</li>
      </ul>

      <strong>Avoid including:</strong>
      <ul style={{ marginTop: "6px", marginBottom: "12px" }}>
        <li>Large code samples</li>
        <li>Full architecture docs</li>
        <li>Entire wiki pages</li>
        <li>Meeting notes or requirement dumps</li>
      </ul>

      <strong>Example:</strong>
      <p style={{ fontStyle: "italic", marginTop: "6px" }}>
        “Our project is a legacy .NET desktop application with a lot of business
        logic in stored procedures. We prefer manual testing and emphasize
        domain‑driven validation....”
      </p>
    </div>
    </>
    )}
    </div>
  </div>
</FluentProvider>
  );
};
