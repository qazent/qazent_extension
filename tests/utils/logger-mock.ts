/**
 * Shared logger mock for tests.
 * Use with: jest.mock('../src/backend/utils/logger', () => createLoggerMock())
 *
 * Mocks the four log methods (info/debug/warn/error) but keeps the real
 * AsyncLocalStorage-based label helpers (runWithLabels/setLabels/getLabels)
 * and the Events catalog so production code paths that depend on them still
 * work under the mock.
 *
 * We resolve the real logger lazily via jest.requireActual inside the factory
 * (rather than a top-level `import`) so this module stays safe to call from
 * the jest.mock factory, which Jest hoists above all imports in test files.
 */

export function createLoggerMock() {
  const actualLogger = jest.requireActual<typeof import('../../src/backend/utils/logger')>(
    '../../src/backend/utils/logger'
  );
  return {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    runWithLabels: actualLogger.runWithLabels,
    setLabels: actualLogger.setLabels,
    getLabels: actualLogger.getLabels,
    Events: actualLogger.Events,
  };
}
