/**
 * Lemon Squeezy License API client
 * @see https://docs.lemonsqueezy.com/api/license-api
 */

import * as https from 'https';
import * as logger from '../utils/logger';

export interface ValidateLicenseMeta {
  order_id: number | null;
  customer_id: number | null;
  product_id: number | null;
  product_name: string | null;
  variant_id: number | null;
  variant_name: string | null;
  customer_email: string | null;
}

export interface ValidateLicenseKeyInfo {
  id: number;
  status: 'active' | 'inactive' | 'disabled' | 'expired';
  key: string;
  activation_limit: number | null;
  activation_usage: number;
  expires_at: string | null;
}

export interface ValidateLicenseResult {
  valid: boolean;
  error: string | null;
  license_key: ValidateLicenseKeyInfo | null;
  meta: ValidateLicenseMeta | null;
}

export interface ActivateLicenseResult {
  activated: boolean;
  error: string | null;
  license_key: ValidateLicenseKeyInfo | null;
  meta: ValidateLicenseMeta | null;
  instance: { id: string; name: string; created_at: string } | null;
}

const defaultBaseUrl = 'https://api.lemonsqueezy.com';

function postForm(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  apiKey?: string
): Promise<string> {
  const body = new URLSearchParams(params).toString();
  const url = new URL(path, baseUrl);
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  };
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers,
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Lemon Squeezy API ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body, 'utf8');
    req.end();
  });
}

/**
 * Validate a license key with Lemon Squeezy.
 * POST /v1/licenses/validate with license_key (and optional instance_id).
 * If apiKey is provided, sends Authorization: Bearer <apiKey> (recommended for server-side calls).
 */
export async function validateLicenseKey(
  licenseKey: string,
  apiBaseUrl?: string,
  apiKey?: string
): Promise<ValidateLicenseResult> {
  const base = apiBaseUrl || defaultBaseUrl;
  const path = '/v1/licenses/validate';
  try {
    const raw = await postForm(base, path, { license_key: licenseKey }, apiKey);
    const json = JSON.parse(raw) as ValidateLicenseResult;
    logger.debug('Lemon Squeezy validate response', {
      valid: json.valid,
      status: json.license_key?.status,
    });
    return json;
  } catch (error) {
    logger.warn('Lemon Squeezy validate failed', {
      error: String(error),
    });
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
      license_key: null,
      meta: null,
    };
  }
}

/**
 * Activate a license key (create an instance).
 * POST /v1/licenses/activate with license_key and instance_name.
 * If apiKey is provided, sends Authorization: Bearer <apiKey>.
 */
export async function activateLicenseKey(
  licenseKey: string,
  instanceName: string,
  apiBaseUrl?: string,
  apiKey?: string
): Promise<ActivateLicenseResult> {
  const base = apiBaseUrl || defaultBaseUrl;
  const path = '/v1/licenses/activate';
  const raw = await postForm(
    base,
    path,
    { license_key: licenseKey, instance_name: instanceName },
    apiKey
  );
  return JSON.parse(raw) as ActivateLicenseResult;
}
