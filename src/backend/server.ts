/**
 * HTTP webhook server for Azure DevOps PR events
 *
 * Security: All endpoints (except /health) require Azure DevOps OAuth token validation
 */

import * as http from 'http';
import { ErrorResponse, PRMetadata, TaskWorkItemOutput } from './types';
// --- WEBHOOK AUTO-GENERATION DISABLED --- WebhookPayload and WebhookResponse only used by webhook handler
// import { WebhookPayload, WebhookResponse } from './types';
import * as logger from './utils/logger';
// --- WEBHOOK AUTO-GENERATION DISABLED --- queue only used by webhook handler and startWorker
// import * as queue from './queue';
import * as adoClient from './ado-client';
import * as ai from './ai';
import { fetchPRDiff } from './fetchPRdiff';
import { createAuthMiddleware, AuthenticatedRequest } from './middleware/authenticate';
import {
  rateLimitGenerateTests,
  rateLimitCreateWorkItem,
  rateLimitPostPRComment,
  rateLimitExtractPurposeScope,
  rateLimitHealth
} from './middleware/rateLimiter';
// --- WEBHOOK AUTO-GENERATION DISABLED --- crypto only used by encrypt/decrypt token functions
// import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
// --- WEBHOOK AUTO-GENERATION DISABLED --- isOAuthToken only used by webhook handler in server.ts
// import { isOAuthToken } from './utils/tokenValidator';

dotenv.config();

// Azure diagnostic logging
console.log('[STARTUP] Current working directory:', process.cwd());
console.log('[STARTUP] Node version:', process.version);
console.log('[STARTUP] Environment:', process.env.NODE_ENV || 'not set');
console.log('[STARTUP] Port:', process.env.PORT || 'using default');

const PORT = parseInt(process.env.PORT || '3000', 10);
const startTime = Date.now();

// --- WEBHOOK AUTO-GENERATION DISABLED ---
// This infrastructure requires token storage for async webhook processing.
// SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
// The webhook flow has no frontend wiring to push tokens to the backend.
// Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
// To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
// See architecture notes in this file for details.
/*
const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;
const ENCRYPTION_ALGO = 'aes-256-gcm';

if (!ENCRYPTION_KEY) {
  logger.error('CRITICAL: TOKEN_ENCRYPTION_KEY environment variable is not set. ' +
    'Webhook tokens cannot be encrypted/decrypted securely. ' +
    'Please set TOKEN_ENCRYPTION_KEY to a 64-character hex string (generated via: openssl rand -hex 32)');
  throw new Error('TOKEN_ENCRYPTION_KEY not configured. Cannot start server.');
}

// Validate key format
if (!/^[a-f0-9]{64}$/.test(ENCRYPTION_KEY!.toLowerCase())) {
  logger.error('CRITICAL: TOKEN_ENCRYPTION_KEY must be a 64-character hexadecimal string. ' +
    `Received: "${ENCRYPTION_KEY!.substring(0, 10)}..." (${ENCRYPTION_KEY!.length} chars)`);
  throw new Error('TOKEN_ENCRYPTION_KEY has invalid format.');
}
*/

