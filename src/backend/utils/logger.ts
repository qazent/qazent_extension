/**
 * Structured JSON logger with Prometheus-style flat labels and async request context.
 *
 * Every log line is a flat JSON object so BetterStack / Datadog / Loki can index
 * each label as a filterable field. Standard top-level labels:
 *
 *   service     - constant per process (default: "qazent-api")
 *   env         - process.env.NODE_ENV
 *   event       - stable enum-like identifier (see `Events`)
 *   requestId   - propagated automatically inside runWithLabels
 *   method      - HTTP method (request scope)
 *   route       - request path without query (request scope) or worker route
 *   userId      - authenticated user (request scope, set after auth)
 *   org         - Azure DevOps organization name (request scope, set after auth)
 *   status      - HTTP status code (request.complete only)
 *   durationMs  - request/job duration (request.complete / job.completed)
 *
 * Anything else passed via `context` stays nested under the `context` key.
 *
 * Tracing: requestId is generated once at the HTTP boundary and stored in
 * AsyncLocalStorage so every downstream logger.* call inside the same request
 * automatically carries it. Filter `requestId:req_xxx` in BetterStack to get
 * the full trace for one request.
 *
 * Example filters:
 *   event:request.complete AND status:>=400      all failed requests
 *   requestId:req_1779...                          full trace for one request
 *   userId:7e4aeed8-... AND event:generate_tests   user's AI calls
 */

import { AsyncLocalStorage } from 'async_hooks';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * Labels that propagate automatically through AsyncLocalStorage for the
 * duration of one request / job.
 */
export interface RequestLabels {
  requestId?: string;
  method?: string;
  route?: string;
  userId?: string;
  org?: string;
}

/**
 * Stable event vocabulary. Prefer adding a new constant here over inventing
 * one-off strings at call sites so BetterStack filters stay predictable.
 */
export const Events = {
  REQUEST_START: 'request.start',
  REQUEST_COMPLETE: 'request.complete',
  REQUEST_FAILED: 'request.failed',
  AUTH_SUCCESS: 'auth.success',
  AUTH_FAILURE: 'auth.failure',
  RATELIMIT_EXCEEDED: 'ratelimit.exceeded',
  RATELIMIT_ERROR: 'ratelimit.error',
  CORS_BLOCKED: 'cors.blocked',
  LICENSE_CHECK: 'license.check',
  LICENSE_ACTIVATE: 'license.activate',
  LICENSE_WEBHOOK: 'license.webhook',
  GENERATE_TESTS: 'generate_tests',
  CREATE_WORK_ITEM: 'create_work_item',
  POST_PR_COMMENT: 'post_pr_comment',
  POST_PR_INLINE_COMMENTS: 'post_pr_inline_comments',
  EXTRACT_PURPOSE_SCOPE: 'extract_purpose_scope',
  QUEUE_PR_ENQUEUE: 'queue.pr.enqueue',
  AI_GENERATE_START: 'ai.generate.start',
  AI_GENERATE_COMPLETE: 'ai.generate.complete',
  JOB_DEQUEUED: 'job.dequeued',
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_RETRIED: 'job.retried',
  JOB_DLQ: 'job.dlq',
  JOB_LOCKED: 'job.locked',
  JOB_LOCK_LOST: 'job.lock_lost',
  STARTUP: 'startup',
  SHUTDOWN: 'shutdown'
} as const;

export type EventName = (typeof Events)[keyof typeof Events] | string;

const SERVICE_NAME = process.env.SERVICE_NAME ?? 'qazent-api';
const ENVIRONMENT = process.env.NODE_ENV ?? 'unknown';

/**
 * Labels that get lifted from `context` to the top level so they are indexed
 * as filterable fields rather than nested under `context.*`.
 */
const TOP_LEVEL_LABEL_KEYS = new Set<string>([
  'event',
  'requestId',
  'method',
  'route',
  'userId',
  'org',
  'status',
  'durationMs'
]);

/**
 * Async-local store for per-request labels. The HTTP server (and worker)
 * call `runWithLabels({...}, fn)` to populate it; any logger.* call inside
 * that callback chain auto-merges the labels.
 */
const requestContext = new AsyncLocalStorage<RequestLabels>();

