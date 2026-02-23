/**
 * AI Assistant Context Settings Hub Component
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';
import { getClient, IExtensionDataManager } from 'azure-devops-extension-api';
import { GitRestClient, GitRepository } from 'azure-devops-extension-api/Git';
import { CommonServiceIds, IProjectPageService, IExtensionDataService } from 'azure-devops-extension-api';
import { FluentProvider, webLightTheme, Field, Textarea, Button } from '@fluentui/react-components';
import { Combobox, Option } from '@fluentui/react-combobox';
import { AIContextDocument } from '../types/extension-types';

export const SettingsHub: React.FC = () => {
  const [projectId, setProjectId] = React.useState<string>('');
  const [repositories, setRepositories] = React.useState<GitRepository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = React.useState<string>('project-default');
  const [contextText, setContextText] = React.useState<string>('');
  const [loadedDocument, setLoadedDocument] = React.useState<any | null>(null);
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [isSaving, setIsSaving] = React.useState<boolean>(false);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

// -----------------------------
// Helpers
// -----------------------------

const normalizeId = (id: string) =>
  id === "project-default" ? "project-default" : `repo-${id}`;

const now = () => new Date().toISOString();

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
        "Failed to load context: " +
          (err instanceof Error ? err.message : JSON.stringify(err))
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
  setSelectedRepoId(newRepoId);
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
      "Failed to save context. Please try again! " +
        JSON.stringify(err, Object.getOwnPropertyNames(err))
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
            value={selectedRepoId}
            onOptionSelect={handleRepoChange}
            disabled={isLoading}
          >
            <Option value="project-default">
              Project Default (applies to all repos)
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
          hint="This context will be provided to the AI for all prompts in the selected repository"
        >
          <Textarea
            spellCheck={false}
            rows={12}
            value={contextText}
            onChange={(_e, data) => setContextText(data.value)}
            disabled={isLoading}
            placeholder="Enter custom context for the AI assistant..."
            style={{ width: "100%" }}
          />
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

      <strong>Recommended length:</strong>
      <ul style={{ marginTop: "6px", marginBottom: "12px" }}>
        <li>200–1,500 words</li>
        <li>Up to ~10,000 characters</li>
        <li>Short, focused, high‑signal information</li>
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
