/**
 * Shared license helpers: hashing and plan mapping.
 * Used by both service (activation) and webhook-handler so key hashes and plan names stay consistent.
 */

import * as crypto from 'crypto';
import { loadLicenseConfig } from '../config/license-config';

const config = loadLicenseConfig();

/**
 * Hash a license key with the configured salt. Never store raw keys.
 * Same implementation used for activation and webhook-created records.
 */
export function hashLicenseKey(key: string): string {
  const salt = config.licenseHashSalt || 'default-salt-change-me';
  return crypto.createHash('sha256').update(key + salt).digest('hex');
}

/**
 * Map Lemon Squeezy variant name to internal plan label.
 */
export function planFromVariant(variantName: string | null | undefined): string {
  if (!variantName || typeof variantName !== 'string') return 'default';
  const lower = variantName.toLowerCase();
  if (lower.includes('pro')) return 'Pro';
  if (lower.includes('team')) return 'Team';
  if (lower.includes('enterprise')) return 'Enterprise';
  return variantName;
}