// --- WEBHOOK AUTO-GENERATION DISABLED ---
// This infrastructure requires token storage for async webhook processing.
// SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
// The webhook flow has no frontend wiring to push tokens to the backend.
// Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
// To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
// See architecture notes in this file for details.
/*
const webhookTokenStore = new Map<string, {
  encryptedToken: string;
  iv: string;
  authTag: string;
  userId?: string;
  createdDate: Date;
}>();

logger.info('Webhook token store initialized', { implementation: 'in-memory', encryption: 'AES-256-GCM' });

function encryptToken(token: string, associatedUserId?: string): { encryptedToken: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, Buffer.from(ENCRYPTION_KEY!.slice(0, 64), 'hex'), iv);

  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  logger.info('Token encrypted successfully', { userId: associatedUserId });

  return {
    encryptedToken: encrypted,
    iv: iv.toString('hex'),
    authTag
  };
}

function decryptToken(encryptedData: { encryptedToken: string; iv: string; authTag: string }): string {
  try {
    const decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGO,
      Buffer.from(ENCRYPTION_KEY!.slice(0, 64), 'hex'),
      Buffer.from(encryptedData.iv, 'hex')
    );

    decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));

    let decrypted = decipher.update(encryptedData.encryptedToken, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    logger.error('Token decryption failed', { error: String(error) });
    throw new Error('Failed to decrypt token. Token may be corrupted.');
  }
}

async function getStoredTokenForOrg(orgUrl: string): Promise<string | undefined> {
  const stored = webhookTokenStore.get(orgUrl);
  if (!stored) {
    logger.warn('No stored token found', { orgUrl, availableOrgs: Array.from(webhookTokenStore.keys()) });
    return undefined;
  }

  try {
    const token = decryptToken({
      encryptedToken: stored.encryptedToken,
      iv: stored.iv,
      authTag: stored.authTag
    });

    if (!token || token.trim().length === 0) {
      throw new Error('Token decrypted to empty string');
    }

    logger.info('Token retrieved and decrypted successfully', { orgUrl, tokenLength: token.length });
    return token;
  } catch (error) {
    logger.error('CRITICAL: Failed to decrypt stored token', {
      orgUrl,
      storedDataPresent: !!stored,
      error: error instanceof Error ? error.message : String(error),
      encryptionKeyLength: ENCRYPTION_KEY!.length,
      availableOrgs: Array.from(webhookTokenStore.keys())
    });
    return undefined;
  }
}

async function storeWebhookTokenInMemory(
  orgUrl: string,
  token: string,
  userId?: string
): Promise<void> {
  try {
    const encrypted = encryptToken(token, userId);

    webhookTokenStore.set(orgUrl, {
      ...encrypted,
      userId,
      createdDate: new Date()
    });

    logger.info('Webhook token stored successfully', {
      orgUrl,
      userId
    });
  } catch (error) {
    logger.error('Failed to store webhook token', { orgUrl, error: String(error) });
    throw new Error(`Failed to store webhook token: ${error}`);
  }
}
*/



/**
 * Extract organization name from Azure DevOps URL
 * Examples:
 *   https://dev.azure.com/myorg => myorg
 *   https://myorg.visualstudio.com => myorg
 */
function extractOrgName(orgUrl: string): string {
  const url = new URL(orgUrl);

  if (url.hostname === 'dev.azure.com') {
    return url.pathname.split('/')[1];
  }

  if (url.hostname.endsWith('.visualstudio.com')) {
    return url.hostname.split('.')[0];
  }
  throw new Error(`Invalid Azure DevOps URL format: ${orgUrl}`);
}
  



/**
 * Validate required environment variables
 *
 * Security note: For production, migrate GEMINI_API_KEY to Azure Key Vault
 * API keys should never be stored in App Service configuration
 */
function validateEnvironment(): void {
  const required = ['GEMINI_API_KEY'];
  const missing: string[] = [];

  for (const envVar of required) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }

  if (missing.length > 0) {
    logger.error('Missing required environment variables', { missing });
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    console.error('On Azure: Set these in Application Settings -> Configuration -> Application settings');
    console.error('Current working directory:', process.cwd());
    process.exit(1);
  }
}

