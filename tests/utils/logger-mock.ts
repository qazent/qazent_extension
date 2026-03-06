/**
 * Shared logger mock for tests.
 * Use with: jest.mock('../src/backend/utils/logger', () => createLoggerMock())
 */

export function createLoggerMock() {
  return {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };
}
