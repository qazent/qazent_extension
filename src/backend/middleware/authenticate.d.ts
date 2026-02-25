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
import { UserIdentity } from '../utils/tokenValidator';
/**
 * Extended request with user identity and organization context
 */
export interface AuthenticatedRequest extends http.IncomingMessage {
    user?: UserIdentity;
    orgUrl?: string;
    requestId?: string;
}
/**
 * Authentication middleware
 *
 * Validates Authorization: Bearer <token> header
 * Attaches user identity to request if valid
 * Returns 401/403 if authentication fails
 */
export declare function authenticate(req: AuthenticatedRequest, res: http.ServerResponse, next: () => void): Promise<void>;
/**
 * Wrapper to use authentication middleware with native http.Server
 * Since we're using raw http module (not Express), we need this helper
 */
export declare function createAuthMiddleware(handler: (req: AuthenticatedRequest, res: http.ServerResponse) => Promise<void>): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
