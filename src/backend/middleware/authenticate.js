"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticate = authenticate;
exports.createAuthMiddleware = createAuthMiddleware;
const logger = __importStar(require("@logger"));
const tokenValidator_1 = require("../utils/tokenValidator");
/**
 * Generate unique request ID for tracking
 */
function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
/**
 * Send standardized error response
 */
function sendErrorResponse(res, statusCode, code, message, requestId) {
    const errorResponse = {
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
async function authenticate(req, res, next) {
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
    const orgUrlHeader = req.headers['x-ado-org-url'];
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
    let parsedUrl;
    try {
        parsedUrl = new URL(orgUrl);
    }
    catch (error) {
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
        const identity = await (0, tokenValidator_1.validateAzureDevOpsToken)(token, orgUrl);
        // Verify user belongs to the expected organization
        if (identity.organization !== orgUrl) {
            logger.warn('Authentication failed - user from wrong organization', {
                requestId,
                userId: identity.id,
                userOrg: identity.organization,
                expectedOrg: orgUrl
            });
            sendErrorResponse(res, 403, 'FORBIDDEN', 'User not authorized for this organization', requestId);
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
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Token validation failed', {
            requestId,
            error: errorMessage
        });
        // Determine error code based on error message
        if (errorMessage.includes('expired') || errorMessage.includes('Invalid or expired')) {
            sendErrorResponse(res, 401, 'TOKEN_EXPIRED', 'Token has expired', requestId);
        }
        else if (errorMessage.includes('unavailable') || errorMessage.includes('timeout')) {
            sendErrorResponse(res, 503, 'SERVICE_UNAVAILABLE', 'Azure DevOps service temporarily unavailable', requestId);
        }
        else {
            sendErrorResponse(res, 401, 'INVALID_TOKEN', 'Invalid or expired token', requestId);
        }
    }
}
/**
 * Wrapper to use authentication middleware with native http.Server
 * Since we're using raw http module (not Express), we need this helper
 */
function createAuthMiddleware(handler) {
    return async (req, res) => {
        const authReq = req;
        await authenticate(authReq, res, async () => {
            await handler(authReq, res);
        });
    };
}
//# sourceMappingURL=authenticate.js.map