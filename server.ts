/**
 * HTTP webhook server for Azure DevOps PR events
 */

import * as http from 'http';
import * as dotenv from 'dotenv';

import { WebhookPayload, WebhookResponse, ErrorResponse, HealthResponse } from './types';
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
 * Main request handler
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const method = req.method;
  const url = req.url;

  logger.info('Request received', { method, url });

  // Health check endpoint
  if (url === '/health' && method === 'GET') {
    handleHealth(req, res);
    return;
  }

  // Webhook endpoint
  if (url === '/webhook' && method === 'POST') {
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
  if (url === '/webhook' && method !== 'POST') {
    logger.warn('Method not allowed', { method, url });

    const errorResponse: ErrorResponse = {
      error: 'Method not allowed',
      details: 'Only POST requests are accepted'
    };

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
    return;
  }

  // 404 for all other routes
  logger.warn('Route not found', { method, url });

  const errorResponse: ErrorResponse = {
    error: 'Not found',
    details: `Route ${url} not found`
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
