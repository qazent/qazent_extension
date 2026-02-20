/**
 * Type definitions for Azure DevOps PR Test Case Generator
 */

/**
 * Webhook payload structure from Azure DevOps
 */
export interface WebhookPayload {
  eventType: string;
  resource: {
    pullRequestId: number;
    title: string;
    description?: string;
    repository: {
      id: string;
      name: string;
      project: {
        name: string;
        id: string;
        
      };
    };
    sourceRefName: string;
    targetRefName: string;
    createdBy: {
      displayName: string;
      uniqueName: string;
    };
  };
}

/**
 * PR metadata extracted from webhook
 */
export interface PRMetadata {
  prId: number;
  title: string;
  description: string;
  repositoryId: string;
  repositoryName: string;
  projectName: string;
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  authorEmail: string;
}

/**
 * Code diff from Azure DevOps API
 */
export interface CodeDiff {
  changes: DiffChange[];
  totalChanges: number;
}

/**
 * Individual file change in diff
 */
export interface DiffChange {
  filePath: string;
  changeType: 'add' | 'edit' | 'delete';
  linesAdded: number;
  linesDeleted: number;
  diffContent: string;
}

/**
 * AI-generated test case structure
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
 * Job queue item
 */
export interface QueueJob {
  id: string;
  payload: WebhookPayload;
  attempt: number;
  maxAttempts: number;
  scheduledFor?: Date;
}

/**
 * Queue status for health checks
 */
export interface QueueStatus {
  pending: number;
  processing: boolean;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: string;
  uptime: number;
  queue: QueueStatus;
  timestamp: string;
}

/**
 * Webhook response
 */
export interface WebhookResponse {
  status: string;
  jobId: string;
}

/**
 * Error response
 */
export interface ErrorResponse {
  error: string;
  details?: string;
  message?: string;
}