/**
 * Run `fn` inside an async context where logger.* calls auto-include the
 * provided labels. Labels can be extended mid-flight via setLabels().
 */
export function runWithLabels<T>(labels: RequestLabels, fn: () => T): T {
  // Clone so callers can't mutate the original after the fact.
  return requestContext.run({ ...labels }, fn);
}

/**
 * Extend the labels for the active request context. No-op if called outside
 * a runWithLabels scope.
 */
export function setLabels(updates: Partial<RequestLabels>): void {
  const current = requestContext.getStore();
  if (!current) return;
  Object.assign(current, updates);
}

/**
 * Read the current request labels (for tests / handlers that need the id).
 */
export function getLabels(): RequestLabels | undefined {
  return requestContext.getStore();
}

const MAX_CONTEXT_LENGTH = 100_000; // 100 KB
const MAX_FIELD_LENGTH = 20_000;    // 20 KB per field

/**
 * Keys we redact unconditionally. Kept as exact (case-insensitive) matches
 * so harmless keys like `windowMs`, `customContext`, `configPath` survive.
 */
const REDACTED_DOM_KEYS = new Set(['window', 'document']);
const REDACTED_VSS_KEYS = new Set([
  'vss',
  'vssconfig',
  'vsscontext',
  'webcontext',
  'extensioncontext'
]);

function sanitizeContext(
  context?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!context) return undefined;

  const safe: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    const lowered = key.toLowerCase();

    if (REDACTED_DOM_KEYS.has(lowered)) {
      safe[key] = '[REDACTED: DOM object]';
      continue;
    }

    if (REDACTED_VSS_KEYS.has(lowered)) {
      safe[key] = '[REDACTED: VSS configuration]';
      continue;
    }

    if (typeof value === 'string' && value.length > MAX_CONTEXT_LENGTH) {
      safe[key] = '[REDACTED: Large string content]';
      continue;
    }

    if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
      safe[key] = '[REDACTED: Large field content]';
      continue;
    }

    try {
      const json = JSON.stringify(value);
      if (json && json.length > MAX_CONTEXT_LENGTH) {
        safe[key] = '[REDACTED: Large object]';
        continue;
      }
      safe[key] = value;
    } catch {
      safe[key] = '[REDACTED: Unserializable object]';
    }
  }

  return safe;
}

/**
 * Build a flat log entry. Known label keys are lifted to top level; the rest
 * stays under `context`.
 */
function buildEntry(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }),
    level,
    service: SERVICE_NAME,
    env: ENVIRONMENT
  };

  // Ambient request-scoped labels (requestId, method, route, userId, org).
  const ambient = requestContext.getStore();
  if (ambient) {
    for (const [k, v] of Object.entries(ambient)) {
      if (v !== undefined && v !== null) entry[k] = v;
    }
  }

  entry.message = message;

  const sanitized = sanitizeContext(context);
  if (sanitized) {
    const remaining: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sanitized)) {
      if (v === undefined) continue;
      if (TOP_LEVEL_LABEL_KEYS.has(k)) {
        // Lift known label to top level (overrides ambient if explicitly set).
        entry[k] = v;
      } else {
        remaining[k] = v;
      }
    }
    if (Object.keys(remaining).length > 0) {
      entry.context = remaining;
    }
  }

  return entry;
}

function writeEntry(entry: Record<string, unknown>): void {
  try {
    const output = JSON.stringify(entry);
    if (entry.level === 'error' || entry.level === 'warn') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  } catch {
    const fallback = {
      timestamp: entry.timestamp,
      level: entry.level,
      service: SERVICE_NAME,
      env: ENVIRONMENT,
      message: entry.message,
      context: '[REDACTED: Failed to serialize context]'
    };
    process.stderr.write(JSON.stringify(fallback) + '\n');
  }
}

export function info(message: string, context?: Record<string, unknown>): void {
  writeEntry(buildEntry('info', message, context));
}

export function warn(message: string, context?: Record<string, unknown>): void {
  writeEntry(buildEntry('warn', message, context));
}

export function error(message: string, context?: Record<string, unknown>): void {
  writeEntry(buildEntry('error', message, context));
}

export function debug(message: string, context?: Record<string, unknown>): void {
  if (process.env.DEBUG === 'true') {
    writeEntry(buildEntry('debug', message, context));
  }
}