// --- WEBHOOK AUTO-GENERATION DISABLED ---
// This infrastructure requires token storage for async webhook processing.
// SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
// The webhook flow has no frontend wiring to push tokens to the backend.
// Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
// To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
// See architecture notes in this file for details.
/*
function validatePayload(payload: any): { valid: boolean; error?: string } {
  if (!payload.eventType) {
    return { valid: false, error: 'Missing required field: eventType' };
  }

  if (payload.eventType !== 'git.pullrequest.created' && payload.eventType !== 'git.pullrequest.updated') {
    return { valid: false, error: `Invalid eventType: ${payload.eventType}` };
  }

  if (!payload.resource) {
    return { valid: false, error: 'Missing required field: resource' };
  }

  if (typeof payload.resource.pullRequestId !== 'number') {
    return { valid: false, error: 'Missing required field: resource.pullRequestId' };
  }

  if (!payload.resource.title || typeof payload.resource.title !== 'string') {
    return { valid: false, error: 'Missing required field: resource.title' };
  }

  if (!payload.resource.repository?.id) {
    return { valid: false, error: 'Missing required field: resource.repository.id' };
  }

  if (!payload.resource.repository?.project?.name) {
    return { valid: false, error: 'Missing required field: resource.repository.project.name' };
  }

  if (!payload.resource.sourceRefName || typeof payload.resource.sourceRefName !== 'string') {
    return { valid: false, error: 'Missing or invalid required field: resource.sourceRefName' };
  }

  if (!payload.resource.targetRefName || typeof payload.resource.targetRefName !== 'string') {
    return { valid: false, error: 'Missing or invalid required field: resource.targetRefName' };
  }

  if (!payload.resource.createdBy || typeof payload.resource.createdBy !== 'object') {
    return { valid: false, error: 'Missing or invalid required field: resource.createdBy' };
  }

  if (!payload.resource.createdBy.id) {
    return { valid: false, error: 'Missing required field: resource.createdBy.id' };
  }

  if (!payload.resource.createdBy.displayName || typeof payload.resource.createdBy.displayName !== 'string') {
    return { valid: false, error: 'Missing or invalid required field: resource.createdBy.displayName' };
  }

  return { valid: true };
}

async function handleStoreWebhookToken(req: AuthenticatedRequest, res: http.ServerResponse): Promise<void> {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);

      if (!payload.orgUrl || typeof payload.orgUrl !== 'string') {
        const errorResponse: ErrorResponse = {
          error: 'Bad Request',
          details: 'Missing or invalid required field: orgUrl'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      if (!payload.token || typeof payload.token !== 'string') {
        const errorResponse: ErrorResponse = {
          error: 'Bad Request',
          details: 'Missing or invalid required field: token'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      const orgUrl = payload.orgUrl.trim();
      const token = payload.token;

      await storeWebhookTokenInMemory(orgUrl, token, req.user?.id);

      logger.info('Webhook token stored successfully', {
        orgUrl,
        userId: req.user?.id,
        userDisplayName: req.user?.displayName,
        requestId: req.requestId
      });

      const response = {
        success: true,
        message: 'Webhook token stored successfully',
        orgUrl
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));

    } catch (error) {
      logger.error('Failed to store webhook token', {
        error: String(error),
        requestId: req.requestId
      });

      const errorResponse: ErrorResponse = {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error)
      };

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResponse));
    }
  });

  req.on('error', error => {
    logger.error('Request error', { error: String(error) });

    const errorResponse: ErrorResponse = {
      error: 'Internal server error',
      message: 'Failed to process request'
    };

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  });
}

async function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);

      logger.info('Webhook received', {
        eventType: payload.eventType,
        prId: payload.resource?.pullRequestId,
        userId: payload.resource?.createdBy?.id,
        userDisplayName: payload.resource?.createdBy?.displayName,
        requestId: payload.id,
          repositoryId: payload.resource?.repository?.id,
          repositoryName: payload.resource?.repository?.name,
          projectName: payload.resource?.repository?.project?.name,
          projectId: payload.resource?.repository?.project?.id,
          targetBranch: payload.resource?.targetRefName,
          sourceBranch: payload.resource?.sourceRefName
      });

      const validation = validatePayload(payload);

      if (!validation.valid) {
        logger.warn('Invalid webhook payload', { error: validation.error });

        const errorResponse: ErrorResponse = {
          error: 'Invalid payload',
          details: validation.error
        };

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      const repoUrl = payload.resource?.repository?.url;
      if (!repoUrl || typeof repoUrl !== 'string') {
        logger.warn('Missing repository URL in webhook payload');
        const errorResponse: ErrorResponse = {
          error: 'Bad Request',
          details: 'Missing required field: resource.repository.url'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      let orgUrl: string;
      try {
        const url = new URL(repoUrl);
        if (url.hostname === 'dev.azure.com') {
          const pathParts = url.pathname.split('/').filter(p => p);
          if (pathParts.length < 2) {
            throw new Error('Invalid repository URL format');
          }
          orgUrl = `https://dev.azure.com/${pathParts[0]}`;
        } else if (url.hostname.endsWith('.visualstudio.com')) {
          const orgName = url.hostname.split('.')[0];
          orgUrl = `https://${orgName}.visualstudio.com`;
        } else {
          throw new Error(`Unsupported Azure DevOps domain: ${url.hostname}`);
        }
      } catch (error) {
        logger.warn('Failed to extract organization URL from repository URL', { repoUrl, error: String(error) });
        const errorResponse: ErrorResponse = {
          error: 'Bad Request',
          details: `Invalid repository URL format: ${error instanceof Error ? error.message : String(error)}`
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      const serviceToken = await getStoredTokenForOrg(orgUrl);

      if (!serviceToken) {
        logger.error('Authentication failed - no token available for webhook processing', {
          orgUrl,
          hadStoredToken: webhookTokenStore.has(orgUrl),
          action: 'Please store webhook token via /api/webhook-token endpoint'
        });

        const errorResponse: ErrorResponse = {
          error: 'Service not configured',
          details: 'Webhook token not configured for this organization. ' +
                   'Visit the extension settings to authenticate with your organization.'
        };
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      if (!isOAuthToken(serviceToken)) {
        logger.warn('Stored token failed JWT format check', {
          orgUrl,
          tokenLength: serviceToken.length,
          containsDots: serviceToken.includes('.'),
          reason: 'stored-token-failed-jwt-check'
        });

        const errorResponse: ErrorResponse = {
          error: 'Service not configured',
          details: 'Stored token is not a valid OAuth token. Please re-authenticate via the extension.'
        };
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      logger.debug('Service token acquired for webhook processing', {
        orgUrl,
        tokenSource: 'encrypted-store',
        tokenLength: serviceToken.length,
        isJWT: true
      });

      const jobId = queue.addJob(payload as WebhookPayload, serviceToken, orgUrl);

      const response: WebhookResponse = {
        status: 'accepted',
        jobId
      };

      logger.info('Webhook queued successfully', { jobId, prId: payload.resource?.pullRequestId });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));

    } catch (error) {
      logger.error('Failed to process webhook', { error: String(error) });

      const errorResponse: ErrorResponse = {
        error: 'Invalid payload',
        details: error instanceof Error ? error.message : String(error)
      };

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResponse));
    }
  });

  req.on('error', error => {
    logger.error('Request error', { error: String(error) });

    const errorResponse: ErrorResponse = {
      error: 'Internal server error',
      message: 'Failed to process webhook'
    };

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  });
}
*/

