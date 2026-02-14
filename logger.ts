/**
 * Structured JSON logging utility with sensitive data filtering
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

const SENSITIVE_KEYS = ['password', 'token', 'secret', 'apikey', 'pat', 'key'];

/**
 * Check if a key name contains sensitive information
 */
function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_KEYS.some(sensitive => lowerKey.includes(sensitive));
}

/**
 * Recursively filter sensitive data from objects
 */
function filterSensitiveData(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => filterSensitiveData(item));
  }

  if (typeof obj === 'object') {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        filtered[key] = '[REDACTED]';
      } else {
        filtered[key] = filterSensitiveData(value);
      }
    }
    return filtered;
  }

  return obj;
}

/**
 * Create a log entry
 */
function createLogEntry(level: LogLevel, message: string, context?: Record<string, unknown>): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message
  };

  if (context) {
    entry.context = filterSensitiveData(context) as Record<string, unknown>;
  }

  return entry;
}

/**
 * Write log entry to appropriate stream
 */
function writeLog(entry: LogEntry): void {
  const output = JSON.stringify(entry);

  if (entry.level === 'error' || entry.level === 'warn') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

/**
 * Log info level message
 */
export function info(message: string, context?: Record<string, unknown>): void {
  const entry = createLogEntry('info', message, context);
  writeLog(entry);
}

/**
 * Log warning level message
 */
export function warn(message: string, context?: Record<string, unknown>): void {
  const entry = createLogEntry('warn', message, context);
  writeLog(entry);
}

/**
 * Log error level message
 */
export function error(message: string, context?: Record<string, unknown>): void {
  const entry = createLogEntry('error', message, context);
  writeLog(entry);
}

/**
 * Log debug level message (only if DEBUG=true)
 */
export function debug(message: string, context?: Record<string, unknown>): void {
  if (process.env.DEBUG === 'true') {
    const entry = createLogEntry('debug', message, context);
    writeLog(entry);
  }
}
