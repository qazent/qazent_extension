/**
 * Configuration Service
 * Manages extension configuration and validation
 *
 * SECURITY: Webhook endpoint is fixed and non-editable.
 * Users cannot override or customize the webhook URL.
 */

// Fixed webhook endpoint - this is the only valid endpoint for all webhook subscriptions
export const WEBHOOK_ENDPOINT = 'https://api.qazent.com/webhook';

/**
 * Validate subscription parameters before creating webhooks
 * @returns Object with valid flag and optional error message
 */
export function validateSubscriptionParams(params: {
  projectId?: string;
  eventType?: string;
}): { valid: boolean; error?: string } {
  // Validate project ID
  if (!params.projectId || params.projectId.trim() === '') {
    return { valid: false, error: 'Project ID is required' };
  }

  // Validate event type
  const validEventTypes = ['git.pullrequest.created', 'git.pullrequest.updated'];
  if (!params.eventType || !validEventTypes.includes(params.eventType)) {
    return { valid: false, error: 'Invalid event type. Must be "git.pullrequest.created" or "git.pullrequest.updated"' };
  }

  return { valid: true };
}

/**
 * Get the fixed webhook endpoint
 * This is the only valid endpoint for webhook subscriptions.
 * @returns The webhook endpoint URL
 */
export function getWebhookEndpoint(): string {
  return WEBHOOK_ENDPOINT;
}
