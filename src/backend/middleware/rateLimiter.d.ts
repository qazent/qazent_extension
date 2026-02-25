/**
 * Rate Limiting Middleware
 *
 * Prevents DoS attacks and API quota exhaustion by limiting requests per IP address.
 * Uses in-memory store for simplicity (suitable for single-instance deployments).
 *
 * For multi-instance production deployments, consider using Redis store.
 */
import * as http from 'http';
/**
 * Rate limit configuration
 */
interface RateLimitConfig {
    windowMs: number;
    maxRequests: number;
    message: string;
}
/**
 * Create rate limiter middleware for specific endpoint
 */
export declare function createRateLimiter(config: RateLimitConfig): (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
/**
 * Pre-configured rate limiters for each endpoint
 */
/**
 * Rate limiter for /generate-tests (most expensive - calls AI API)
 * Limit: 10 requests per 10 minutes per IP
 */
export declare const rateLimitGenerateTests: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
/**
 * Rate limiter for /create-work-item
 * Limit: 20 requests per 10 minutes per IP
 */
export declare const rateLimitCreateWorkItem: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
/**
 * Rate limiter for /post-pr-comment
 * Limit: 20 requests per 10 minutes per IP
 */
export declare const rateLimitPostPRComment: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
/**
 * Rate limiter for /webhook
 * Limit: 100 requests per 10 minutes per IP
 */
export declare const rateLimitWebhook: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
/**
 * Rate limiter for /health (public endpoint, but still rate limited)
 * Limit: 60 requests per 1 minute per IP
 */
export declare const rateLimitHealth: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
/**
 * Get rate limiter statistics (for monitoring)
 */
export declare function getRateLimitStats(): {
    totalKeys: number;
    activeIps: Set<string>;
};
export {};
