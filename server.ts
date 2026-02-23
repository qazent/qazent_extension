/**
 * HTTP webhook server for Azure DevOps PR events
 */

import * as http from 'http';
import * as dotenv from 'dotenv';

import { WebhookPayload, WebhookResponse, ErrorResponse, HealthResponse, PRMetadata, TaskWorkItemOutput } from './types';
import * as logger from './logger';
import * as queue from './queue';
import * as adoClient from './ado-client';
import * as ai from './ai';

// Load environment variables
dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const startTime = Date.now();


/**
 * Validate required environment variables
 */
function validateEnvironment(): void {
  const required = ['ADO_ORG_URL', 'ADO_PAT', 'GEMINI_API_KEY'];
  const errors: string[] = [];

  for (const envVar of required) {
    const value = process.env[envVar];

    // Check if variable is missing
    if (!value) {
      errors.push(`Environment variable ${envVar} is required`);
      continue;
    }

    // Check if variable is empty string
    if (value === '') {
      errors.push(`Environment variable ${envVar} cannot be empty`);
      continue;
    }

    // Check if variable contains literal "undefined"
    if (value === 'undefined') {
      errors.push(`Environment variable ${envVar} contains 'undefined' - check .env file`);
      continue;
    }

    // Additional validation for ADO_ORG_URL
    if (envVar === 'ADO_ORG_URL' && !value.startsWith('https://')) {
      errors.push(`Environment variable ${envVar} must be a valid https:// URL`);
      continue;
    }

    // Additional validation for ADO_PAT (minimum length check)
    if (envVar === 'ADO_PAT' && value.length < 20) {
      errors.push(`Environment variable ${envVar} appears invalid (must be at least 20 characters)`);
      continue;
    }
  }

  if (errors.length > 0) {
    logger.error('Environment variable validation failed', { errors });
    console.error('FATAL: Environment variable validation failed:');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  // Log successful validation (redact sensitive values)
  logger.info('Environment validated', {
    ADO_ORG_URL: process.env.ADO_ORG_URL,
    ADO_PAT: '<redacted>',
    GEMINI_API_KEY: '<redacted>'
  });
  console.log('Environment variables validated successfully');
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
 */
async function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
        prId: payload.resource?.pullRequestId
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

      // Add job to queue
      const jobId = queue.addJob(payload as WebhookPayload);

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
 */
function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const queueStatus = queue.getQueueStatus();

  const response: HealthResponse = {
    status: 'healthy',
    uptime,
    queue: queueStatus,
    timestamp: new Date().toISOString()
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));

  logger.debug('Health check', { uptime, queueStatus });
}

/**
 * Handle generate tests POST request
 */
