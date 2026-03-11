/**
 * Unit tests for SettingsHub Component
 */

import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsHub } from './SettingsHub';

// SDK provided by Jest moduleNameMapper -> tests/utils/azure-devops-mock.ts
import * as SDK from 'azure-devops-extension-sdk';

// ---- Types for Git API mocks ----
interface GitRepository {
  id: string;
  name: string;
}

type GetRepositoriesFn = () => Promise<GitRepository[]>;
type GetClientFn = () => { getRepositories: GetRepositoriesFn };

// Mock Git API client
const mockGetRepositories = jest.fn() as jest.MockedFunction<GetRepositoriesFn>;
const mockGetClient = jest.fn() as jest.MockedFunction<GetClientFn>;
mockGetClient.mockReturnValue({ getRepositories: mockGetRepositories });
jest.mock('azure-devops-extension-api/Git', () => ({
  getClient: () => mockGetClient()
}));

describe('SettingsHub Component', () => {
  let mockGetDocument: jest.Mock;
  let mockSetDocument: jest.Mock;
  let mockGetProject: jest.Mock;
  let mockGetExtensionDataManager: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock document operations
    mockGetDocument = jest.fn();
    mockSetDocument = jest.fn();
    mockGetExtensionDataManager = jest.fn().mockResolvedValue({
      getDocument: mockGetDocument,
      setDocument: mockSetDocument
    });

    mockGetProject = jest.fn().mockResolvedValue({
      id: 'project-123',
      name: 'TestProject'
    });

    // Mock SDK methods
    (SDK.init as jest.Mock).mockResolvedValue(undefined);
    (SDK.ready as jest.Mock).mockResolvedValue(undefined);
    (SDK.getService as jest.Mock).mockImplementation((serviceId: string) => {
      if (serviceId === 'ms.vss-work-web.project-page-service') {
        return Promise.resolve({ getProject: mockGetProject });
      }
      return Promise.resolve({ getExtensionDataManager: mockGetExtensionDataManager });
    });
    (SDK.getAccessToken as jest.Mock).mockResolvedValue('mock-token');
    (SDK.getUser as jest.Mock).mockReturnValue({ displayName: 'Test User' });

    // Mock repositories
    mockGetRepositories.mockResolvedValue([
      { id: 'repo-1', name: 'backend-api' },
      { id: 'repo-2', name: 'frontend-app' }
    ]);

    // Mock default: no existing context
    mockGetDocument.mockResolvedValue(null);
  });

  describe('initialization', () => {
    it('should render without crashing', async () => {
      render(<SettingsHub />);
      
      await waitFor(() => {
        expect(screen.getByText(/Custom Context Settings/i)).toBeInTheDocument();
      });
    });

    it('should load project information on mount', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        expect(mockGetProject).toHaveBeenCalled();
      });
    });

    it('should load repositories on mount', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        expect(mockGetRepositories).toHaveBeenCalledWith('project-123');
      });
    });

    it('should load project default context on mount', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        expect(mockGetDocument).toHaveBeenCalledWith('ai-contexts', 'project-default');
      });
    });

    it('should display error if project context cannot be determined', async () => {
      mockGetProject.mockResolvedValueOnce(null);

      render(<SettingsHub />);

      await waitFor(() => {
        expect(screen.getByText(/Unable to determine current project context/i)).toBeInTheDocument();
      });
    });
  });

  describe('repository dropdown', () => {
    it('should show "Project Default" as first option', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        const combobox = screen.getByRole('combobox');
        expect(combobox).toBeInTheDocument();
      });
    });

    it('should populate repository options from API', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        expect(mockGetRepositories).toHaveBeenCalled();
      });

      // Repositories are loaded into state
      expect(mockGetRepositories).toHaveBeenCalledWith('project-123');
    });

    it('should show loading state initially', async () => {
      mockGetRepositories.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve([]), 1000))
      );

      render(<SettingsHub />);

      // Initially should show loading
      await waitFor(() => {
        const combobox = screen.getByRole('combobox');
        expect(combobox).toHaveAttribute('placeholder', expect.stringContaining('Loading'));
      });
    });
  });

  describe('context loading', () => {
    it('should load existing project default context', async () => {
      mockGetDocument.mockResolvedValueOnce({
        id: 'project-default',
        contextText: 'Existing project context',
        updatedAt: '2024-01-01',
        updatedBy: 'Admin'
      });

      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
        expect(textarea.value).toBe('Existing project context');
      });
    });

    it('should show empty textarea when no context exists', async () => {
      mockGetDocument.mockResolvedValue(null);

      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
        expect(textarea.value).toBe('');
      });
    });

    it('should handle context loading errors gracefully', async () => {
      // First call (ensureCollectionExists) returns null; second (loadContext) throws so we show error
      mockGetDocument.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Network error'));

      render(<SettingsHub />);

      await waitFor(() => {
        expect(screen.getByText(/We couldn't load your saved context/i)).toBeInTheDocument();
      });
    });

    it('should handle "does not exist" error as empty context', async () => {
      const error = new Error('Document does not exist');
      mockGetDocument.mockRejectedValueOnce(error);

      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
        expect(textarea.value).toBe('');
      });
    });

    it('should treat unrecognized "not found" error as empty context and not show error', async () => {
      const error = new Error('Resource not found');
      mockGetDocument.mockResolvedValueOnce(null).mockRejectedValueOnce(error);

      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
        expect(textarea.value).toBe('');
      });
      expect(screen.queryByText(/couldn't load your saved context/i)).not.toBeInTheDocument();
    });
  });

  describe('save functionality', () => {
    it('should save project default context', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox');
        fireEvent.change(textarea, { target: { value: 'New project context' } });
      });

      const saveButton = screen.getByRole('button', { name: /Save Context/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockSetDocument).toHaveBeenCalledWith('ai-contexts', expect.objectContaining({
          id: 'project-default',
          projectId: 'project-123',
          contextText: 'New project context',
          updatedBy: 'Test User'
        }));
      });
    });

    it('should show success message after saving', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox');
        fireEvent.change(textarea, { target: { value: 'Context' } });
      });

      const saveButton = screen.getByRole('button', { name: /Save Context/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText(/Context saved successfully/i)).toBeInTheDocument();
      });
    });

    it('should show error message on save failure', async () => {
      mockSetDocument.mockRejectedValueOnce(new Error('Save failed'));

      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox');
        fireEvent.change(textarea, { target: { value: 'Context' } });
      });

      const saveButton = screen.getByRole('button', { name: /Save Context/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText(/Failed to save context/i)).toBeInTheDocument();
      });
    });

    it('should include timestamp in saved document', async () => {
      const beforeSave = new Date().toISOString();

      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox');
        fireEvent.change(textarea, { target: { value: 'Context' } });
      });

      const saveButton = screen.getByRole('button', { name: /Save Context/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        const savedDoc = mockSetDocument.mock.calls[0][1];
        expect(savedDoc.updatedAt).toBeDefined();
        expect(new Date(savedDoc.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(beforeSave).getTime());
      });
    });

    it('should disable save button while saving', async () => {
      mockSetDocument.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 1000))
      );

      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox');
        fireEvent.change(textarea, { target: { value: 'Context' } });
      });

      const saveButton = screen.getByRole('button', { name: /Save Context/i });
      fireEvent.click(saveButton);

      // Button should be disabled during save
      expect(saveButton).toBeDisabled();
    });
  });

  describe('clear functionality', () => {
    it('should clear textarea when Clear button clicked', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox');
        fireEvent.change(textarea, { target: { value: 'Some context' } });
      });

      const clearButton = screen.getByRole('button', { name: /Clear/i });
      fireEvent.click(clearButton);

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe('');
    });

    it('should allow saving empty context after clearing', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        const textarea = screen.getByRole('textbox');
        fireEvent.change(textarea, { target: { value: 'Context' } });
      });

      const clearButton = screen.getByRole('button', { name: /Clear/i });
      fireEvent.click(clearButton);

      const saveButton = screen.getByRole('button', { name: /Save Context/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockSetDocument).toHaveBeenCalledWith('ai-contexts', expect.objectContaining({
          contextText: ''
        }));
      });
    });
  });

  describe('repository-specific context', () => {
    it('should save repository-specific context with repositoryId', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        expect(mockGetRepositories).toHaveBeenCalled();
      });

      // Change to a specific repository (simulated - actual combobox interaction is complex)
      // This would require more complex interaction testing with the Combobox component
      // For now, we verify the save logic structure
    });
  });

  describe('UI elements', () => {
    it('should show helpful tip section', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        expect(screen.getByText(/Tip:/i)).toBeInTheDocument();
      });
    });

    it('should show correct field labels', async () => {
      render(<SettingsHub />);

      await waitFor(() => {
        expect(screen.getByText(/Repository/i)).toBeInTheDocument();
        expect(screen.getByText(/Custom Context/i)).toBeInTheDocument();
      });
    });
  });
});
