/**
 * Webhook Service
 * Manages Azure DevOps Service Hooks (webhooks) for automatic test generation
 *
 * Implements programmatic subscription creation following Microsoft's official guidance:
 * https://learn.microsoft.com/en-us/azure/devops/service-hooks/create-subscription?view=azure-devops
 */

import * as SDK from "azure-devops-extension-sdk";
import { CommonServiceIds, IProjectPageService } from "azure-devops-extension-api";
import { WEBHOOK_ENDPOINT, validateSubscriptionParams } from './configService';

// Error classes for structured error handling
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ServerError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'ServerError';
  }
}

export interface WebhookSubscription {
  id: string;
  url: string;
  eventType: string;
  createdDate: string;
  publisherInputs: {
    projectId?: string;
    repository?: string;
  };
  consumerInputs?: {
    url?: string;
  };
}

// Retry configuration for transient failures
const RETRY_CONFIG = {
  maxAttempts: 3,
  initialBackoffMs: 1000,
  maxBackoffMs: 5000
};

/**
 * Sleep helper for exponential backoff retry logic
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attemptNumber: number): number {
  const exponentialDelay = RETRY_CONFIG.initialBackoffMs * Math.pow(2, attemptNumber - 1);
  return Math.min(exponentialDelay, RETRY_CONFIG.maxBackoffMs);
}

/**
 * Create a webhook subscription for pull request events
 * Implements Microsoft's programmatic service hook subscription creation.
 *
 * @param projectId Azure DevOps project GUID
 * @param eventType Either 'git.pullrequest.created' or 'git.pullrequest.updated'
 * @returns Created webhook subscription
 * @throws ValidationError, AuthError, NetworkError, or ServerError
 */
export async function createWebhookSubscription(
  projectId: string,
  eventType: 'git.pullrequest.created' | 'git.pullrequest.updated'
): Promise<WebhookSubscription> {
  // Validate input parameters
  const validation = validateSubscriptionParams({ projectId, eventType });
  if (!validation.valid) {
    throw new ValidationError(validation.error || 'Invalid subscription parameters');
  }

  let lastError: Error | null = null;

  // Retry loop with exponential backoff
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      return await createSubscriptionAttempt(projectId, eventType);
    } catch (err) {
      lastError = err as Error;

      // Don't retry validation or auth errors
      if (err instanceof ValidationError || err instanceof AuthError) {
        throw err;
      }

      // Retry transient errors (network, 5xx) with backoff
      if (attempt < RETRY_CONFIG.maxAttempts) {
        const backoffMs = getBackoffDelay(attempt);
        console.warn(
          `[Webhook] Attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Retrying in ${backoffMs}ms...`
        );
        await sleep(backoffMs);
      }
    }
  }

  // All attempts exhausted
  throw lastError || new Error('Failed to create webhook subscription after multiple attempts');
}

/**
 * Single attempt to create webhook subscription
 * Contains the actual API call logic
 */
