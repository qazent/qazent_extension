/**
 * @jest-environment node
 */

import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';
import { createRedisTestClient, RedisTestClient } from '../utils/redis-test-client';

jest.mock('https', () => {
  const actual = jest.requireActual('https') as typeof import('https');
  return {
    ...actual,
    request: jest.fn(),
  };
});

jest.mock('../../src/backend/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

let redis: RedisTestClient;

jest.mock('../../src/backend/queue/redisClient', () => ({
  getRedisClient: jest.fn(() => redis)
}));

type AuthenticatedRequestModule = typeof import('../../src/backend/middleware/authenticate');
type RateLimiterModule = typeof import('../../src/backend/middleware/rateLimiter');
type TokenValidatorModule = typeof import('../../src/backend/utils/tokenValidator');

function createJwtLikeToken(): string {
  return `${'a'.repeat(220)}.${'b'.repeat(220)}.${'c'.repeat(220)}`;
}

function createMockResponse() {
  let statusCode = 200;
  let body = '';
  const headers = new Map<string, string>();

  const res = {
    setHeader: jest.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    }),
    writeHead: jest.fn((status: number, extraHeaders?: Record<string, string>) => {
      statusCode = status;
      if (extraHeaders) {
        for (const [name, value] of Object.entries(extraHeaders)) {
          headers.set(name.toLowerCase(), value);
        }
      }
      return res as unknown as http.ServerResponse;
    }),
    end: jest.fn((chunk?: string) => {
      body = chunk ?? '';
      return res as unknown as http.ServerResponse;
    }),
  } as unknown as http.ServerResponse;

  return {
    res,
    getStatusCode: () => statusCode,
    getBody: () => (body ? JSON.parse(body) : null),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  };
}

