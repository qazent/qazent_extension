/**
 * FRONTEND-specific TypeScript types for Azure DevOps Extension
 */

/**
 * PR data displayed in the UI
 */
export interface PRData {
  prTitle: string;
  prId: number;
  author: string;
  filesChanged: number;
}
/**
 * AI-generated test case structure (copied from backend types.ts)
 */
export interface GeneratedTestCase {
  title: string;
  htmlDescription: string;
  purpose?: string;
  scopeOfChange?: string;
  preconditions?: string[];
  testSteps?: string[];
  expectedResults?: string[];
  negativeScenarios?: string[];
  edgeCases?: string[];
  regressionAreas?: string[];
  dataRequirements?: string[];
  automationNotes?: string;
}

/**
 * Work item creation response
 */
export interface WorkItemResponse {
  workItemId: number;
  workItemUrl: string;
}

/**
 * Backend API error response
 */
export interface ApiErrorResponse {
  error: string;
  details?: string;
  message?: string;
}

/**
 * AI context document stored in Extension Data Service
 */
export interface AIContextDocument {
  id: string;
  projectId?: string;
  repositoryId?: string;
  repositoryName?: string;
  contextText: string;
  updatedAt: string;
  updatedBy: string;
}
/**
 * Interface for extension contributions (e.g., menu items, panels)
 */
export interface IContribution {
  id: string;
  type: string;
  properties?: Record<string, any>;
}

export interface IExtensionContextWithContributions {
  contributions?: IContribution[];
}
