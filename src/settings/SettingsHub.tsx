/**
 * AI Assistant Context Settings Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';
import { getClient, IExtensionDataManager } from 'azure-devops-extension-api';
import { GitRestClient, GitRepository } from 'azure-devops-extension-api/Git';
import { CommonServiceIds, IProjectPageService, IExtensionDataService } from 'azure-devops-extension-api';
import { FluentProvider, webLightTheme, Field, Textarea, Button } from '@fluentui/react-components';
// --- WEBHOOK AUTO-GENERATION DISABLED --- Spinner only used in webhook UI
// import { Spinner } from '@fluentui/react-components';
import { Combobox, Option } from '@fluentui/react-combobox';
import { AIContextDocument } from '../types/extension-types';
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

export const SettingsHub: React.FC = () => {
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
}, []);

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
  try {
    await dataManager.getDocument("ai-contexts", "project-default");
  } catch (err: any) {
    const typeKey = err?.typeKey || "";

    if (
      typeKey === "CollectionNotFoundException" ||
      typeKey === "DocumentNotFoundException"
    ) {
      await dataManager.setDocument("ai-contexts", {
        id: "project-default",
        contextText: "",
        updatedAt: now(),
        updatedBy: SDK.getUser().displayName
      });
      return;
    }

    throw err;
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
      "QAZent.pr-assistant-extension",
      await SDK.getAccessToken()
    );

    await ensureCollectionExists(dataManager);

    const safeId = normalizeId(repoId);

    const document = await dataManager.getDocument("ai-contexts", safeId);

    setLoadedDocument(document);
    setContextText((document as AIContextDocument)?.contextText ?? "");
  } catch (err: any) {
    const typeKey = err?.typeKey || "";

    if (typeKey === "DocumentNotFoundException") {
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
      "QAZent.pr-assistant-extension",
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
  <div
    style={{
      padding: "24px",
      display: "flex",
      gap: "24px",
      alignItems: "flex-start",
    }}
  >
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

      {errorMessage && (
        <div
          style={{
            backgroundColor: "#fde7e9",
            border: "1px solid #e81123",
            color: "#e81123",
            padding: "12px",
            marginBottom: "16px",
            borderRadius: "4px",
          }}
        >
          {errorMessage}
        </div>
      )}

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
          <Textarea
            spellCheck={false}
            rows={12}
            value={contextText}
            onChange={(_e, data) => setContextText((data.value ?? "").slice(0, MAX_CONTEXT_LENGTH))}
            disabled={isLoading}
            placeholder="Enter custom context for the AI assistant..."
            style={{ width: "100%" }}
          />
          <div
            style={{
              marginTop: "4px",
              fontSize: "12px",
              color: contextText.length >= MAX_CONTEXT_LENGTH ? "#a4262c" : "#605e5c",
            }}
          >
            {contextText.length.toLocaleString()} / {MAX_CONTEXT_LENGTH.toLocaleString()} characters
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
        </Button>

        <Button
          appearance="primary"
          disabled={isSaving || isLoading}
          onClick={handleClear}
        >
          Clear
        </Button>
      </div>

      {/* --- WEBHOOK AUTO-GENERATION DISABLED ---
         This infrastructure requires token storage for async webhook processing.
         SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
         The webhook flow has no frontend wiring to push tokens to the backend.
         Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
         To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
         See architecture notes in this file for details.

      <div
        style={{
          borderTop: "1px solid #edebe9",
          marginTop: "32px",
          paddingTop: "24px",
        }}
      >
        <h2 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "16px" }}>
          Automatic Test Generation
        </h2>

        <div style={{ marginBottom: "20px", backgroundColor: "#f3f9fd", border: "1px solid #0078d4", padding: "12px", borderRadius: "4px" }}>
          <div style={{ fontSize: "14px", color: "#0078d4", marginBottom: "4px" }}>
            <strong>Webhook Endpoint:</strong>
          </div>
          <div style={{ fontFamily: "monospace", fontSize: "13px", color: "#323130", wordBreak: "break-all" }}>
            {configService.WEBHOOK_ENDPOINT}
          </div>
          <div style={{ fontSize: "12px", color: "#605e5c", marginTop: "8px" }}>
            This endpoint is fixed and cannot be changed. All webhooks send events to this address.
          </div>
        </div>

        {webhookStatusMessage && (
          <div
            style={{
              backgroundColor:
                webhookStatusMessage.type === 'success'
                  ? '#dff6dd'
                  : webhookStatusMessage.type === 'error'
                  ? '#fde7e9'
                  : '#f3f9fd',
              border:
                webhookStatusMessage.type === 'success'
                  ? '1px solid #107c10'
                  : webhookStatusMessage.type === 'error'
                  ? '1px solid #e81123'
                  : '1px solid #0078d4',
              color:
                webhookStatusMessage.type === 'success'
                  ? '#107c10'
                  : webhookStatusMessage.type === 'error'
                  ? '#e81123'
                  : '#0078d4',
              padding: '12px',
              borderRadius: '4px',
              marginBottom: '16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{webhookStatusMessage.text}</span>
            <Button
              appearance="transparent"
              onClick={() => setWebhookStatusMessage(null)}
              style={{ minWidth: 'auto', padding: '4px' }}
            >
              ✕
            </Button>
          </div>
        )}

        <div
          style={{
            background: '#f3f2f1',
            border: '1px solid #edebe9',
            padding: '16px',
            borderRadius: '4px',
            marginBottom: '20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <Button
              appearance="primary"
              onClick={handleEnableAutoGeneration}
              disabled={webhookLoading || isAutoGenEnabled}
            >
              Enable Auto-Generation
            </Button>
            {isAutoGenEnabled && (
              <span style={{ fontWeight: 'bold', color: '#107c10' }}>
                ✅ Enabled
              </span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: '14px', color: '#605e5c' }}>
            Creates webhooks for pull request created and updated events. Webhooks will trigger for all repositories in this project.
          </p>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>
            Active Webhooks ({webhooks.length})
          </h3>

          {webhookLoading ? (
            <div style={{ padding: '20px', textAlign: 'center' }}>
              <Spinner label="Loading webhooks..." />
            </div>
          ) : webhooks.length === 0 ? (
            <div
              style={{
                backgroundColor: '#f3f9fd',
                border: '1px solid #0078d4',
                color: '#0078d4',
                padding: '12px',
                borderRadius: '4px',
              }}
            >
              No webhooks configured yet. Click "Enable Auto-Generation" above to get started.
            </div>
          ) : (
            <div>
              {webhooks.map((webhook) => (
                <div
                  key={webhook.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 0',
                    borderBottom: '1px solid #edebe9',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <strong style={{ fontSize: '14px' }}>
                      {webhook.eventType
                        .replace('git.pullrequest.', 'Pull Request ')
                        .split('.')
                        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                        .join(' ')}
                    </strong>
                    <span style={{ fontSize: '12px', color: '#605e5c' }}>
                      {new Date(webhook.createdDate).toLocaleDateString()} {new Date(webhook.createdDate).toLocaleTimeString()}
                    </span>
                    <span style={{ fontSize: '12px', color: '#605e5c' }}>
                      {webhook.publisherInputs.repository || 'All repositories'}
                    </span>
                  </div>
                  <Button
                    appearance="subtle"
                    onClick={() => handleDeleteWebhook(webhook.id)}
                    disabled={webhookLoading}
                    title="Delete webhook"
                    style={{ color: '#e81123' }}
                  >
                    🗑️ Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginTop: '24px' }}>
          <Button
            appearance="secondary"
            onClick={() => setShowManualSetup(!showManualSetup)}
          >
            {showManualSetup ? 'Hide Manual Setup Instructions' : 'Show Manual Setup Instructions'} ℹ️
          </Button>

          {showManualSetup && (
            <div
              style={{
                background: '#fff4ce',
                border: '1px solid #f7d575',
                padding: '16px',
                borderRadius: '4px',
                marginTop: '12px',
                fontSize: '14px',
                lineHeight: '1.5',
              }}
            >
              <h4 style={{ fontWeight: 600, marginTop: 0, marginBottom: '8px' }}>
                Manual Setup Instructions
              </h4>
              <p style={{ marginBottom: '12px' }}>
                If you don't have permission to create webhooks automatically, or if you prefer to set them up manually, follow these steps:
              </p>
              <ol style={{ marginLeft: '20px', marginBottom: '12px' }}>
                <li>Go to <strong>Project Settings → Service Hooks</strong></li>
                <li>Click <strong>Create subscription</strong></li>
                <li>Select <strong>Web Hooks</strong> as the service type</li>
                <li>Choose <strong>Pull request created</strong> as the trigger event</li>
                <li>Set repository filter to <strong>All repositories</strong> (or choose specific repository)</li>
                <li>
                  Enter URL: <code style={{ background: '#f0f0f0', padding: '2px 6px', borderRadius: '3px', fontFamily: 'monospace' }}>
                    {configService.WEBHOOK_ENDPOINT}
                  </code>
                </li>
                <li>Click <strong>Finish</strong></li>
                <li>Repeat steps 2-7 for <strong>Pull request updated</strong> event</li>
              </ol>
              <p style={{ margin: 0 }}>
                <strong>Required permissions:</strong> Project Administrator or Service Hook Administrator
              </p>
            </div>
          )}
        </div>
      </div>
      */}
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
  </div>
</FluentProvider>
  );
};
