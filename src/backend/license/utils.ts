/**
 * License module: shared utility functions
 */

import * as crypto from 'crypto';
import { loadLicenseConfig } from '../config/license-config';

const config = loadLicenseConfig();

/**
 * Hash a license key using SHA-256 with the configured salt.
 * This must be consistent across all license operations to ensure
 * proper matching between activation and webhook flows.
 */
export function hashLicenseKey(key: string): string {
  const salt = config.licenseHashSalt || 'default-salt-change-me';
  return crypto.createHash('sha256').update(key + salt).digest('hex');
}

/**
 * Extract plan name from variant name string.
 * Handles null, undefined, and string inputs.
 */
export function planFromVariant(variantName: string | null | undefined): string {
  if (!variantName || typeof variantName !== 'string') return 'default';
  const lower = variantName.toLowerCase();
  if (lower.includes('pro')) return 'Pro';
  if (lower.includes('team')) return 'Team';
  if (lower.includes('enterprise')) return 'Enterprise';
  return variantName;
}
