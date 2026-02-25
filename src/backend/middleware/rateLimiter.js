"use strict";
/**
 * Rate Limiting Middleware
 *
 * Prevents DoS attacks and API quota exhaustion by limiting requests per IP address.
 * Uses in-memory store for simplicity (suitable for single-instance deployments).
 *
 * For multi-instance production deployments, consider using Redis store.
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
exports.rateLimitHealth = exports.rateLimitWebhook = exports.rateLimitPostPRComment = exports.rateLimitCreateWorkItem = exports.rateLimitGenerateTests = void 0;
exports.createRateLimiter = createRateLimiter;
exports.getRateLimitStats = getRateLimitStats;
const logger = __importStar(require("@logger"));
/**
 * In-memory store for request counts per IP
 * Key format: "ip:endpoint"
 */
const requestStore = new Map();
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
function getClientIp(req) {
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
function createRateLimiter(config) {
    return (req, res, next) => {
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
            const errorResponse = {
                error: {
                    code: 'RATE_LIMITED',
                    message: `${config.message} Please try again in ${retryAfter} seconds.`,
                    statusCode: 429,
                    retryAfter,
                    requestId: req.requestId,
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
exports.rateLimitGenerateTests = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 10,
    message: 'Too many test generation requests.'
});
/**
 * Rate limiter for /create-work-item
 * Limit: 20 requests per 10 minutes per IP
 */
exports.rateLimitCreateWorkItem = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 20,
    message: 'Too many work item creation requests.'
});
/**
 * Rate limiter for /post-pr-comment
 * Limit: 20 requests per 10 minutes per IP
 */
exports.rateLimitPostPRComment = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 20,
    message: 'Too many PR comment requests.'
});
/**
 * Rate limiter for /webhook
 * Limit: 100 requests per 10 minutes per IP
 */
exports.rateLimitWebhook = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 100,
    message: 'Too many webhook requests.'
});
/**
 * Rate limiter for /health (public endpoint, but still rate limited)
 * Limit: 60 requests per 1 minute per IP
 */
exports.rateLimitHealth = createRateLimiter({
    windowMs: 1 * 60 * 1000,
    maxRequests: 60,
    message: 'Too many health check requests.'
});
/**
 * Get rate limiter statistics (for monitoring)
 */
function getRateLimitStats() {
    const activeIps = new Set();
    for (const key of requestStore.keys()) {
        const ip = key.split(':')[0];
        activeIps.add(ip);
    }
    return {
        totalKeys: requestStore.size,
        activeIps
    };
}
//# sourceMappingURL=rateLimiter.js.map