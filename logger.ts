/**
 * Structured JSON logging utility with safety guards
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Maximum allowed size for context JSON before redaction
 */
const MAX_CONTEXT_LENGTH = 100_000; // 100 KB

const MAX_FIELD_LENGTH = 20_000; // 20 KB per field
/**
 * Sanitizes context to prevent leaking DOM, window, VSS config, or huge blobs.
 */
function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return undefined;

  const safe: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    // Prevent DOM/window leaks
    if (key.toLowerCase().includes('window') || key.toLowerCase().includes('document')) {
      safe[key] = '[REDACTED: DOM object]';
      continue;
    }

    // Prevent VSS config leaks
    if (key.toLowerCase().includes('vss') || key.toLowerCase().includes('config')) {
      safe[key] = '[REDACTED: VSS configuration]';
      continue;
    }

    // Prevent logging entire HTML pages
    if (typeof value === 'string' && value.length > MAX_CONTEXT_LENGTH) {
      safe[key] = '[REDACTED: Large string content]';
      continue;
    }

    // Prevent logging huge fields (like fetch responses, DOM nodes, etc.)
    if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
      safe[key] = '[REDACTED: Large field content]';
      continue;
    }
    try {
      const json = JSON.stringify(value);
      if (json.length > MAX_CONTEXT_LENGTH) {
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
 * Create a log entry
 */
export function createLogEntry(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): LogEntry {
  return {
    timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }),
    level,
    message,
    context: sanitizeContext(context)
  };
}

/**
 * Write log entry to appropriate stream
 */
export function writeLog(entry: LogEntry): void {
  try {
    const output = JSON.stringify(entry);
    if (entry.level === 'error' || entry.level === 'warn') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  } catch {
    // Fallback if JSON serialization fails
    const fallback = {
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      context: '[REDACTED: Failed to serialize context]'
    };
    process.stderr.write(JSON.stringify(fallback) + '\n');
  }
}

/**
 * Log info level message
 */
export function info(message: string, context?: Record<string, unknown>): void {
  writeLog(createLogEntry('info', message, context));
}

/**
 * Log warning level message
 */
export function warn(message: string, context?: Record<string, unknown>): void {
  writeLog(createLogEntry('warn', message, context));
}

/**
 * Log error level message
 */
export function error(message: string, context?: Record<string, unknown>): void {
  writeLog(createLogEntry('error', message, context));
}

/**
 * Log debug level message (only if DEBUG=true)
 */
export function debug(message: string, context?: Record<string, unknown>): void {
  if (process.env.DEBUG === 'true') {
    writeLog(createLogEntry('debug', message, context));
  }
}