async function createSubscriptionAttempt(
  projectId: string,
  eventType: 'git.pullrequest.created' | 'git.pullrequest.updated'
): Promise<WebhookSubscription> {
  try {
    // Get organization URL and project info
    const host = SDK.getHost();
    const orgUrl = host.name; // e.g., https://dev.azure.com/myorg

    const projectService = await SDK.getService<IProjectPageService>(
      CommonServiceIds.ProjectPageService
    );
    const project = await projectService.getProject();
    if (!project) {
      throw new ValidationError("Unable to determine current project context");
    }

    // Get auth token
    const token = await SDK.getAccessToken();
    if (!token) {
      throw new AuthError("Unable to obtain authentication token");
    }

    // Build request body per Microsoft's API specification
    // https://learn.microsoft.com/en-us/azure/devops/service-hooks/services/webhooks?view=azure-devops
    const requestBody = {
      publisherId: "tfs",
      eventType: eventType,
      resourceVersion: "1.0",
      consumerId: "webHooks",
      consumerActionId: "httpRequest",
      publisherInputs: {
        projectId: projectId,
        repository: "" // Empty string = all repositories
      },
      consumerInputs: {
        url: WEBHOOK_ENDPOINT  // Use fixed endpoint
      }
    };

    // Make POST request to Azure DevOps Service Hooks API
    const response = await fetch(
      `${orgUrl}/${project.name}/_apis/hooks/subscriptions?api-version=7.1`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
          "Accept": "application/json"
        },
        body: JSON.stringify(requestBody)
      }
    );

    // Map HTTP status codes to structured errors
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');

      if (response.status === 401) {
        throw new AuthError("Authentication failed. Your session may have expired. Please refresh and try again.");
      }

      if (response.status === 403) {
        throw new AuthError("Permission denied. You need Project Administrator or Service Hook Administrator role to create webhooks.");
      }

      if (response.status === 400) {
        throw new ValidationError(`Invalid request: ${errorText}`);
      }

      if (response.status >= 500) {
        throw new ServerError(
          `Azure DevOps service error (${response.status}). Please try again in a moment.`,
          response.status
        );
      }

      throw new ServerError(
        `Failed to create webhook subscription (HTTP ${response.status}): ${errorText}`,
        response.status
      );
    }

    const data = await response.json();
    const subscription = data as WebhookSubscription;

    console.log(`[Webhook] Successfully created subscription for event type: ${eventType}`);
    return subscription;
  } catch (err) {
    // Re-throw already-structured errors
    if (err instanceof ValidationError || err instanceof AuthError ||
        err instanceof NetworkError || err instanceof ServerError) {
      throw err;
    }

    // Network errors
    if (err instanceof TypeError) {
      throw new NetworkError(`Network error: ${err.message}`);
    }

    // Generic fallback
    throw new NetworkError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * List all webhook subscriptions
 * @returns Array of webhook subscriptions
 * @throws AuthError, NetworkError, or ServerError
 */
export async function listWebhookSubscriptions(): Promise<WebhookSubscription[]> {
  try {
    // Get organization URL
    const host = SDK.getHost();
    const orgUrl = host.name;

    // Get auth token
    const token = await SDK.getAccessToken();
    if (!token) {
      throw new AuthError("Unable to obtain authentication token");
    }

    // Make GET request to list webhooks
    const response = await fetch(
      `${orgUrl}/_apis/hooks/subscriptions?api-version=7.1`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json"
        }
      }
    );

    // Handle response
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');

      if (response.status === 401) {
        throw new AuthError("Authentication failed. Please refresh and try again.");
      }

      if (response.status === 403) {
        throw new AuthError("Permission denied. You don't have permission to view webhooks.");
      }

      throw new ServerError(
        `Failed to list webhooks (HTTP ${response.status}): ${errorText}`,
        response.status
      );
    }

    const data = await response.json();
    const subscriptions = (data.value || []) as WebhookSubscription[];

    // Filter to only our fixed endpoint webhooks
    const filtered = subscriptions.filter((sub) => {
      const subUrl = sub.consumerInputs?.url || sub.url || "";
      return subUrl === WEBHOOK_ENDPOINT;
    });

    return filtered;
  } catch (err) {
    // Re-throw already-structured errors
    if (err instanceof AuthError || err instanceof NetworkError || err instanceof ServerError) {
      throw err;
    }

    // Network errors
    if (err instanceof TypeError) {
      throw new NetworkError(`Network error: ${err.message}`);
    }

    // Generic fallback
    throw new NetworkError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Delete a webhook subscription by ID
 * @param subscriptionId The unique ID of the subscription to delete
 * @throws AuthError, NetworkError, or ServerError
 */
export async function deleteWebhookSubscription(
  subscriptionId: string
): Promise<void> {
  if (!subscriptionId || subscriptionId.trim() === '') {
    throw new ValidationError("Subscription ID is required");
  }

  try {
    // Get organization URL
    const host = SDK.getHost();
    const orgUrl = host.name;

    // Get auth token
    const token = await SDK.getAccessToken();
    if (!token) {
      throw new AuthError("Unable to obtain authentication token");
    }

    // Make DELETE request
    const response = await fetch(
      `${orgUrl}/_apis/hooks/subscriptions/${subscriptionId}?api-version=7.1`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json"
        }
      }
    );

    // Handle response
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');

      if (response.status === 401) {
        throw new AuthError("Authentication failed. Please refresh and try again.");
      }

      if (response.status === 403) {
        throw new AuthError("Permission denied. You can't delete this webhook.");
      }

      if (response.status === 404) {
        throw new ValidationError("Webhook not found. It may have already been deleted.");
      }

      throw new ServerError(
        `Failed to delete webhook (HTTP ${response.status}): ${errorText}`,
        response.status
      );
    }

    console.log(`[Webhook] Successfully deleted subscription: ${subscriptionId}`);
  } catch (err) {
    // Re-throw already-structured errors
    if (err instanceof ValidationError || err instanceof AuthError ||
        err instanceof NetworkError || err instanceof ServerError) {
      throw err;
    }

    // Network errors
    if (err instanceof TypeError) {
      throw new NetworkError(`Network error: ${err.message}`);
    }

    // Generic fallback
    throw new NetworkError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Enable auto-generation by creating both PR created and updated webhooks
 * @param projectId Azure DevOps project GUID
 * @returns Object with arrays of created subscription IDs and skipped flag
 * @throws ValidationError, AuthError, NetworkError, or ServerError
 */
export async function enableAutoGeneration(
  projectId: string
): Promise<{ created: string[]; updated: string[]; skipped: boolean }> {
  if (!projectId || projectId.trim() === '') {
    throw new ValidationError("Project ID is required");
  }

  try {
    // First, check if webhooks already exist for our fixed endpoint
    const existingWebhooks = await listWebhookSubscriptions();

    const hasCreated = existingWebhooks.some(
      (w) => w.eventType === 'git.pullrequest.created' && w.publisherInputs?.projectId === projectId
    );
    const hasUpdated = existingWebhooks.some(
      (w) => w.eventType === 'git.pullrequest.updated' && w.publisherInputs?.projectId === projectId
    );

    // If both already exist for this project, skip creation
    if (hasCreated && hasUpdated) {
      console.log("[Webhook] Both PR created and updated webhooks already exist for this project");
      return {
        created: [],
        updated: [],
        skipped: true
      };
    }

    const createdIds: string[] = [];
    const updatedIds: string[] = [];

    // Create "pull request created" webhook if it doesn't exist
    if (!hasCreated) {
      const createdWebhook = await createWebhookSubscription(
        projectId,
        'git.pullrequest.created'
      );
      createdIds.push(createdWebhook.id);
      console.log("[Webhook] Created PR created subscription:", createdWebhook.id);
    }

    // Create "pull request updated" webhook if it doesn't exist
    if (!hasUpdated) {
      const updatedWebhook = await createWebhookSubscription(
        projectId,
        'git.pullrequest.updated'
      );
      updatedIds.push(updatedWebhook.id);
      console.log("[Webhook] Created PR updated subscription:", updatedWebhook.id);
    }

    return {
      created: createdIds,
      updated: updatedIds,
      skipped: false
    };
  } catch (err) {
    // Let errors propagate for caller to handle
    throw err;
  }
}

/**
 * Check if auto-generation is already enabled for this project
 * @param projectId Azure DevOps project GUID
 * @returns true if both webhooks exist for this project, false otherwise
 */
export async function isAutoGenerationEnabled(
  projectId: string
): Promise<boolean> {
  if (!projectId || projectId.trim() === '') {
    console.warn("[Webhook] Project ID required to check auto-generation status");
    return false;
  }

  try {
    const existingWebhooks = await listWebhookSubscriptions();

    const hasCreated = existingWebhooks.some(
      (w) => w.eventType === 'git.pullrequest.created' && w.publisherInputs?.projectId === projectId
    );
    const hasUpdated = existingWebhooks.some(
      (w) => w.eventType === 'git.pullrequest.updated' && w.publisherInputs?.projectId === projectId
    );

    return hasCreated && hasUpdated;
  } catch (err) {
    // On error, assume not enabled and log for debugging
    console.error("[Webhook] Error checking auto-generation status:", err);
    return false;
  }
}