async function handleGenerateTests(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
          error: 'Missing required fields',
          details: 'prId (number), projectName, and repositoryId are required'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      // Check for undefined literal values
      if (payload.projectName === 'undefined' || payload.repositoryId === 'undefined') {
        const errorResponse: ErrorResponse = {
          error: 'Invalid parameters',
          details: 'Parameters contain literal "undefined" value'
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
        contextText: customContext === undefined || customContext === null || customContext === '' ? 'None' : (customContext.length > 100 ? customContext.substring(0, 100) + '...' : customContext)
      });

      // Fetch PR diff
      const codeDiff = await adoClient.fetchPRDiff(
        payload.projectName,
        payload.repositoryId,
        payload.prId
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

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(taskOutput));

    } catch (error) {
      logger.error('Failed to generate tests', { error: String(error) });

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Categorize Azure DevOps errors
      if (errorMessage.includes('HTML login page')) {
        const errorResponse: ErrorResponse = {
          error: 'Azure DevOps API Error',
          message: 'Authentication failed - received HTML instead of data. Check ADO_PAT, ADO_ORG_URL, and ensure all parameters are defined.',
          details: 'ADO_HTML_RESPONSE'
        };
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      if (errorMessage.includes('authentication failed') || errorMessage.includes('401')) {
        const errorResponse: ErrorResponse = {
          error: 'Azure DevOps API Error',
          message: 'Authentication failed - check PAT token',
          details: 'ADO_AUTH_FAILURE'
        };
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      if (errorMessage.includes('not found') || errorMessage.includes('404')) {
        const errorResponse: ErrorResponse = {
          error: 'Resource not found',
          message: errorMessage
        };
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      if (errorMessage.includes('Access denied') || errorMessage.includes('403')) {
        const errorResponse: ErrorResponse = {
          error: 'Azure DevOps API Error',
          message: 'Access denied - check PAT permissions',
          details: 'ADO_PERMISSION_DENIED'
        };
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      // Generic error
      const errorResponse: ErrorResponse = {
        error: 'Test case generation failed',
        message: errorMessage
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
 * Handle create work item POST request
 */
async function handleCreateWorkItem(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

      // Check for undefined literal values
      if (payload.projectName === 'undefined' || payload.repositoryId === 'undefined' || payload.projectId === 'undefined') {
        const errorResponse: ErrorResponse = {
          error: 'Invalid parameters',
          details: 'Parameters contain literal "undefined" value'
        };
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      logger.info('Create work item request', {
        prId: payload.prId,
        projectName: payload.projectName
      });

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
        prMetadata
      );

      // Build work item URL
      const orgUrl = process.env.ADO_ORG_URL;
      const workItemUrl = `${orgUrl}/${payload.projectName}/_workitems/edit/${workItemId}`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        workItemId,
        workItemUrl
      }));

    } catch (error) {
      logger.error('Failed to create work item', { error: String(error) });

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Categorize Azure DevOps errors
      if (errorMessage.includes('HTML login page')) {
        const errorResponse: ErrorResponse = {
          error: 'Azure DevOps API Error',
          message: 'Authentication failed - received HTML instead of data. Check ADO_PAT, ADO_ORG_URL, and ensure all parameters are defined.',
          details: 'ADO_HTML_RESPONSE'
        };
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      if (errorMessage.includes('authentication failed') || errorMessage.includes('401')) {
        const errorResponse: ErrorResponse = {
          error: 'Azure DevOps API Error',
          message: 'Authentication failed - check PAT token',
          details: 'ADO_AUTH_FAILURE'
        };
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      if (errorMessage.includes('Access denied') || errorMessage.includes('403')) {
        const errorResponse: ErrorResponse = {
          error: 'Azure DevOps API Error',
          message: 'Access denied - check PAT permissions',
          details: 'ADO_PERMISSION_DENIED'
        };
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
        return;
      }

      // Generic error
      const errorResponse: ErrorResponse = {
        error: 'Work item creation failed',
        message: errorMessage
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
 */
function applyCorsHeaders(res: http.ServerResponse, origin?: string): void {
  logger.info("CORS: Incoming origin", { origin });

  // Allow Azure DevOps origins and localhost for development
  const allowedOrigins = [
    'https://dev.azure.com',
    'https://visualstudio.com',
    'https://qazent.azurewebsites.net', // For Azure Functions if used
    'https://rathely-rubidic-katelin.ngrok-free.dev', // For ngrok tunnels during development
    'https://qazent.gallerycdn.vsassets.io' // For Azure DevOps hosted extensions
  ];

  // Allow localhost for development
  if (origin && (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))) {
    logger.info("CORS: Allowing localhost origin", { origin });
    allowedOrigins.push(origin);
  }

  // Check if origin is allowed
  const allowOrigin = origin && allowedOrigins.some(allowed =>
    origin === allowed || origin.endsWith(allowed)
  ) ? origin : allowedOrigins[0];

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  logger.info("CORS: Headers applied");

}

/**
 * Main request handler
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
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

  // Health check endpoint
  if (normalizedUrl === '/health' && method === 'GET') {
    logger.info("Health check hit");
    handleHealth(req, res);
    return;
  }

  // Generate tests endpoint
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

    logger.info("Calling handleGenerateTests...");
    handleGenerateTests(req, res);
    return;
  }

  // Create work item endpoint
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

    handleCreateWorkItem(req, res);
    return;
  }


  // Webhook endpoint
  if (normalizedUrl === '/webhook' && method === 'POST') {
    // Check content type
    const contentType = req.headers['content-type'];

    if (!contentType || !contentType.includes('application/json')) {
      logger.warn('Invalid content type', { contentType });

      const errorResponse: ErrorResponse = {
        error: 'Invalid content type',
        details: 'Expected application/json'
      };

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResponse));
      return;
    }

    handleWebhook(req, res);
    return;
  }

  // Wrong method for webhook
  if (normalizedUrl === '/webhook' && method !== 'POST') {
    logger.warn('Method not allowed', { method, url: normalizedUrl });

    const errorResponse: ErrorResponse = {
      error: 'Method not allowed',
      details: 'Only POST requests are accepted'
    };

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
    return;
  }

  // 404 for all other routes
  logger.warn('Route not found', { method, url, normalizedUrl, origin, headers: req.headers, statusCode: res.statusCode });

  const errorResponse: ErrorResponse = {
    error: 'Not found',
    details: `Route ${normalizedUrl} or URL ${url} not found`
  };

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(errorResponse));
}

/**
 * Start the server
 */
function startServer(): void {
  // Validate environment
  validateEnvironment();

  // Initialize Azure DevOps connection
  try {
    adoClient.initializeAdoConnection();
  } catch (error) {
    logger.error('Failed to initialize Azure DevOps connection', { error: String(error) });
    console.error('FATAL: Failed to initialize Azure DevOps connection');
    process.exit(1);
  }

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
