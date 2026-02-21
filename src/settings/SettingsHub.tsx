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
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [isSaving, setIsSaving] = React.useState<boolean>(false);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    const init = async () => {
      try {
        // Initialize Azure DevOps SDK
        await SDK.init();
        await SDK.ready();

        // Get project context
        const projectService = await SDK.getService<IProjectPageService>(
          CommonServiceIds.ProjectPageService
        );
        const project = await projectService.getProject();
        
        if (!project) {
          setErrorMessage('Unable to determine current project context');
          setIsLoading(false);
          return;
        }

        setProjectId(project.id);

        // Get repositories
        const gitClient = getClient(GitRestClient);
        const repos = await gitClient.getRepositories(project.id);
        setRepositories(repos);

        // Load context for project default initially
        await loadContext('project-default');

        setIsLoading(false);
      } catch (err) {
        setErrorMessage('Failed to initialize: ' + (err instanceof Error ? err.message : String(err)));
        setIsLoading(false);
      }
    };

    init();
  }, []);
  /**
   * Ensures the ai-contexts collection exists.
   * If missing, seeds it with an empty project-default document.
   */
    const ensureCollectionExists = async (dataManager: IExtensionDataManager) => {
  try {
    await dataManager.getDocument("ai-contexts", "project-default");
  } catch (err: any) {
    const msg = String(err);

    // Detect missing collection
    if (msg.includes("The collection does not exist")) {
      // Seed the collection
      await dataManager.setDocument("ai-contexts", {
        id: "project-default",
        contextText: "",
        updatedAt: new Date().toISOString(),
        updatedBy: SDK.getUser().displayName
      });
      return;
    }

    // Detect missing document (collection exists but project-default missing)
    if (msg.includes("DocumentNotFound")) {
      await dataManager.setDocument("ai-contexts", {
        id: "project-default",
        contextText: "",
        updatedAt: new Date().toISOString(),
        updatedBy: SDK.getUser().displayName
      });
      return;
    }

    // Unknown error → rethrow
    throw err;
  }
};


    const loadContext = async (repoId: string) => {
  try {
    setIsLoading(true);
    setErrorMessage(null);

    const dataService = await SDK.getService<IExtensionDataService>(
      CommonServiceIds.ExtensionDataService
    );
    const dataManager = await dataService.getExtensionDataManager(
      "QAZent.pr-assistant-extension",
      await SDK.getAccessToken()
    );

    // Ensure collection exists
    await ensureCollectionExists(dataManager);

    // Now safe to read
    const document = await dataManager.getDocument("ai-contexts", repoId);

    setContextText((document as AIContextDocument)?.contextText ?? "");
  } catch (err: any) {
    const msg = String(err);

    if (msg.includes("DocumentNotFound")) {
      // Repo context not created yet
      setContextText("");
    } else {
      setErrorMessage("Failed to load context: " + msg);
    }
  } finally {
    setIsLoading(false);
  }
};


      const handleRepoChange = async (_event: any, data: any) => {
      const newRepoId = data.optionValue || 'project-default';
      setSelectedRepoId(newRepoId);
      await loadContext(newRepoId);
    };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      setErrorMessage(null);
      setSuccessMessage(null);

      const dataService = await SDK.getService<IExtensionDataService>(
        CommonServiceIds.ExtensionDataService
      );
      const dataManager = await dataService.getExtensionDataManager(
        'QAZent.pr-assistant-extension',
        await SDK.getAccessToken()
      );

      const user = SDK.getUser();
      const now = new Date().toISOString();

      let document: AIContextDocument;

      if (selectedRepoId === 'project-default') {
        document = {
          id: 'project-default',
          projectId: projectId,
          contextText: contextText,
          updatedAt: now,
          updatedBy: user.displayName
        };
      } else {
        const repo = repositories.find(r => r.id === selectedRepoId);
        if (!repo) {
          throw new Error('Selected repository not found');
        }

        document = {
          id: selectedRepoId,
          repositoryId: selectedRepoId,
          repositoryName: repo.name,
          projectId: projectId,
          contextText: contextText,
          updatedAt: now,
          updatedBy: user.displayName
        };
      }

      await dataManager.setDocument('ai-contexts', document);

      setSuccessMessage('Context saved successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setErrorMessage('Failed to save context: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = () => {
    setContextText('');
  };

  return (
    <FluentProvider theme={webLightTheme}>
          <div style={{ 
          padding: '24px', 
          display: 'flex', 
          gap: '24px',
          alignItems: 'flex-start'
        }}>
        <div style={{ flex: 1, minWidth: 0 }}></div>
        <h1 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '8px' }}>
          QAZent AI Assistant - Custom Context Settings
        </h1>
        <p style={{ color: '#605e5c', marginBottom: '24px' }}>
          Configure custom context that will be provided to the AI assistant when generating test cases.
          Set a project-wide default or customize context for specific repositories.
        </p>

        {errorMessage && (
          <div style={{
            backgroundColor: '#fde7e9',
            border: '1px solid #e81123',
            color: '#e81123',
            padding: '12px',
            marginBottom: '16px',
            borderRadius: '4px'
          }}>
            {errorMessage}
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

        <div style={{ marginBottom: '20px' }}>
          <Field label="Repository">
            <Combobox
              placeholder={isLoading && repositories.length === 0 ? "Loading repositories..." : "Select repository"}
              value={selectedRepoId}

              onOptionSelect={handleRepoChange}
              disabled={isLoading}
            >
              <Option value="project-default">
                Project Default (applies to all repos)
              </Option>

              {repositories.map(repo => (
                <Option key={repo.id} value={repo.id}>
                  {repo.name}
                </Option>
              ))}
            </Combobox>
          </Field>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <Field 
            label="Custom Context" 
            hint="This context will be provided to the AI for all prompts in the selected repository"
          >
            <Textarea
              rows={12}
              value={contextText}
              onChange={(_e, data) => setContextText(data.value)}
              disabled={isLoading}
              placeholder="Enter custom context for the AI assistant..."
              style={{ width: '100%' }}
            />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
          <Button
            appearance="primary"
            disabled={isSaving || isLoading}
            onClick={handleSave}
          >
            {isSaving ? 'Saving...' : 'Save Context'}
          </Button>
          <Button
            appearance="subtle"
            disabled={isSaving || isLoading}
            onClick={handleClear}
          >
            Clear
          </Button>
        </div>

        <div style={{
          backgroundColor: '#f3f2f1',
          border: '1px solid #edebe9',
          padding: '16px',
          borderRadius: '4px',
          color: '#323130'
        }}>
    <div></div>
    </div>

        <div style={{
      width: '320px',
      backgroundColor: '#f3f2f1',
      border: '1px solid #edebe9',
      padding: '16px',
      borderRadius: '4px',
      color: '#323130',
      position: 'sticky',
      top: '24px'
}}>

  </div>
  <h3 style={{ marginTop: 0, fontSize: '16px', fontWeight: 600 }}>
    Custom Context Guidelines
  </h3>

  <p style={{ marginBottom: '12px' }}>
    The custom context helps the AI understand your project's conventions, 
    domain knowledge, and testing expectations.
  </p>

  <strong>Recommended length:</strong>
  <ul style={{ marginTop: '6px', marginBottom: '12px' }}>
    <li>200–1,500 words</li>
    <li>Up to ~10,000 characters</li>
    <li>Short, focused, high‑signal information</li>
  </ul>

  <strong>Good things to include:</strong>
  <ul style={{ marginTop: '6px', marginBottom: '12px' }}>
    <li>Tech stack</li>
    <li>Information about the project's domain or business context</li>
    <li>Testing preferences</li>
    <li>Core features of the application</li>
    <li>The application's platform (web, mobile, desktop, etc.)</li>
    <li>Frameworks or tools used for testing (Ranorex, Selenium, etc.)</li>
  </ul>

  <strong>Avoid including:</strong>
  <ul style={{ marginTop: '6px', marginBottom: '12px' }}>
    <li>Large code samples</li>
    <li>Full architecture docs</li>
    <li>Entire wiki pages</li>
    <li>Meeting notes or requirements dumps</li>
  </ul>

  <strong>Example:</strong>
  <p style={{ fontStyle: 'italic', marginTop: '6px' }}>
    “Our project is a legacy .NET desktop application with a lot of business logic in stored procedures, we prefer manual testing and so on....  "
  </p>
</div>
    </FluentProvider>
  );
};
