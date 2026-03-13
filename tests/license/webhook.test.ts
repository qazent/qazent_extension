/**
 * Unit tests for Lemon Squeezy webhook handler: signature verification and event handling
 */

import * as crypto from 'crypto';
import { describe, it, expect, beforeEach } from '@jest/globals';

const SECRET = 'test-webhook-secret';
process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = SECRET;
process.env.LICENSE_HASH_SALT = 'test-salt';

import {
  verifySignature,
  processWebhook,
} from '../../src/backend/license/webhook-handler';

jest.mock('../../src/backend/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createMockReq(signature: string): import('http').IncomingMessage {
  return {
    headers: { 'x-signature': signature },
  } as unknown as import('http').IncomingMessage;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('verifySignature', () => {
  it('returns true when signature matches', () => {
    const body = '{"meta":{"event_name":"subscription_created"},"data":{}}';
    const sig = sign(body, SECRET);
    expect(verifySignature(body, sig)).toBe(true);
  });

  it('returns false when signature is wrong', () => {
    const body = '{"meta":{"event_name":"subscription_created"}}';
    const sig = sign(body, 'wrong-secret');
    expect(verifySignature(body, sig)).toBe(false);
  });

  it('returns false when signature is missing', () => {
    expect(verifySignature('{}', undefined)).toBe(false);
  });
});

describe('processWebhook', () => {
  it('returns 401 when signature is invalid', async () => {
    const body = JSON.stringify({
      meta: { event_name: 'subscription_created' },
      data: { type: 'subscriptions', id: '1', attributes: {} },
    });
    const req = createMockReq('invalid-sig');
    const result = await processWebhook(req, body);
    expect(result.statusCode).toBe(401);
    expect(result.body?.error).toContain('signature');
  });

  it('returns 200 and processes subscription_created (idempotent second call)', async () => {
    const payload = {
      meta: { event_name: 'subscription_created' },
      data: {
        type: 'subscriptions',
        id: '1',
        attributes: {
          order_id: 100,
          status: 'active',
          renews_at: '2027-03-12T00:00:00.000Z',
          ends_at: null,
          product_name: 'PR Assistant',
          variant_name: 'Pro',
        },
      },
    };
    const body = JSON.stringify(payload);
    const req = createMockReq(sign(body, SECRET));

    const first = await processWebhook(req, body);
    expect(first.statusCode).toBe(200);

    const second = await processWebhook(req, body);
    expect(second.statusCode).toBe(200);
  });

  it('returns 200 for subscription_expired and marks license expired', async () => {
    const payload = {
      meta: { event_name: 'subscription_expired' },
      data: {
        type: 'subscriptions',
        id: '2',
        attributes: {
          order_id: 101,
          status: 'expired',
        },
      },
    };
    const body = JSON.stringify(payload);
    const req = createMockReq(sign(body, SECRET));
    const result = await processWebhook(req, body);
    expect(result.statusCode).toBe(200);
  });

  it('returns 200 for order_refunded', async () => {
    const payload = {
      meta: { event_name: 'order_refunded' },
      data: {
        type: 'orders',
        id: '200',
        attributes: {
          id: 200,
          order_id: 200,
        },
      },
    };
    const body = JSON.stringify(payload);
    const req = createMockReq(sign(body, SECRET));
    const result = await processWebhook(req, body);
    expect(result.statusCode).toBe(200);
  });

  it('returns 200 for license_key_created', async () => {
    const key = 'test-license-key-uuid-12345';
    const payload = {
      meta: { event_name: 'license_key_created' },
      data: {
        type: 'license-keys',
        id: '1',
        attributes: {
          id: 1,
          key,
          status: 'active',
          activation_limit: 5,
          expires_at: '2027-03-12T00:00:00.000Z',
        },
      },
    };
    const body = JSON.stringify(payload);
    const req = createMockReq(sign(body, SECRET));
    const result = await processWebhook(req, body);
    expect(result.statusCode).toBe(200);
  });
});
