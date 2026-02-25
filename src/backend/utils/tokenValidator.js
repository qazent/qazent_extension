"use strict";
/**
 * Azure DevOps OAuth Token Validator
 *
 * Validates Azure DevOps access tokens obtained from SDK.getAccessToken()
 * by making a test API call to Azure DevOps connectionData endpoint.
 *
 * Implements caching to reduce API calls and improve performance.
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
exports.validateAzureDevOpsToken = validateAzureDevOpsToken;
exports.clearTokenCache = clearTokenCache;
exports.getCacheStats = getCacheStats;
const crypto = __importStar(require("crypto"));
const https = __importStar(require("https"));
const logger = __importStar(require("./logger"));
/**
 * In-memory cache for token validation results
 * Key: SHA-256 hash of token
 * Value: User identity + expiration timestamp
 */
const tokenCache = new Map();
/**
 * Cache TTL: 5 minutes
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Hash a token using SHA-256
 * We never store raw tokens in cache for security
 */
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}
/**
 * Clear expired entries from cache
 * Called periodically to prevent memory leaks
 */
function clearExpiredEntries() {
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
async function callAzureDevOpsApi(token, orgUrl) {
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
                        const identity = {
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
                    }
                    catch (error) {
                        logger.error('Failed to parse Azure DevOps API response', { error: String(error) });
                        reject(new Error('Invalid token: failed to parse response'));
                    }
                }
                else if (res.statusCode === 401 || res.statusCode === 403) {
                    logger.warn('Token validation failed - unauthorized', { statusCode: res.statusCode });
                    reject(new Error('Invalid or expired token'));
                }
                else {
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
async function validateAzureDevOpsToken(token, orgUrl) {
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
function clearTokenCache(token) {
    const tokenHash = hashToken(token);
    tokenCache.delete(tokenHash);
    logger.debug('Token removed from cache');
}
/**
 * Get cache statistics (for monitoring/debugging)
 */
function getCacheStats() {
    return {
        size: tokenCache.size,
        entries: tokenCache.size
    };
}
//# sourceMappingURL=tokenValidator.js.map