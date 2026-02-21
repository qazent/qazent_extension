/**
 * Frontend-specific TypeScript types for Azure DevOps Extension
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
  purpose: string;
  scopeOfChange: string;
  preconditions: string[];
  testSteps: string[];
  expectedResults: string[];
  negativeScenarios: string[];
  edgeCases: string[];
  regressionAreas: string[];
  dataRequirements: string[];
  automationNotes: string;
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
