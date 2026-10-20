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
  token: string;
  orgUrl: string;
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
  sourceCommitId?: string;
  targetCommitId?: string;
  author: string;
  authorEmail: string;
  createDate: Date;
  branchName: string;

}

/**
 * Single PR commit, normalized from Azure DevOps `GitCommitRef`.
 * Only fields needed for prompt rendering are included.
 */
export interface PRCommit {
  commitId: string;
  shortSha: string;
  author: string;
  message: string;
  committedDate?: string;
}

/**
 * Code diff from Azure DevOps API
 */
export interface CodeDiff {
  changes: DiffChange[];
  totalChanges: number;
  filteredChanges?: number;
  truncatedChanges?: number;
  sourceCommitId?: string;  // Optional for fallback scenarios
  targetCommitId?: string;   // Optional for fallback scenarios
  latestIterationId?: number;
  firstComparingIteration?: number;
}

export type DiffChangeType = 'add' | 'edit' | 'delete';

/**
 * Individual file change in diff
 */
export interface DiffChange {
  filePath: string;
  changeType: DiffChangeType;
  linesAdded: number;
  linesDeleted: number;
  diffContent: string;
  changeTrackingId?: number;
  oldLineCount?: number;
  newLineCount?: number;
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
 * AI-generated Task work item output structure
 */
export interface TaskWorkItemOutput {
  title: string;
  htmlDescription: string;
}

/**
 * Request payload for protected PR queue enqueue endpoint.
 */
export interface QueuePRRequest {
  prId: number;
  repo: string;
  filesChanged: string[];
}

/**
 * Redis-backed PR processing job payload.
 */
export interface QueuedPRJob {
  jobId: string;
  prId: number;
  repo: string;
  filesChanged: string[];
  timestamp: number;
  attempt: number;
  organizationUrl: string;
  requestedBy: {
    id: string;
    displayName: string;
  };
}

export interface QueuedJobAuth {
  accessToken: string;
  organizationUrl: string;
  tokenSource: 'sdk';
  storedAt: number;
  expiresAt?: number;
  requestedBy: {
    id: string;
    displayName: string;
  };
}

export interface StoredJobResult {
  jobId: string;
  prId: number;
  title: string;
  htmlDescription: string;
  commentContent: string;
  createdAt: number;
}

export interface StoredJobError {
  jobId: string;
  prId: number;
  attempt: number;
  failedAt: number;
  message: string;
  name: string;
  stack?: string;
}

export interface WorkerLockState {
  ownerId: string;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface WorkerLogContext {
  jobId: string;
  stage: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  timestamp: string;
  [key: string]: unknown;
}

export interface QueueJobEnqueueResponse {
  status: 'queued';
  jobId: string;
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
