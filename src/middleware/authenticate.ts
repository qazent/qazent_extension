/**
 * Authentication Middleware
 *
 * Validates Azure DevOps OAuth tokens on every protected endpoint.
 * Extracts and attaches user identity to request object.
 *
 * Security model:
 * - Frontend obtains token via SDK.getAccessToken()
 * - Token sent in Authorization: Bearer <token> header
 * - Backend validates token against Azure DevOps API
 * - User identity verified before processing request
 * - Backend continues to use privileged PAT for Azure DevOps operations
 */

import * as http from 'http';
import * as logger from '../../logger';
import { validateAzureDevOpsToken, UserIdentity } from '../utils/tokenValidator';

/**
 * Extended request with user identity and organization context
 */
export interface AuthenticatedRequest extends http.IncomingMessage {
  user?: UserIdentity;
  orgUrl?: string;  // Organization URL from X-Ado-Org-Url header
  requestId?: string;
}

/**
 * Standard error response format
 */
interface StandardErrorResponse {
  error: {
    code: string;
    message: string;
    statusCode: number;
    requestId: string;
    timestamp: string;
  };
}

/**
 * Generate unique request ID for tracking
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Send standardized error response
 */
function sendErrorResponse(
  res: http.ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  requestId: string
): void {
  const errorResponse: StandardErrorResponse = {
    error: {
      code,
      message,
      statusCode,
      requestId,
      timestamp: new Date().toISOString()
    }
  };

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(errorResponse));
}

/**
 * Authentication middleware
 *
 * Validates Authorization: Bearer <token> header
 * Attaches user identity to request if valid
 * Returns 401/403 if authentication fails
 */
export async function authenticate(
  req: AuthenticatedRequest,
  res: http.ServerResponse,
  next: () => void
): Promise<void> {
  const requestId = generateRequestId();
  req.requestId = requestId;

  // Extract Authorization header
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    logger.warn('Authentication failed - missing Authorization header', { requestId });
    sendErrorResponse(res, 401, 'UNAUTHORIZED', 'Authentication required', requestId);
    return;
  }

  // Validate Bearer token format
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    logger.warn('Authentication failed - invalid Authorization header format', { requestId, authHeader: authHeader.substring(0, 20) });
    sendErrorResponse(res, 401, 'UNAUTHORIZED', 'Invalid authorization format. Expected: Bearer <token>', requestId);
    return;
  }

  const token = parts[1];

  if (!token || token.trim() === '') {
    logger.warn('Authentication failed - empty token', { requestId });
    sendErrorResponse(res, 401, 'INVALID_TOKEN', 'Invalid or expired token', requestId);
    return;
  }

  // Extract and validate X-Ado-Org-Url header
  const orgUrlHeader = req.headers['x-ado-org-url'] as string | undefined;

  if (!orgUrlHeader) {
    logger.warn('Authentication failed - missing X-Ado-Org-Url header', { requestId });
    sendErrorResponse(res, 400, 'BAD_REQUEST', 'Missing X-Ado-Org-Url header', requestId);
    return;
  }

  // Trim whitespace from organization URL
  const orgUrl = orgUrlHeader.trim();

  if (orgUrl === '') {
    logger.warn('Authentication failed - empty organization URL', { requestId });
    sendErrorResponse(res, 400, 'BAD_REQUEST', 'Empty organization URL', requestId);
    return;
  }

  // Validate organization URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(orgUrl);
  } catch (error) {
    logger.warn('Authentication failed - invalid URL format', { requestId, orgUrl });
    sendErrorResponse(res, 400, 'BAD_REQUEST', 'Invalid organization URL format', requestId);
    return;
  }

  // Validate Azure DevOps URL pattern
  const isDevAzureCom = parsedUrl.hostname === 'dev.azure.com';
  const isVisualStudioCom = parsedUrl.hostname.endsWith('.visualstudio.com');
  const isHttps = parsedUrl.protocol === 'https:';

  if (!isHttps) {
    logger.warn('Authentication failed - non-HTTPS organization URL', { requestId, orgUrl });
    sendErrorResponse(res, 400, 'BAD_REQUEST', 'Organization URL must use HTTPS', requestId);
    return;
  }

  if (!isDevAzureCom && !isVisualStudioCom) {
    logger.warn('Authentication failed - invalid Azure DevOps domain', { requestId, orgUrl, hostname: parsedUrl.hostname });
    sendErrorResponse(res, 400, 'BAD_REQUEST', 'Invalid organization URL format. Expected: https://dev.azure.com/{org} or https://{org}.visualstudio.com', requestId);
    return;
  }

  try {
    const identity = await validateAzureDevOpsToken(token, orgUrl);

    // Verify user belongs to the expected organization
    if (identity.organization !== orgUrl) {
      logger.warn('Authentication failed - user from wrong organization', {
        requestId,
        userId: identity.id,
        userOrg: identity.organization,
        expectedOrg: orgUrl
      });
      sendErrorResponse(
        res,
        403,
        'FORBIDDEN',
        'User not authorized for this organization',
        requestId
      );
      return;
    }

    // Attach user identity and organization URL to request
    req.user = identity;
    req.orgUrl = orgUrl;

    logger.info('User authenticated successfully', {
      requestId,
      userId: identity.id,
      displayName: identity.displayName,
      orgUrl,
      method: req.method,
      url: req.url
    });

    // Call next handler
    next();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.warn('Token validation failed', {
      requestId,
      error: errorMessage
    });

    // Determine error code based on error message
    if (errorMessage.includes('expired') || errorMessage.includes('Invalid or expired')) {
      sendErrorResponse(res, 401, 'TOKEN_EXPIRED', 'Token has expired', requestId);
    } else if (errorMessage.includes('unavailable') || errorMessage.includes('timeout')) {
      sendErrorResponse(res, 503, 'SERVICE_UNAVAILABLE', 'Azure DevOps service temporarily unavailable', requestId);
    } else {
      sendErrorResponse(res, 401, 'INVALID_TOKEN', 'Invalid or expired token', requestId);
    }
  }
}

/**
 * Wrapper to use authentication middleware with native http.Server
 * Since we're using raw http module (not Express), we need this helper
 */
export function createAuthMiddleware(handler: (req: AuthenticatedRequest, res: http.ServerResponse) => Promise<void>) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    await authenticate(authReq, res, async () => {
      await handler(authReq, res);
    });
  };
}
