/**
 * HTTP webhook server for Azure DevOps PR events
 *
 * Security: All endpoints (except /health) require Azure DevOps OAuth token validation
 */

import * as http from 'http';
// import * as dotenv from 'dotenv';

import { WebhookPayload, WebhookResponse, ErrorResponse, PRMetadata, TaskWorkItemOutput } from './types';
import * as logger from './logger';
import * as queue from './queue';
import * as adoClient from './ado-client';
import * as ai from './ai';
import { fetchPRDiff } from './fetchPRdiff';
import { createAuthMiddleware, AuthenticatedRequest } from './src/middleware/authenticate';
import {
  rateLimitGenerateTests,
  rateLimitCreateWorkItem,
  rateLimitPostPRComment,
  rateLimitWebhook,
  rateLimitHealth
} from './src/middleware/rateLimiter';

// Load environment variables
// dotenv.config(); // FOR CLOUD DEPLOYMENT, ENV VARS SHOULD BE SET IN THE APP SERVICE CONFIGURATION, NOT IN A .env FILE

const PORT = parseInt(process.env.PORT || '8080', 10);
const startTime = Date.now();



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
    process.exit(1);
  }
}

/**
 * Validate webhook payload structure
 */
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

  if (!payload.resource.sourceRefName) {
    return { valid: false, error: 'Missing required field: resource.sourceRefName' };
  }

  if (!payload.resource.targetRefName) {
    return { valid: false, error: 'Missing required field: resource.targetRefName' };
  }

  return { valid: true };
}

/**
 * Handle webhook POST request
 * Security: User identity verified by authentication middleware
 */
async function handleWebhook(req: AuthenticatedRequest, res: http.ServerResponse): Promise<void> {
  // Read request body
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    try {
      // Parse JSON
      const payload = JSON.parse(body);

      logger.info('Webhook received', {
        eventType: payload.eventType,
        prId: payload.resource?.pullRequestId,
        userId: req.user?.id,
        userDisplayName: req.user?.displayName,
        requestId: req.requestId
      });

      // Validate payload
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

      // Add job to queue with authentication credentials
      const token = req.headers['authorization']!.split(' ')[1];
      const jobId = queue.addJob(payload as WebhookPayload, token, req.orgUrl!);

      // Return 202 Accepted
      const response: WebhookResponse = {
        status: 'accepted',
        jobId
      };

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
      const taskOutput: TaskWorkItemOutput = await ai.generateTestCases(prMetadata, codeDiff, customContext);

      // Return test case + commit IDs for work item creation
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...taskOutput,
        sourceCommitId: codeDiff.sourceCommitId,
        targetCommitId: codeDiff.targetCommitId
      }));

    } catch (error) {
      logger.error('Failed to generate tests', { error: String(error) });

      const errorResponse: ErrorResponse = {
        error: 'Test case generation failed',
        message: error instanceof Error ? error.message : String(error)
      };

      const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 500;
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
      const connection = adoClient.createConnection(token, req.orgUrl!);

      // Call backend function to post comment
      await adoClient.postPRComment(
        payload.projectName,
        payload.repositoryId,
        payload.prId,
        payload.workItemId,
        connection
      );

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
 * Apply CORS headers
 * Security: Hardened to only allow exact origin matches, no wildcard matching
 */
function applyCorsHeaders(res: http.ServerResponse, origin?: string): void {
  logger.info("CORS: Incoming origin", { origin });

  // Base allowed origins for production
  const baseOrigins = [
    'https://dev.azure.com',
    'https://visualstudio.com',
    'https://qazent.azurewebsites.net',
    'https://qazent.gallerycdn.vsassets.io'
  ];

  // Add development origins only in development mode
  const allowedOrigins = [
    ...baseOrigins,
    ...(process.env.NODE_ENV === 'development' ? [
      'http://localhost:3000',
      'https://rathely-rubidic-katelin.ngrok-free.dev',
      process.env.NGROK_URL
    ].filter(Boolean) as string[] : [])
  ];

  // Security: Only exact matches allowed (no wildcard matching or endsWith)
  const allowOrigin = origin && allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0];

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ado-Org-Url');
  res.setHeader('Access-Control-Allow-Credentials', 'true'); // Required for Authorization header
  res.setHeader('Access-Control-Max-Age', '86400');

  if (origin && !allowedOrigins.includes(origin)) {
    logger.warn("CORS: Origin not in allowed list", { origin, allowedOrigins });
  } else {
    logger.info("CORS: Headers applied", { origin, allowOrigin });
  }
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
 * Main request handler
 * Security: All endpoints (except /health) protected with authentication
 */
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
  if (normalizedUrl === '/health' && method === 'GET') {
    logger.info("Health check hit");
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



// Webhook endpoint (PUBLIC + rate limiting)
if (normalizedUrl === '/webhook' && method === 'POST') {
  const contentType = req.headers['content-type'];

  if (!contentType || !contentType.includes('application/json')) {
    logger.warn('Invalid content type', { contentType });

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Invalid content type',
      details: 'Expected application/json'
    }));
    return;
  }

  await rateLimitWebhook(req, res, () => handleWebhook(req, res));
  return;
      } // closes public webhook
  } // closes handleRequest()

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

  // Start background worker
  queue.startWorker();

  // Create HTTP server
  const server = http.createServer(handleRequest);

  server.listen(PORT, () => {
    logger.info('Server started', { port: PORT });
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
