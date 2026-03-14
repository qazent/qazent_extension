/**
 * @jest-environment node
 */

import { EventEmitter, once } from 'events';
import * as http from 'http';
import * as https from 'https';

jest.mock('http', () => {
  const actual = jest.requireActual('http') as typeof import('http');
  let lastServer: import('http').Server | undefined;

  return {
    ...actual,
    createServer: jest.fn((handler: Parameters<typeof actual.createServer>[0]) => {
      lastServer = actual.createServer(handler);
      return lastServer;
    }),
    __getLastServer: () => lastServer,
  };
});

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

jest.mock('../../src/backend/ai', () => ({
  loadSystemPrompt: jest.fn(),
  generateTestCases: jest.fn().mockResolvedValue({
    title: 'Generated test cases',
    htmlDescription: '<p>Generated body</p>',
    compressionReport: { truncatedFiles: 0 },
  }),
  extractPurposeAndScope: jest.fn().mockReturnValue({
    purpose: 'Verify backend behavior',
    scope: 'Server middleware path',
  }),
}));

jest.mock('../../src/backend/fetchPRdiff', () => ({
  fetchPRDiff: jest.fn().mockResolvedValue({
    changes: [
      {
        filePath: 'src/example.ts',
        changeType: 'edit',
        linesAdded: 3,
        linesDeleted: 1,
        diffContent: '@@ diff @@',
      },
    ],
    totalChanges: 1,
    sourceCommitId: 'source-commit',
    targetCommitId: 'target-commit',
  }),
}));

jest.mock('../../src/backend/ado-client', () => ({
  createConnection: jest.fn().mockReturnValue({ kind: 'mock-connection' }),
  createTaskWorkItem: jest.fn().mockResolvedValue(77),
  postPRComment: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/backend/license/service', () => ({
  getLicenseStatus: jest.fn().mockResolvedValue({
    status: 'active',
    planName: 'Pro',
    expiresAt: '2027-03-12T00:00:00.000Z',
    message: 'License is active.',
  }),
  activateLicense: jest.fn().mockResolvedValue({
    status: 'active',
    planName: 'Pro',
    expiresAt: '2027-03-12T00:00:00.000Z',
    message: 'License activated.',
  }),
}));

jest.mock('../../src/backend/license/webhook-handler', () => ({
  processWebhook: jest.fn().mockResolvedValue({
    statusCode: 202,
    body: { received: true },
  }),
}));

function createJwtLikeToken(): string {
  return `${'a'.repeat(220)}.${'b'.repeat(220)}.${'c'.repeat(220)}`;
}

function mockAzureDevOpsIdentity() {
  return (https.request as jest.Mock).mockImplementation(((_options: unknown, callback: (res: EventEmitter & { statusCode?: number; statusText?: string }) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
      end: jest.Mock;
    };

    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    req.end = jest.fn(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode?: number; statusText?: string };
      res.statusCode = 200;
      res.statusText = 'OK';

      process.nextTick(() => {
        callback(res);
        res.emit(
          'data',
          JSON.stringify({
            authenticatedUser: {
              id: 'user-1',
              providerDisplayName: 'Test User',
              descriptor: 'user@example.com',
            },
          })
        );
        res.emit('end');
      });
    });

    return req as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request);
}

