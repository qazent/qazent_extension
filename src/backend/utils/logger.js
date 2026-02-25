"use strict";
/**
 * Structured JSON logging utility with safety guards
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogEntry = createLogEntry;
exports.writeLog = writeLog;
exports.info = info;
exports.warn = warn;
exports.error = error;
exports.debug = debug;
/**
 * Maximum allowed size for context JSON before redaction
 */
const MAX_CONTEXT_LENGTH = 100_000; // 100 KB
const MAX_FIELD_LENGTH = 20_000; // 20 KB per field
/**
 * Sanitizes context to prevent leaking DOM, window, VSS config, or huge blobs.
 */
function sanitizeContext(context) {
    if (!context)
        return undefined;
    const safe = {};
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
        }
        catch {
            safe[key] = '[REDACTED: Unserializable object]';
        }
    }
    return safe;
}
/**
 * Create a log entry
 */
function createLogEntry(level, message, context) {
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
function writeLog(entry) {
    try {
        const output = JSON.stringify(entry);
        if (entry.level === 'error' || entry.level === 'warn') {
            process.stderr.write(output + '\n');
        }
        else {
            process.stdout.write(output + '\n');
        }
    }
    catch {
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
function info(message, context) {
    writeLog(createLogEntry('info', message, context));
}
/**
 * Log warning level message
 */
function warn(message, context) {
    writeLog(createLogEntry('warn', message, context));
}
/**
 * Log error level message
 */
function error(message, context) {
    writeLog(createLogEntry('error', message, context));
}
/**
 * Log debug level message (only if DEBUG=true)
 */
function debug(message, context) {
    if (process.env.DEBUG === 'true') {
        writeLog(createLogEntry('debug', message, context));
    }
}
//# sourceMappingURL=logger.js.map