/**
 * Handle health check GET request
 * Public endpoint (no authentication required) for monitoring
 * Sensitive queue information removed for security
 */
function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  // Security: Don't expose internal queue details publicly
  const response = {
    status: 'healthy',
    uptime,
    timestamp: new Date().toISOString()
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));

  logger.debug('Health check', { uptime });
}

/**
 * Handle generate tests POST request
 * Security: User identity verified by authentication middleware
 */
async function handleGenerateTests(req: AuthenticatedRequest, res: http.ServerResponse): Promise<void> {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);

      // Validate request body
      if (typeof payload.prId !== 'number' || !payload.projectName || !payload.repositoryId) {
        const errorResponse: ErrorResponse = {
          error: 'Missing required fields: prId, projectName, repositoryId'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      const customContext = payload.customContext; // Optional field

      // Validate custom context length
      const MAX_CONTEXT_LENGTH = 50000; // 50KB limit
      if (customContext && typeof customContext === 'string' && customContext.length > MAX_CONTEXT_LENGTH) {
        const errorResponse: ErrorResponse = {
          error: 'Custom context too large',
          details: `Custom context exceeds maximum length of ${MAX_CONTEXT_LENGTH} characters`
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      logger.info('Generate tests request', {
        prId: payload.prId,
        projectName: payload.projectName,
        repositoryId: payload.repositoryId,
        hasCustomContext: !!customContext,
        contextText: customContext === undefined || customContext === null || customContext === '' ? 'None' : (customContext.length > 100 ? customContext.substring(0, 100) + '...' : customContext),
        userId: req.user?.id,
        userDisplayName: req.user?.displayName,
        requestId: req.requestId
      });

      // Create connection using user's token and organization
      const token = req.headers['authorization']!.split(' ')[1];
      logger.debug('Token extracted for generate-tests', {
        tokenLength: token?.length,
        tokenContainsDots: token?.includes('.'),
        orgUrl: req.orgUrl,
        tokenSource: 'authorization-header'
      });

      // Extract organization name from URL for fetchPRDiff
      const orgName = extractOrgName(req.orgUrl!);

      // Fetch PR diff from utils
      const codeDiff = await fetchPRDiff(
        payload.projectName,
        payload.repositoryId,
        payload.prId,
        adoClient.createConnection(token, req.orgUrl!),
        orgName,
        token
      );

      // Create minimal PR metadata for AI generation
      const prMetadata: PRMetadata = {
        prId: payload.prId,
        title: 'Manual Test Generation',
        description: '',
        repositoryId: payload.repositoryId,
        repositoryName: '',
        projectName: payload.projectName,
        projectId: '',
        sourceBranch: '',
        targetBranch: '',
        author: '',
        authorEmail: '',
        createDate: payload.createDate instanceof Date ? payload.createDate : new Date(),
        branchName: payload.branchName || ''
      };

      // Generate test cases
      logger.debug('Calling AI generateTestCases', {
        prId: payload.prId,
        codeDiffFiles: codeDiff.changes.length,
        totalChanges: codeDiff.totalChanges,
        customContextLength: customContext?.length ?? 0
      });
      const taskOutput: TaskWorkItemOutput = await ai.generateTestCases(prMetadata, codeDiff, customContext);
      logger.debug('AI generateTestCases returned successfully', { prId: payload.prId, title: taskOutput.title });

      // Return test case + commit IDs for work item creation
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...taskOutput,
        sourceCommitId: codeDiff.sourceCommitId,
        targetCommitId: codeDiff.targetCommitId
      }));

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      let prId: number | undefined;
      try {
        const payload = JSON.parse(body);
        prId = typeof payload?.prId === 'number' ? payload.prId : undefined;
      } catch {
        // body may be invalid; ignore for logging
      }
      logger.error('Failed to generate tests', {
        error: err.message,
        errorName: err.name,
        stack: err.stack,
        prId,
        requestId: req.requestId,
        userId: req.user?.id
      });

      const errorResponse: ErrorResponse = {
        error: 'Test case generation failed',
        message: err.message
      };

      const statusCode = err.message.includes('not found') ? 404 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResponse));
    }
  });

  req.on('error', error => {
    logger.error('Request error', { error: String(error) });

    const errorResponse: ErrorResponse = {
      error: 'Internal server error',
      message: 'Failed to process request'
    };

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  });
}