function mockAzureDevOpsResponse(statusCode: number, payload: unknown) {
  return (https.request as jest.Mock).mockImplementation(((_options: unknown, callback: (res: EventEmitter & { statusCode?: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
      end: jest.Mock;
    };

    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    req.end = jest.fn(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode?: number };
      res.statusCode = statusCode;

      process.nextTick(() => {
        callback(res);
        res.emit('data', JSON.stringify(payload));
        res.emit('end');
      });
    });

    return req as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request);
}

async function invokeMiddleware(
  middleware: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: jest.Mock
): Promise<void> {
  await new Promise<void>((resolve) => {
    const wrappedNext = () => {
      next();
      resolve();
    };

    middleware(req, res, wrappedNext);
    setImmediate(() => resolve());
  });
}

describe('authentication, token validation, and rate limiting', () => {
  let authenticateModule: AuthenticatedRequestModule;
  let rateLimiterModule: RateLimiterModule;
  let tokenValidatorModule: TokenValidatorModule;
  let setIntervalSpy: jest.SpyInstance;

  beforeAll(async () => {
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as NodeJS.Timeout);

    authenticateModule = await import('../../src/backend/middleware/authenticate');
    rateLimiterModule = await import('../../src/backend/middleware/rateLimiter');
    tokenValidatorModule = await import('../../src/backend/utils/tokenValidator');
  });

  afterAll(() => {
    setIntervalSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    redis = createRedisTestClient();
  });

  it('validates OAuth-style tokens and reuses the cache on the second check', async () => {
    const token = createJwtLikeToken();
    const httpsSpy = https.request as jest.Mock;
    mockAzureDevOpsResponse(200, {
      authenticatedUser: {
        id: 'user-1',
        providerDisplayName: 'Test User',
        descriptor: 'user@example.com',
      },
    });

    const first = await tokenValidatorModule.validateAzureDevOpsToken(token, 'https://dev.azure.com/myorg');
    const second = await tokenValidatorModule.validateAzureDevOpsToken(token, 'https://dev.azure.com/myorg');

    expect(first).toEqual({
      id: 'user-1',
      displayName: 'Test User',
      email: 'user@example.com',
      organization: 'https://dev.azure.com/myorg',
    });
    expect(second).toEqual(first);
    expect(httpsSpy).toHaveBeenCalledTimes(1);

    tokenValidatorModule.clearTokenCache(token);
    httpsSpy.mockReset();
  });

  it('rejects non-JWT tokens before calling Azure DevOps', async () => {
    await expect(
      tokenValidatorModule.validateAzureDevOpsToken('short-token', 'https://dev.azure.com/myorg')
    ).rejects.toThrow(/expected OAuth JWT/i);
  });

  it('maps Azure DevOps 401 responses to invalid or expired token errors', async () => {
    const token = createJwtLikeToken();
    const httpsSpy = https.request as jest.Mock;
    mockAzureDevOpsResponse(401, { message: 'Unauthorized' });

    await expect(
      tokenValidatorModule.validateAzureDevOpsToken(token, 'https://dev.azure.com/myorg')
    ).rejects.toThrow('Invalid or expired token');

    httpsSpy.mockReset();
  });

  it('rejects requests that are missing the organization header', async () => {
    const { res, getStatusCode, getBody } = createMockResponse();
    const req = {
      headers: {
        authorization: `Bearer ${createJwtLikeToken()}`,
      },
      method: 'POST',
      url: '/generate-tests',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as import('../../src/backend/middleware/authenticate').AuthenticatedRequest;

    const next = jest.fn();

    await authenticateModule.authenticate(req, res, next);

    expect(getStatusCode()).toBe(400);
    expect(getBody()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
          message: 'Missing X-Ado-Org-Url header',
        }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS organization URLs before token validation', async () => {
    const { res, getStatusCode, getBody } = createMockResponse();
    const req = {
      headers: {
        authorization: `Bearer ${createJwtLikeToken()}`,
        'x-ado-org-url': 'http://dev.azure.com/myorg',
      },
      method: 'POST',
      url: '/generate-tests',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as import('../../src/backend/middleware/authenticate').AuthenticatedRequest;

    const next = jest.fn();

    await authenticateModule.authenticate(req, res, next);

    expect(getStatusCode()).toBe(400);
    expect(getBody()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
          message: 'Organization URL must use HTTPS',
        }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches the authenticated user and request context on success', async () => {
    const httpsSpy = https.request as jest.Mock;
    mockAzureDevOpsResponse(200, {
      authenticatedUser: {
        id: 'user-2',
        providerDisplayName: 'Authorized User',
        descriptor: 'authorized@example.com',
      },
    });

    const { res, getStatusCode } = createMockResponse();
    const req = {
      headers: {
        authorization: `Bearer ${createJwtLikeToken()}`,
        'x-ado-org-url': 'https://dev.azure.com/myorg',
      },
      method: 'POST',
      url: '/generate-tests',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as import('../../src/backend/middleware/authenticate').AuthenticatedRequest;

    const next = jest.fn();

    await authenticateModule.authenticate(req, res, next);

    expect(getStatusCode()).toBe(200);
    expect(req.user).toEqual({
      id: 'user-2',
      displayName: 'Authorized User',
      email: 'authorized@example.com',
      organization: 'https://dev.azure.com/myorg',
    });
    expect(req.orgUrl).toBe('https://dev.azure.com/myorg');
    expect(req.requestId).toMatch(/^req_/);
    expect(next).toHaveBeenCalledTimes(1);

    httpsSpy.mockReset();
  });

  it('blocks requests when a rate limit is exceeded and sets retry headers', async () => {
    const limiter = rateLimiterModule.createRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      message: 'Too many requests.',
    });

    const req = {
      headers: {},
      url: '/generate-tests',
      socket: { remoteAddress: '203.0.113.20' },
    } as unknown as http.IncomingMessage;

    const first = createMockResponse();
    const second = createMockResponse();
    const third = createMockResponse();
    const next = jest.fn();

    await invokeMiddleware(limiter, req, first.res, next);
    await invokeMiddleware(limiter, req, second.res, next);
    await invokeMiddleware(limiter, req, third.res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(first.getHeader('x-ratelimit-remaining')).toBe('1');
    expect(second.getHeader('x-ratelimit-remaining')).toBe('0');
    expect(third.getStatusCode()).toBe(429);
    expect(third.getHeader('retry-after')).toBeTruthy();
    expect(third.getBody()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'RATE_LIMITED',
          statusCode: 429,
        }),
      })
    );
  });
});
