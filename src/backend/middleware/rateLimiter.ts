/**
 * Rate Limiting Middleware
 *
 * Prevents DoS attacks and API quota exhaustion by limiting requests per IP address.
 * Uses Redis so limits are enforced consistently across horizontally scaled instances.
 */

import * as http from 'http';
import * as logger from '.././utils/logger';
import { getRedisClient } from '../queue/redisClient';
import { getClientIp, isLoopbackAddress } from '../utils/requestMetadata';
import { MissingEnvironmentVariableError } from '../utils/validateEnv';

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

const RATE_LIMIT_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { current, ttl }
`;

interface RateLimitResult {
  count: number;
  retryAfterSeconds: number;
  resetAtIso: string;
}

function getRouteKey(req: http.IncomingMessage): string {
  return req.url?.split('?')[0] || 'unknown';
}

function buildRateLimitKey(ip: string, route: string): string {
  return `rate:${ip}:${route}`;
}

function getRequestId(req: http.IncomingMessage): string | undefined {
  return (req as { requestId?: string }).requestId;
}

function parseRateLimitEvalResult(result: unknown, windowMs: number): RateLimitResult {
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error('Unexpected Redis rate limit response');
  }

  const count = Number(result[0]);
  const ttlMs = Number(result[1]);

  if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
    throw new Error('Invalid Redis rate limit payload');
  }

  const effectiveTtlMs = ttlMs > 0 ? ttlMs : windowMs;
  return {
    count,
    retryAfterSeconds: Math.max(1, Math.ceil(effectiveTtlMs / 1000)),
    resetAtIso: new Date(Date.now() + effectiveTtlMs).toISOString()
  };
}

/**
 * Create rate limiter middleware for specific endpoint
 */
export function createRateLimiter(config: RateLimitConfig) {
  return (req: http.IncomingMessage, res: http.ServerResponse, next: () => void): void => {
    void (async () => {
      const ip = getClientIp(req);
      if (isLoopbackAddress(ip)) {
        next();
        return;
      }
      const route = getRouteKey(req);
      const rateLimitKey = buildRateLimitKey(ip, route);

      try {
        const redis = getRedisClient();
        logger.info('Sending rate limit request to Upstash Redis', {
          ip,
          route,
          key: rateLimitKey,
          windowMs: config.windowMs,
          maxRequests: config.maxRequests
        });
        const evalResult = await redis.eval(
          RATE_LIMIT_SCRIPT,
          [rateLimitKey],
          [config.windowMs.toString()]
        );
        const rateLimit = parseRateLimitEvalResult(evalResult, config.windowMs);
        const remaining = Math.max(0, config.maxRequests - rateLimit.count);

        logger.info('Received rate limit response from Upstash Redis', {
          ip,
          route,
          key: rateLimitKey,
          count: rateLimit.count,
          remaining,
          retryAfterSeconds: rateLimit.retryAfterSeconds
        });

        res.setHeader('X-RateLimit-Limit', config.maxRequests.toString());
        res.setHeader('X-RateLimit-Remaining', remaining.toString());
        res.setHeader('X-RateLimit-Reset', rateLimit.resetAtIso);

        if (rateLimit.count > config.maxRequests) {
          logger.warn('Rate limit exceeded', {
            ip,
            route,
            key: rateLimitKey,
            count: rateLimit.count,
            limit: config.maxRequests,
            retryAfter: rateLimit.retryAfterSeconds
          });

          const errorResponse: RateLimitErrorResponse = {
            error: {
              code: 'RATE_LIMITED',
              message: `${config.message} Please try again in ${rateLimit.retryAfterSeconds} seconds.`,
              statusCode: 429,
              retryAfter: rateLimit.retryAfterSeconds,
              requestId: getRequestId(req),
              timestamp: new Date().toISOString()
            }
          };

          res.setHeader('Retry-After', rateLimit.retryAfterSeconds.toString());
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorResponse));
          return;
        }

        next();
      } catch (error) {
        const requestId = getRequestId(req);

        logger.error('Rate limiter Redis failure', {
          ip,
          route,
          requestId,
          error: error instanceof Error ? error.message : String(error)
        });

        const message = error instanceof MissingEnvironmentVariableError
          ? 'Rate limiting is not configured for this deployment.'
          : 'Rate limiting is temporarily unavailable.';

        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: 'RATE_LIMIT_UNAVAILABLE',
            message,
            statusCode: 503,
            requestId,
            timestamp: new Date().toISOString()
          }
        }));
      }
    })();
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
 * Rate limiter for /api/queue/pr
 * Limit: 20 requests per 10 minutes per IP
 */
export const rateLimitQueuePr = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 20,
  message: 'Too many PR queue requests.'
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
 * Rate limiter for /license/status
 * Limit: 60 requests per minute per IP
 */
export const rateLimitLicenseStatus = createRateLimiter({
  windowMs: 1 * 60 * 1000,
  maxRequests: 60,
  message: 'Too many license status requests.'
});

/**
 * Rate limiter for /license/activate
 * Limit: 20 requests per 10 minutes per IP
 */
export const rateLimitLicenseActivate = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 20,
  message: 'Too many license activation requests.'
});

/**
 * Rate limiter for /webhooks/lemon-squeezy
 * Limit: 200 requests per 10 minutes per IP
 */
export const rateLimitLemonSqueezyWebhook = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 200,
  message: 'Too many webhook requests.'
});

/**
 * Get rate limiter statistics (for monitoring)
 */
export function getRateLimitStats(): {
  totalKeys: number;
  activeIps: Set<string>;
} {
  return {
    totalKeys: 0,
    activeIps: new Set<string>()
  };
}