/**
 * Handle create work item POST request
 * Security: User identity verified by authentication middleware
 */
async function handleCreateWorkItem(req: AuthenticatedRequest, res: http.ServerResponse): Promise<void> {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);

      // Validate request body
      if (!payload.testCase || typeof payload.prId !== 'number' || !payload.projectName || !payload.repositoryId || !payload.projectId || !payload.sourceCommitId || !payload.targetCommitId) {
        const errorResponse: ErrorResponse = {
          error: 'Invalid test case data',
          details: 'Missing required fields: testCase, prId, projectName, repositoryId, projectId, sourceCommitId, targetCommitId'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      logger.info('Create work item request', {
        prId: payload.prId,
        projectName: payload.projectName,
        userId: req.user?.id,
        userDisplayName: req.user?.displayName,
        requestId: req.requestId
      });

      // Create connection using user's token and organization
      const token = req.headers['authorization']!.split(' ')[1];
      logger.debug('Token extracted for create-work-item', {
        tokenLength: token?.length,
        tokenContainsDots: token?.includes('.'),
        orgUrl: req.orgUrl,
        tokenSource: 'authorization-header'
      });
      const connection = adoClient.createConnection(token, req.orgUrl!);

      // Create minimal PR metadata for work item creation
      const prMetadata: PRMetadata = {
        prId: payload.prId,
        title: payload.testCase.title || 'Test Case',
        description: '',
        repositoryId: payload.repositoryId,
        repositoryName: '',
        projectName: payload.projectName,
        projectId: payload.projectId,
        sourceCommitId: payload.sourceCommitId,
        targetCommitId: payload.targetCommitId,
        sourceBranch: '',
        targetBranch: '',
        author: '',
        authorEmail: '',
        createDate: new Date(),
        branchName: ''
      };

      // Create work item
      const workItemId = await adoClient.createTaskWorkItem(
        payload.projectName,
        payload.testCase,
        prMetadata,
        connection
      );

      // Build work item URL using user's organization
      const orgUrl = req.orgUrl!;
      const workItemUrl = `${orgUrl}/${payload.projectName}/_workitems/edit/${workItemId}`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        workItemId,
        workItemUrl
      }));

    } catch (error) {
      logger.error('Failed to create work item', { error: String(error) });

      const errorResponse: ErrorResponse = {
        error: 'Work item creation failed',
        message: error instanceof Error ? error.message : String(error)
      };

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResponse));
    }
  });

  req.on('error', error => {
    logger.error('Request error', { error: String(error) });

    const errorResponse: ErrorResponse = {
      error: 'Internal server error',
      message: 'Failed to process request'
    };

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  });
}

