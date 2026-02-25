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
 * Create a log entry
 */
export declare function createLogEntry(level: LogLevel, message: string, context?: Record<string, unknown>): LogEntry;
/**
 * Write log entry to appropriate stream
 */
export declare function writeLog(entry: LogEntry): void;
/**
 * Log info level message
 */
export declare function info(message: string, context?: Record<string, unknown>): void;
/**
 * Log warning level message
 */
export declare function warn(message: string, context?: Record<string, unknown>): void;
/**
 * Log error level message
 */
export declare function error(message: string, context?: Record<string, unknown>): void;
/**
 * Log debug level message (only if DEBUG=true)
 */
export declare function debug(message: string, context?: Record<string, unknown>): void;
export {};