async function requestJson(
  port: number,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

describe('backend server request path', () => {
  let server: import('http').Server;
  let port: number;
  let setIntervalSpy: jest.SpyInstance;
  let httpsRequestSpy: jest.Mock;

  beforeAll(async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';

    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as NodeJS.Timeout);
    httpsRequestSpy = https.request as jest.Mock;
    mockAzureDevOpsIdentity();

    await import('../../src/backend/server');

    server = (http as typeof http & { __getLastServer?: () => import('http').Server }).__getLastServer!();
    if (!server.listening) {
      await once(server, 'listening');
    }

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on an ephemeral TCP port');
    }
    port = address.port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    httpsRequestSpy.mockReset();
    setIntervalSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAzureDevOpsIdentity();
  });

  it('serves the public health endpoint without authentication', async () => {
    const response = await requestJson(port, '/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'healthy',
      })
    );
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects protected requests that omit the Authorization header', async () => {
    const response = await requestJson(port, '/generate-tests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ado-org-url': 'https://dev.azure.com/myorg',
        'x-forwarded-for': '198.51.100.10',
      },
      body: JSON.stringify({
        prId: 101,
        projectName: 'MyProject',
        repositoryId: 'repo-123',
      }),
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'UNAUTHORIZED',
        }),
      })
    );
  });

  it('rejects invalid content types before the middleware stack runs', async () => {
    const response = await requestJson(port, '/generate-tests', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${createJwtLikeToken()}`,
        'x-ado-org-url': 'https://dev.azure.com/myorg',
        'x-forwarded-for': '198.51.100.11',
      },
      body: 'plain text',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Invalid content type',
      details: 'Expected application/json',
    });
  });

  it('runs the full generate-tests request path through auth and routing', async () => {
    const response = await requestJson(port, '/generate-tests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${createJwtLikeToken()}`,
        'x-ado-org-url': 'https://dev.azure.com/myorg',
        'x-forwarded-for': '198.51.100.12',
      },
      body: JSON.stringify({
        prId: 123,
        projectName: 'MyProject',
        repositoryId: 'repo-123',
        branchName: 'feature/backend-tests',
        customContext: 'Verify raw HTTP integration behavior.',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      title: 'Generated test cases',
      htmlDescription: '<p>Generated body</p>',
      sourceCommitId: 'source-commit',
      targetCommitId: 'target-commit',
      compressionReport: { truncatedFiles: 0 },
    });

    const { fetchPRDiff } = await import('../../src/backend/fetchPRdiff');
    expect(fetchPRDiff).toHaveBeenCalledWith(
      'MyProject',
      'repo-123',
      123,
      expect.any(Object),
      'myorg',
      expect.any(String)
    );
    expect(httpsRequestSpy).toHaveBeenCalled();
  });

  it('enforces the generate-tests rate limit on repeated requests from the same IP', async () => {
    const headers = {
      'content-type': 'application/json',
      'x-ado-org-url': 'https://dev.azure.com/myorg',
      'x-forwarded-for': '198.51.100.13',
    };

    for (let index = 0; index < 10; index += 1) {
      const response = await requestJson(port, '/generate-tests', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prId: 200 + index,
          projectName: 'MyProject',
          repositoryId: 'repo-123',
        }),
      });
      expect(response.status).toBe(401);
    }

    const blocked = await requestJson(port, '/generate-tests', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prId: 999,
        projectName: 'MyProject',
        repositoryId: 'repo-123',
      }),
    });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(blocked.body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'RATE_LIMITED',
        }),
      })
    );
  });

  it('routes authenticated license status requests through the request context', async () => {
    const response = await requestJson(port, '/license/status?organization=ignored', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${createJwtLikeToken()}`,
        'x-ado-org-url': 'https://dev.azure.com/myorg',
        'x-forwarded-for': '198.51.100.14',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'active',
      planName: 'Pro',
      expiresAt: '2027-03-12T00:00:00.000Z',
      message: 'License is active.',
    });

    const { getLicenseStatus } = await import('../../src/backend/license/service');
    expect(getLicenseStatus).toHaveBeenCalledWith('myorg', 'user-1');
  });

  it('preserves the raw activate body for the authenticated license endpoint', async () => {
    const response = await requestJson(port, '/license/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${createJwtLikeToken()}`,
        'x-ado-org-url': 'https://dev.azure.com/myorg',
        'x-forwarded-for': '198.51.100.15',
      },
      body: JSON.stringify({
        licenseKey: 'license-key-12345',
        organization: 'ignored-client-value',
        userId: 'ignored-user-value',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'active',
      planName: 'Pro',
      expiresAt: '2027-03-12T00:00:00.000Z',
      message: 'License activated.',
    });

    const { activateLicense } = await import('../../src/backend/license/service');
    expect(activateLicense).toHaveBeenCalledWith({
      licenseKey: 'license-key-12345',
      organization: 'myorg',
      userId: 'user-1',
    });
  });

  it('passes the unparsed webhook body to the Lemon Squeezy route', async () => {
    const rawBody = JSON.stringify({
      meta: { event_name: 'subscription_created' },
      data: { type: 'subscriptions', id: 'sub-1' },
    });

    const response = await requestJson(port, '/webhooks/lemon-squeezy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.16',
      },
      body: rawBody,
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ received: true });

    const { processWebhook } = await import('../../src/backend/license/webhook-handler');
    expect(processWebhook).toHaveBeenCalledWith(expect.anything(), rawBody);
  });
});
