/**
 * Webhook Service
 * Manages Azure DevOps Service Hooks (webhooks) for automatic test generation
 */

import * as SDK from "azure-devops-extension-sdk";
import { CommonServiceIds, IProjectPageService } from "azure-devops-extension-api";

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

/**
 * Create a webhook subscription for pull request events
 * @param projectId Azure DevOps project GUID
 * @param eventType Either 'git.pullrequest.created' or 'git.pullrequest.updated'
 * @param webhookUrl Backend URL (function will append /webhook)
 * @returns Created webhook subscription
 */
export async function createWebhookSubscription(
  projectId: string,
  eventType: 'git.pullrequest.created' | 'git.pullrequest.updated',
  webhookUrl: string
): Promise<WebhookSubscription> {
  try {
    // Get organization URL and project name
    const host = SDK.getHost();
    const orgUrl = host.name; // e.g., https://dev.azure.com/myorg

    const projectService = await SDK.getService<IProjectPageService>(
      CommonServiceIds.ProjectPageService
    );
    const project = await projectService.getProject();
    if (!project) {
      throw new Error("Unable to determine current project");
    }

    // Get auth token
    const token = await SDK.getAccessToken();

    // Construct full webhook URL
    const fullWebhookUrl = webhookUrl.endsWith('/')
      ? `${webhookUrl}webhook`
      : `${webhookUrl}/webhook`;

    // Request body structure for Azure DevOps Service Hooks API
    const requestBody = {
      publisherId: "tfs",
      eventType: eventType,
      resourceVersion: "1.0",
      consumerId: "webHooks",
      consumerActionId: "httpRequest",
      publisherInputs: {
        projectId: projectId,
        repository: "" // Empty = all repos
      },
      consumerInputs: {
        url: fullWebhookUrl
      }
    };

    // Make POST request to create webhook
    const response = await fetch(
      `${orgUrl}/${project.name}/_apis/hooks/subscriptions?api-version=7.1`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(requestBody)
      }
    );

    // Handle response
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("Permission denied. You need Project Administrator or Service Hook Administrator role.");
      }
      if (response.status === 401) {
        throw new Error("Authentication failed. Please refresh and try again.");
      }
      throw new Error(`Failed to create webhook: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data as WebhookSubscription;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message);
  }
}

/**
 * List all webhook subscriptions, optionally filtered by URL
 * @param filterByUrl If provided, only return subscriptions where URL contains this string
 * @returns Array of webhook subscriptions
 */
export async function listWebhookSubscriptions(
  filterByUrl?: string
): Promise<WebhookSubscription[]> {
  try {
    // Get organization URL
    const host = SDK.getHost();
    const orgUrl = host.name;

    // Get auth token
    const token = await SDK.getAccessToken();

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
      if (response.status === 403) {
        throw new Error("Permission denied to list webhooks.");
      }
      if (response.status === 401) {
        throw new Error("Authentication failed. Please refresh and try again.");
      }
      throw new Error(`Failed to list webhooks: HTTP ${response.status}`);
    }

    const data = await response.json();
    let subscriptions = (data.value || []) as WebhookSubscription[];

    // Filter by URL if provided
    if (filterByUrl) {
      subscriptions = subscriptions.filter((sub) => {
        const subUrl = sub.consumerInputs?.url || sub.url || "";
        return subUrl.includes(filterByUrl);
      });
    }

    return subscriptions;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message);
  }
}

/**
 * Delete a webhook subscription by ID
 * @param subscriptionId The unique ID of the subscription to delete
 */
export async function deleteWebhookSubscription(
  subscriptionId: string
): Promise<void> {
  try {
    // Get organization URL
    const host = SDK.getHost();
    const orgUrl = host.name;

    // Get auth token
    const token = await SDK.getAccessToken();

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
      if (response.status === 404) {
        throw new Error("Webhook not found. It may have been already deleted.");
      }
      if (response.status === 403) {
        throw new Error("Permission denied to delete webhook.");
      }
      throw new Error(`Failed to delete webhook: HTTP ${response.status}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message);
  }
}

/**
 * Enable auto-generation by creating both PR created and updated webhooks
 * @param projectId Azure DevOps project GUID
 * @param webhookUrl Backend URL
 * @returns Object with arrays of created subscription IDs and skipped flag
 */
export async function enableAutoGeneration(
  projectId: string,
  webhookUrl: string
): Promise<{ created: string[]; updated: string[]; skipped: boolean }> {
  try {
    // First, check if webhooks already exist
    const existingWebhooks = await listWebhookSubscriptions(webhookUrl);

    const hasCreated = existingWebhooks.some(
      (w) => w.eventType === 'git.pullrequest.created'
    );
    const hasUpdated = existingWebhooks.some(
      (w) => w.eventType === 'git.pullrequest.updated'
    );

    // If both already exist, skip creation
    if (hasCreated && hasUpdated) {
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
        'git.pullrequest.created',
        webhookUrl
      );
      createdIds.push(createdWebhook.id);
    }

    // Create "pull request updated" webhook if it doesn't exist
    if (!hasUpdated) {
      const updatedWebhook = await createWebhookSubscription(
        projectId,
        'git.pullrequest.updated',
        webhookUrl
      );
      updatedIds.push(updatedWebhook.id);
    }

    return {
      created: createdIds,
      updated: updatedIds,
      skipped: false
    };
  } catch (err) {
    // Let errors propagate
    throw err;
  }
}

/**
 * Check if auto-generation is already enabled for this project
 * @param _projectId Azure DevOps project GUID (reserved for future filtering)
 * @param webhookUrl Backend URL to check for
 * @returns true if both webhooks exist, false otherwise
 */
export async function isAutoGenerationEnabled(
  _projectId: string,
  webhookUrl: string
): Promise<boolean> {
  try {
    const existingWebhooks = await listWebhookSubscriptions(webhookUrl);

    const hasCreated = existingWebhooks.some(
      (w) => w.eventType === 'git.pullrequest.created'
    );
    const hasUpdated = existingWebhooks.some(
      (w) => w.eventType === 'git.pullrequest.updated'
    );

    return hasCreated && hasUpdated;
  } catch (err) {
    // On error, assume not enabled
    console.error("Error checking auto-generation status:", err);
    return false;
  }
}