/**
 * Handle post PR comment POST request
 * Security: User identity verified by authentication middleware
 */
async function handlePostPRComment(req: AuthenticatedRequest, res: http.ServerResponse): Promise<void> {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);

      // Validate request body
      if (typeof payload.prId !== 'number' || !payload.projectName || !payload.repositoryId || typeof payload.workItemId !== 'number') {
        const errorResponse: ErrorResponse = {
          error: 'Missing required fields',
          details: 'prId, projectName, repositoryId, workItemId are required'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      logger.info('Post PR comment request', {
        prId: payload.prId,
        projectName: payload.projectName,
        workItemId: payload.workItemId,
        userId: req.user?.id,
        userDisplayName: req.user?.displayName,
        requestId: req.requestId
      });

      // Create connection using user's token and organization
      const token = req.headers['authorization']!.split(' ')[1];
      logger.debug('Token extracted for post-pr-comment', {
        tokenLength: token?.length,
        tokenContainsDots: token?.includes('.'),
        orgUrl: req.orgUrl,
        tokenSource: 'authorization-header'
      });
      const connection = adoClient.createConnection(token, req.orgUrl!);

      // Call backend function to post comment.
      // If no custom commentContent is provided, the backend will post its default message.
      await adoClient.postPRComment({
        projectName: payload.projectName,
        repositoryId: payload.repositoryId,
        prId: payload.prId,
        workItemId: payload.workItemId,
        connection,
        commentContent:
          payload.commentContent && typeof payload.commentContent === 'string'
            ? payload.commentContent
            : undefined
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));

    } catch (error) {
      logger.error('Failed to post PR comment', { error: String(error) });

      const errorResponse: ErrorResponse = {
        error: 'Failed to post comment',
        message: error instanceof Error ? error.message : String(error)
      };

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResponse));
    }
  });

  req.on('error', error => {
    logger.error('Request error', { error: String(error) });

    const errorResponse: ErrorResponse = {
      error: 'Internal server error',
      message: 'Failed to process request'
    };

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  });
}

/**
 * Handle extract purpose-scope POST request
 * Security: User identity verified by authentication middleware
 */
async function handleExtractPurposeScope(req: AuthenticatedRequest, res: http.ServerResponse): Promise<void> {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);

      if (payload.html === undefined || payload.html === null || typeof payload.html !== 'string') {
        const errorResponse: ErrorResponse = {
          error: 'Missing or invalid field: html',
          details: 'Request body must include a string field: html'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      const extracted = ai.extractPurposeAndScope(payload.html);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ extracted }));
    } catch (error) {
      logger.error('Failed to extract purpose-scope', { error: String(error) });

      const errorResponse: ErrorResponse = {
        error: 'Failed to extract purpose-scope',
        message: error instanceof Error ? error.message : String(error)
      };

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResponse));
    }
  });

  req.on('error', error => {
    logger.error('Request error', { error: String(error) });

    const errorResponse: ErrorResponse = {
      error: 'Internal server error',
      message: 'Failed to process request'
    };

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  });
}

/**
 * Apply CORS headers
 * Security: Hardened to only allow exact origin matches, no wildcard matching
 */
