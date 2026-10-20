/**
 * @jest-environment node
 */

import { EventEmitter } from 'events';

jest.mock('../../src/backend/utils/logger', () => {
  const actual = jest.requireActual<typeof import('../../src/backend/utils/logger')>(
    '../../src/backend/utils/logger'
  );
  return {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    runWithLabels: actual.runWithLabels,
    setLabels: actual.setLabels,
    getLabels: actual.getLabels,
    Events: actual.Events,
  };
});

describe('backend server startup and shutdown lifecycle', () => {
  let fakeServer: EventEmitter & {
    listen: jest.Mock;
    close: jest.Mock;
  };
  let createServerMock: jest.Mock;
  let loadSystemPromptMock: jest.Mock;
  let processOnSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let handlers: Record<string, (...args: unknown[]) => void>;

  async function importServerExpectingExit(code?: number) {
    await expect(import('../../src/backend/server')).rejects.toThrow(`process.exit:${code}`);
  }

  beforeEach(() => {
    jest.resetModules();
    handlers = {};

    fakeServer = Object.assign(new EventEmitter(), {
      listen: jest.fn((_: number, __: string, callback?: () => void) => {
        callback?.();
        return fakeServer;
      }),
      close: jest.fn((callback?: () => void) => {
        callback?.();
        return fakeServer;
      }),
    });

    createServerMock = jest.fn().mockReturnValue(fakeServer);
    loadSystemPromptMock = jest.fn();

    jest.doMock('http', () => {
      const actual = jest.requireActual('http') as typeof import('http');
      return {
        ...actual,
        createServer: createServerMock,
      };
    });

    jest.doMock('../../src/backend/ai', () => ({
      loadSystemPrompt: loadSystemPromptMock,
    }));

    jest.doMock('../../src/backend/fetchPRdiff', () => ({
      fetchPRDiff: jest.fn(),
    }));

    jest.doMock('../../src/backend/ado-client', () => ({
      createConnection: jest.fn(),
      createTaskWorkItem: jest.fn(),
      postPRComment: jest.fn(),
      postPRInlineComments: jest.fn(),
    }));

    jest.doMock('../../src/backend/middleware/authenticate', () => ({
      createAuthMiddleware: jest.fn((handler: unknown) => handler),
    }));

    jest.doMock('../../src/backend/middleware/rateLimiter', () => ({
      rateLimitGenerateTests: jest.fn((_: unknown, __: unknown, next: () => void) => next()),
      rateLimitCreateWorkItem: jest.fn((_: unknown, __: unknown, next: () => void) => next()),
      rateLimitPostPRComment: jest.fn((_: unknown, __: unknown, next: () => void) => next()),
      rateLimitPostPRInlineComments: jest.fn((_: unknown, __: unknown, next: () => void) => next()),
      rateLimitExtractPurposeScope: jest.fn((_: unknown, __: unknown, next: () => void) => next()),
      rateLimitHealth: jest.fn((_: unknown, __: unknown, next: () => void) => next()),
      rateLimitLicenseStatus: jest.fn((_: unknown, __: unknown, next: () => void) => next()),
      rateLimitLicenseActivate: jest.fn((_: unknown, __: unknown, next: () => void) => next()),
      rateLimitLemonSqueezyWebhook: jest.fn((_: unknown, __: unknown, next: () => void) => next()),
    }));

    jest.doMock('../../src/backend/license/routes', () => ({
      handleLicenseStatus: jest.fn(),
      handleLicenseActivate: jest.fn(),
      handleLemonSqueezyWebhook: jest.fn(),
    }));

    jest.doMock('dotenv', () => ({
      config: jest.fn(),
    }));

    processOnSpy = jest.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
      return process;
    }) as typeof process.on);

    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    process.env.PORT = '0';
    process.env.NODE_ENV = 'test';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete process.env.GEMINI_API_KEY;
  });

  it('exits early when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;

    await importServerExpectingExit(1);

    expect(createServerMock).not.toHaveBeenCalled();
    expect(loadSystemPromptMock).not.toHaveBeenCalled();
  });

  it('exits when loading the system prompt fails', async () => {
    loadSystemPromptMock.mockImplementation(() => {
      throw new Error('prompt load failed');
    });

    await importServerExpectingExit(1);

    expect(createServerMock).not.toHaveBeenCalled();
    expect(loadSystemPromptMock).toHaveBeenCalledTimes(1);
  });

  it('registers graceful shutdown handlers and closes the server on SIGTERM', async () => {
    await import('../../src/backend/server');

    expect(typeof handlers.SIGTERM).toBe('function');
    expect(typeof handlers.SIGINT).toBe('function');
    expect(typeof handlers.error).toBe('undefined');

    expect(() => handlers.SIGTERM()).toThrow('process.exit:0');
    expect(fakeServer.close).toHaveBeenCalledTimes(1);
  });

  it('closes the server on SIGINT', async () => {
    await import('../../src/backend/server');

    expect(() => handlers.SIGINT()).toThrow('process.exit:0');
    expect(fakeServer.close).toHaveBeenCalledTimes(1);
  });

  it('exits when the server emits an error event', async () => {
    await import('../../src/backend/server');

    expect(() => fakeServer.emit('error', new Error('bind failure'))).toThrow('process.exit:1');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
