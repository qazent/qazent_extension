/**
 * Unit tests for license activation: success and common failure scenarios
 */

process.env.LICENSE_HASH_SALT = 'test-salt';

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as licenseService from '../../src/backend/license/service';
import * as lemonApi from '../../src/backend/license/lemon-api';

jest.mock('../../src/backend/license/lemon-api', () => ({
  validateLicenseKey: jest.fn(),
}));

jest.mock('../../src/backend/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockValidateLicenseKey = lemonApi.validateLicenseKey as jest.MockedFunction<typeof lemonApi.validateLicenseKey>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getLicenseStatus', () => {
  it('returns none when no license for organization', async () => {
    const result = await licenseService.getLicenseStatus('my-org', 'user-1');
    expect(result.status).toBe('none');
    expect(result.planName).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.message).toContain('No license');
  });
});

describe('activateLicense', () => {
  it('returns active when Lemon Squeezy validates and key is valid', async () => {
    mockValidateLicenseKey.mockResolvedValue({
      valid: true,
      error: null,
      license_key: {
        id: 1,
        status: 'active',
        key: 'test-key-uuid',
        activation_limit: 5,
        activation_usage: 0,
        expires_at: '2027-03-12T00:00:00.000Z',
      },
      meta: {
        order_id: 100,
        customer_id: 1,
        product_id: 1,
        product_name: 'PR Assistant',
        variant_id: 1,
        variant_name: 'Pro',
        customer_email: 'test@example.com',
      },
    });

    const result = await licenseService.activateLicense({
      licenseKey: 'test-key-uuid',
      organization: 'my-org',
      userId: 'user-1',
    });

    expect(result.status).toBe('active');
    expect(result.planName).toBe('Pro');
    expect(result.expiresAt).toContain('2027-03-12');
    expect(result.message).toContain('activated');
  });

  it('returns invalid when Lemon Squeezy says key is expired', async () => {
    mockValidateLicenseKey.mockResolvedValue({
      valid: false,
      error: 'License expired',
      license_key: {
        id: 1,
        status: 'expired',
        key: 'expired-key',
        activation_limit: 1,
        activation_usage: 1,
        expires_at: '2020-01-01T00:00:00.000Z',
      },
      meta: null,
    });

    const result = await licenseService.activateLicense({
      licenseKey: 'expired-key',
      organization: 'my-org',
      userId: 'user-1',
    });

    expect(result.status).toBe('invalid');
    expect(result.message).toMatch(/invalid|expired|License expired/);
  });

  it('returns invalid when Lemon Squeezy says key is disabled', async () => {
    mockValidateLicenseKey.mockResolvedValue({
      valid: true,
      error: null,
      license_key: {
        id: 1,
        status: 'disabled',
        key: 'disabled-key',
        activation_limit: 1,
        activation_usage: 0,
        expires_at: null,
      },
      meta: null,
    });

    const result = await licenseService.activateLicense({
      licenseKey: 'disabled-key',
      organization: 'my-org',
      userId: 'user-1',
    });

    expect(result.status).toBe('invalid');
  });

  it('returns invalid when key already assigned to another org', async () => {
    mockValidateLicenseKey.mockResolvedValue({
      valid: true,
      error: null,
      license_key: {
        id: 1,
        status: 'active',
        key: 'shared-key',
        activation_limit: 10,
        activation_usage: 1,
        expires_at: '2027-03-12T00:00:00.000Z',
      },
      meta: {
        order_id: 100,
        customer_id: 1,
        product_id: 1,
        product_name: 'PR Assistant',
        variant_id: 1,
        variant_name: 'Pro',
        customer_email: 'test@example.com',
      },
    });

    await licenseService.activateLicense({
      licenseKey: 'shared-key',
      organization: 'first-org',
      userId: 'user-1',
    });

    const result = await licenseService.activateLicense({
      licenseKey: 'shared-key',
      organization: 'other-org',
      userId: 'user-2',
    });

    expect(result.status).toBe('invalid');
    expect(result.message).toContain('another');
  });
});