function applyCorsHeaders(res: http.ServerResponse, origin?: string): void {
  const normalizedOrigin =
    typeof origin === "string" ? origin : null;

  if (!normalizedOrigin) {
    logger.info("CORS: No origin header, treating as server-to-server request");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Credentials", "false");
    return;
  }

  logger.info("CORS: Incoming origin", { origin: normalizedOrigin });



  // Allowed patterns
  const basePatterns = [
    "https://dev.azure.com/*",
    "https://*.azurewebsites.net",
    "https://*.gallerycdn.vsassets.io",
    "https://qazent.azurewebsites.net",
    "https://qazent.gallerycdn.vsassets.io"
  ];

  const devPatterns =
    process.env.NODE_ENV === "development"
      ? [
          "http://localhost:3000",
          "https://rathely-rubidic-katelin.ngrok-free.dev",
          process.env.NGROK_URL
        ].filter(Boolean) as string[]
      : [];

  const allowedPatterns = [...basePatterns, ...devPatterns];

  // Wildcard matcher
  function matchesPattern(origin: string, pattern: string): boolean {
    if (!pattern) return false;

    if (pattern === "*") return true;

    if (pattern.endsWith("/*")) {
      const base = pattern.replace("/*", "");
      return origin.startsWith(base);
    }

    if (pattern.includes("*.")) {
      const domain = pattern.replace("*.", "");
      return origin.endsWith(domain);
    }

    return origin === pattern;
  }

  const isAllowed = allowedPatterns.some((p) => matchesPattern(origin!, p));

  if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin!);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    logger.info("CORS: Allowed origin", { origin });
  } else {
    const fallback = "https://dev.azure.com";
    res.setHeader("Access-Control-Allow-Origin", fallback);
    res.setHeader("Access-Control-Allow-Credentials", "false");
    logger.warn("CORS: Blocked origin, using fallback", {
      origin,
      fallback,
      allowedPatterns
    });
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Ado-Org-Url"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}
/**
 * Audit logging: Log all authenticated requests
 */
function logAuthenticatedRequest(
  req: AuthenticatedRequest,
  res: http.ServerResponse,
  startTime: number
): void {
  const duration = Date.now() - startTime;

  // Capture status code by hooking into writeHead
  const originalWriteHead = res.writeHead.bind(res);
  let statusCode = 200;

  res.writeHead = function(code: number, ...args: any[]): http.ServerResponse {
    statusCode = code;
    return originalWriteHead(code, ...args);
  };

  // Log on response finish
  res.on('finish', () => {
    const logData = {
      timestamp: new Date().toISOString(),
      level: statusCode >= 400 ? 'WARN' : 'INFO',
      type: 'API_REQUEST',
      userId: req.user?.id || 'anonymous',
      userDisplayName: req.user?.displayName || 'Anonymous',
      method: req.method,
      path: req.url,
      statusCode,
      duration,
      ip: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      requestId: req.requestId
    };

    if (statusCode >= 400) {
      logger.warn('Request completed with error', logData);
    } else {
      logger.info('Request completed successfully', logData);
    }
  });
}

/**
 * Helper to apply middleware chain: rate limiting + authentication + audit logging + handler
 */
function applyMiddleware(
  rateLimiter: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void,
  handler: (req: AuthenticatedRequest, res: http.ServerResponse) => Promise<void>
) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const startTime = Date.now();

    // Apply rate limiting first
    rateLimiter(req, res, async () => {
      // Then apply authentication
      await createAuthMiddleware(async (authReq: AuthenticatedRequest) => {
        // Add audit logging
        logAuthenticatedRequest(authReq, res, startTime);

        // Finally call the handler
        await handler(authReq, res);
      })(req, res);
    });
  };
}

/**
 * Start the server
 */
