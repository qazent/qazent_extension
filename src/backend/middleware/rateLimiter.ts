/**
 * Rate Limiting Middleware
 *
 * Prevents DoS attacks and API quota exhaustion by limiting requests per IP address.
 * Uses in-memory store for simplicity (suitable for single-instance deployments).
 *
 * For multi-instance production deployments, consider using Redis store.
 */

import * as http from 'http';
import * as logger from '.././utils/logger';

/**
 * Rate limit configuration
 */
interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Maximum requests per window
  message: string;       // Error message
}

/**
 * Request tracking entry
 */
interface RequestTracker {
  count: number;
  resetTime: number;
}

/**
 * In-memory store for request counts per IP
 * Key format: "ip:endpoint"
 */
const requestStore = new Map<string, RequestTracker>();

/**
 * Standard rate limit error response
 */
interface RateLimitErrorResponse {
  error: {
    code: string;
    message: string;
    statusCode: number;
    retryAfter: number;
    requestId?: string;
    timestamp: string;
  };
}

/**
 * Clean up expired entries every 10 minutes to prevent memory leaks
 */
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, tracker] of requestStore.entries()) {
    if (tracker.resetTime < now) {
      requestStore.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug('Cleaned expired rate limit entries', { count: cleaned });
  }
}, 10 * 60 * 1000);

/**
 * Get client IP address from request
 */
function getClientIp(req: http.IncomingMessage): string {
  // Check X-Forwarded-For header first (for proxies/load balancers)
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    return ips.split(',')[0].trim();
  }

  // Fall back to socket address
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Create rate limiter middleware for specific endpoint
 */
export function createRateLimiter(config: RateLimitConfig) {
  return (req: http.IncomingMessage, res: http.ServerResponse, next: () => void): void => {
    const ip = getClientIp(req);
    const endpoint = req.url || 'unknown';
    const key = `${ip}:${endpoint}`;
    const now = Date.now();

    // Get or create tracker for this IP+endpoint
    let tracker = requestStore.get(key);

    // Reset if window expired
    if (!tracker || tracker.resetTime < now) {
      tracker = {
        count: 0,
        resetTime: now + config.windowMs
      };
      requestStore.set(key, tracker);
    }

    // Increment request count
    tracker.count++;

    // Check if limit exceeded
    if (tracker.count > config.maxRequests) {
      const retryAfter = Math.ceil((tracker.resetTime - now) / 1000);

      logger.warn('Rate limit exceeded', {
        ip,
        endpoint,
        count: tracker.count,
        limit: config.maxRequests,
        retryAfter
      });

      const errorResponse: RateLimitErrorResponse = {
        error: {
          code: 'RATE_LIMITED',
          message: `${config.message} Please try again in ${retryAfter} seconds.`,
          statusCode: 429,
          retryAfter,
          requestId: (req as any).requestId,
          timestamp: new Date().toISOString()
        }
      };

      res.setHeader('Retry-After', retryAfter.toString());
      res.setHeader('X-RateLimit-Limit', config.maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', new Date(tracker.resetTime).toISOString());
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResponse));
      return;
    }

    // Add rate limit headers
    const remaining = config.maxRequests - tracker.count;
    res.setHeader('X-RateLimit-Limit', config.maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', remaining.toString());
    res.setHeader('X-RateLimit-Reset', new Date(tracker.resetTime).toISOString());

    // Continue to next handler
    next();
  };
}

/**
 * Pre-configured rate limiters for each endpoint
 */

/**
 * Rate limiter for /generate-tests (most expensive - calls AI API)
 * Limit: 10 requests per 10 minutes per IP
 */
export const rateLimitGenerateTests = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 10,
  message: 'Too many test generation requests.'
});

/**
 * Rate limiter for /create-work-item
 * Limit: 20 requests per 10 minutes per IP
 */
export const rateLimitCreateWorkItem = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 20,
  message: 'Too many work item creation requests.'
});

/**
 * Rate limiter for /post-pr-comment
 * Limit: 20 requests per 10 minutes per IP
 */
export const rateLimitPostPRComment = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 20,
  message: 'Too many PR comment requests.'
});

// --- POST PR LABEL VAULTED ---
// export const rateLimitPostPRLabel = createRateLimiter({
//   windowMs: 10 * 60 * 1000,
//   maxRequests: 20,
//   message: 'Too many PR label requests.'
// });

/**
 * Rate limiter for /api/extract-purpose-scope
 * Limit: 20 requests per 10 minutes per IP
 */
export const rateLimitExtractPurposeScope = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 20,
  message: 'Too many extract-purpose-scope requests.'
});

/**
 * Rate limiter for /webhook
 * Limit: 100 requests per 10 minutes per IP
 */
export const rateLimitWebhook = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 100,
  message: 'Too many webhook requests.'
});

/**
 * Rate limiter for /health (public endpoint, but still rate limited)
 * Limit: 60 requests per 1 minute per IP
 */
export const rateLimitHealth = createRateLimiter({
  windowMs: 1 * 60 * 1000,
  maxRequests: 60,
  message: 'Too many health check requests.'
});

/**
 * Get rate limiter statistics (for monitoring)
 */
export function getRateLimitStats(): {
  totalKeys: number;
  activeIps: Set<string>;
} {
  const activeIps = new Set<string>();

  for (const key of requestStore.keys()) {
    const ip = key.split(':')[0];
    activeIps.add(ip);
  }

  return {
    totalKeys: requestStore.size,
    activeIps
  };
}
