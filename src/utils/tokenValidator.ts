/**
 * Azure DevOps OAuth Token Validator
 *
 * Validates Azure DevOps access tokens obtained from SDK.getAccessToken()
 * by making a test API call to Azure DevOps connectionData endpoint.
 *
 * Implements caching to reduce API calls and improve performance.
 */

import * as crypto from 'crypto';
import * as https from 'https';
import * as logger from '../../logger';

/**
 * User identity extracted from validated token
 */
export interface UserIdentity {
  id: string;              // Azure DevOps user ID
  displayName: string;     // User's display name
  email: string | null;    // Email if available
  organization: string;    // Organization URL
}

/**
 * Cache entry for validated tokens
 */
interface CacheEntry {
  identity: UserIdentity;
  expiresAt: number;
}

/**
 * In-memory cache for token validation results
 * Key: SHA-256 hash of token
 * Value: User identity + expiration timestamp
 */
const tokenCache = new Map<string, CacheEntry>();

/**
 * Cache TTL: 5 minutes
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Hash a token using SHA-256
 * We never store raw tokens in cache for security
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Clear expired entries from cache
 * Called periodically to prevent memory leaks
 */
function clearExpiredEntries(): void {
  const now = Date.now();
  let clearedCount = 0;

  for (const [key, entry] of tokenCache.entries()) {
    if (entry.expiresAt < now) {
      tokenCache.delete(key);
      clearedCount++;
    }
  }

  if (clearedCount > 0) {
    logger.debug('Cleared expired token cache entries', { count: clearedCount });
  }
}

/**
 * Background job to clear expired cache entries every 10 minutes
 */
setInterval(clearExpiredEntries, 10 * 60 * 1000);

/**
 * Call Azure DevOps API to validate token and extract user identity
 */
async function callAzureDevOpsApi(token: string, orgUrl: string): Promise<UserIdentity> {
  return new Promise((resolve, reject) => {
    // Parse organization URL
    const url = new URL(orgUrl);
    const apiUrl = `${url.protocol}//${url.host}${url.pathname}/_apis/connectionData?api-version=7.0`;

    logger.debug('Validating token with Azure DevOps API', { apiUrl: apiUrl.replace(/\/\/.*@/, '//***@') });

    const parsedApiUrl = new URL(apiUrl);

    const options = {
      hostname: parsedApiUrl.hostname,
      port: parsedApiUrl.port || 443,
      path: parsedApiUrl.pathname + parsedApiUrl.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const connectionData = JSON.parse(data);

            // Extract user identity from response
            const user = connectionData.authenticatedUser;
            if (!user || !user.id) {
              logger.warn('Invalid connectionData response - missing user identity');
              reject(new Error('Invalid token: missing user identity'));
              return;
            }

            const identity: UserIdentity = {
              id: user.id,
              displayName: user.providerDisplayName || user.displayName || 'Unknown User',
              email: user.descriptor || null,
              organization: orgUrl
            };

            logger.info('Token validated successfully', {
              userId: identity.id,
              displayName: identity.displayName
            });

            resolve(identity);
          } catch (error) {
            logger.error('Failed to parse Azure DevOps API response', { error: String(error) });
            reject(new Error('Invalid token: failed to parse response'));
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          logger.warn('Token validation failed - unauthorized', { statusCode: res.statusCode });
          reject(new Error('Invalid or expired token'));
        } else {
          logger.error('Azure DevOps API error', { statusCode: res.statusCode, body: data });
          reject(new Error(`Azure DevOps API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      logger.error('Failed to connect to Azure DevOps API', { error: String(error) });
      reject(new Error('Failed to validate token: Azure DevOps API unavailable'));
    });

    req.setTimeout(10000, () => {
      req.destroy();
      logger.error('Token validation timeout');
      reject(new Error('Token validation timeout'));
    });

    req.end();
  });
}

/**
 * Validate Azure DevOps OAuth token
 *
 * @param token - Azure DevOps access token from SDK.getAccessToken()
 * @param orgUrl - Expected organization URL (e.g., https://dev.azure.com/myorg)
 * @returns User identity if token is valid
 * @throws Error if token is invalid or validation fails
 */
export async function validateAzureDevOpsToken(
  token: string,
  orgUrl: string
): Promise<UserIdentity> {
  // Check cache first
  const tokenHash = hashToken(token);
  const cached = tokenCache.get(tokenHash);

  if (cached && cached.expiresAt > Date.now()) {
    logger.debug('Token validation cache hit', { userId: cached.identity.id });
    return cached.identity;
  }

  // Cache miss - validate with Azure DevOps API
  logger.debug('Token validation cache miss - calling Azure DevOps API');
  const identity = await callAzureDevOpsApi(token, orgUrl);

  // Store in cache
  tokenCache.set(tokenHash, {
    identity,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  return identity;
}

/**
 * Clear token from cache
 * Useful for testing or forcing re-validation
 */
export function clearTokenCache(token: string): void {
  const tokenHash = hashToken(token);
  tokenCache.delete(tokenHash);
  logger.debug('Token removed from cache');
}

/**
 * Get cache statistics (for monitoring/debugging)
 */
export function getCacheStats(): { size: number; entries: number } {
  return {
    size: tokenCache.size,
    entries: tokenCache.size
  };
}