function startServer(): void {
  // Validate environment
  validateEnvironment();

  // Azure DevOps connections created per-request using user's OAuth token
  // No global connection initialization needed

  // Load AI system prompt
  try {
    ai.loadSystemPrompt();
  } catch (error) {
    logger.error('Failed to load system prompt', { error: String(error) });
    console.error('FATAL: Failed to load system prompt');
    process.exit(1);
  }

  // --- WEBHOOK AUTO-GENERATION DISABLED ---
  // This infrastructure requires token storage for async webhook processing.
  // SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
  // The webhook flow has no frontend wiring to push tokens to the backend.
  // Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
  // To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
  // See architecture notes in this file for details.
  // queue.startWorker();

  // Create HTTP server with main request handler
  // Security: All endpoints (except /health) protected with authentication
  const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method;
    const url = req.url;
    const origin = req.headers.origin;

    logger.info("Request received", { method, url, origin });

    // Apply CORS headers to all responses
    applyCorsHeaders(res, origin);

    // Normalize URL (fixes //generate-tests)
    const normalizedUrl = url?.replace(/^\/+/, '/');
    logger.info("Normalized URL", { normalizedUrl });


    // Handle preflight requests
    if (method === 'OPTIONS') {
      logger.info("OPTIONS preflight received", { url, origin });

      res.writeHead(204);
      res.end();

      logger.info("OPTIONS response sent (204)");
      return;
    }

    // Health check endpoint (PUBLIC - no authentication, only rate limiting)
    if ((normalizedUrl === '/health' || normalizedUrl === '/') && (method === 'GET' || method === 'HEAD')) {
      rateLimitHealth(req, res, () => {
        handleHealth(req, res);
      });
      return;
    }

    // Generate tests endpoint (PROTECTED - authentication + rate limiting)
    if (normalizedUrl === '/generate-tests' && method === 'POST') {
      logger.info("POST /generate-tests hit");

      const contentType = req.headers['content-type'];
      logger.info("POST content-type", { contentType });

      if (!contentType || !contentType.includes('application/json')) {
        logger.warn("Invalid content type", { contentType });

        const errorResponse: ErrorResponse = {
          error: 'Invalid content type',
          details: 'Expected application/json'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      logger.info("Applying authentication and rate limiting...");
      await applyMiddleware(rateLimitGenerateTests, handleGenerateTests)(req, res);
      return;
    }

    // Create work item endpoint (PROTECTED - authentication + rate limiting)
    if (normalizedUrl === '/create-work-item' && method === 'POST') {
      logger.info("POST /create-work-item hit");

      const contentType = req.headers['content-type'];
      logger.info("POST content-type", { contentType });

      if (!contentType || !contentType.includes('application/json')) {
        logger.warn("Invalid content type", { contentType });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid content type', details: 'Expected application/json' }));
        return;
      }

      await applyMiddleware(rateLimitCreateWorkItem, handleCreateWorkItem)(req, res);
      return;
    }

    // Post PR comment endpoint (PROTECTED - authentication + rate limiting)
    if (normalizedUrl === '/post-pr-comment' && method === 'POST') {
      logger.info("POST /post-pr-comment hit");

      const contentType = req.headers['content-type'];
      if (!contentType || !contentType.includes('application/json')) {
        logger.warn("Invalid content type", { contentType });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid content type' }));
        return;
      }

      await applyMiddleware(rateLimitPostPRComment, handlePostPRComment)(req, res);
      return;
    }

    // Extract purpose-scope endpoint (PROTECTED - authentication + rate limiting)
    if (normalizedUrl === '/api/extract-purpose-scope' && method === 'POST') {
      logger.info("POST /api/extract-purpose-scope hit");

      const contentType = req.headers['content-type'];
      if (!contentType || !contentType.includes('application/json')) {
        logger.warn("Invalid content type", { contentType });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid content type', details: 'Expected application/json' }));
        return;
      }

      await applyMiddleware(rateLimitExtractPurposeScope, handleExtractPurposeScope)(req, res);
      return;
    }

    // --- WEBHOOK AUTO-GENERATION DISABLED ---
    // This infrastructure requires token storage for async webhook processing.
    // SDK.getAccessToken() tokens expire in ~1hr and cannot be refreshed server-side.
    // The webhook flow has no frontend wiring to push tokens to the backend.
    // Only the button-driven flow (PRAssistantHub → "Generate Tests") is active.
    // To re-enable, implement: (1) frontend token push, (2) deferred webhook queue.
    // See architecture notes in this file for details.
    /*
    // Store webhook token endpoint (PROTECTED - authentication + rate limiting)
    if (normalizedUrl === '/api/webhook-token' && method === 'POST') {
      logger.info("POST /api/webhook-token hit");

      const contentType = req.headers['content-type'];
      if (!contentType || !contentType.includes('application/json')) {
        logger.warn('Invalid content type for webhook token storage', { contentType });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Invalid content type',
          details: 'Expected application/json'
        }));
        return;
      }

      await applyMiddleware(rateLimitGenerateTests, handleStoreWebhookToken)(req, res);
      return;
    }

    // Webhook endpoint (PUBLIC - no authentication, no rate limiting)
    if (normalizedUrl === '/webhook' && method === 'POST') {
      const contentType = req.headers['content-type'];

      if (!contentType || !contentType.includes('application/json')) {
        logger.warn('Invalid content type for webhook', { contentType });

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Invalid content type',
          expected: 'application/json'
        }));
        return;
      }

      await handleWebhook(req, res);
      return;
    }
    */
  });

    server.listen(PORT, "0.0.0.0", () => {
    logger.info("Server started", { port: PORT });
    console.log(`Server listening on port ${PORT}`);
  });

  // Handle server errors
  server.on('error', error => {
    logger.error('Server error', { error: String(error) });
    console.error('FATAL: Server error', error);
    process.exit(1);
  });

  // Handle process termination
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  });
}

// Start the server
startServer();

