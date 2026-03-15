/**
 * License module: core business logic for status, activation, and seat enforcement
 */

import * as logger from '../utils/logger';
import { loadLicenseConfig, isLicenseConfigReadyForActivation } from '../config/license-config';
import { validateLicenseKey } from './lemon-api';
import { getDefaultLicenseStore, createLicenseRecord, createSeatAssignment } from './model';
import { hashLicenseKey, planFromVariant } from './utils';
import type {
  LicenseStatus,
  LicenseStatusResponse,
  LicenseActivateRequest,
  LicenseActivateResponse,
  LicenseRecord,
} from './types';

const config = loadLicenseConfig();

/**
 * Compute effective status for display (grace period, suspended, etc.)
 */
function effectiveStatus(record: LicenseRecord): LicenseStatus {
  if (record.status === 'suspended' || record.status === 'invalid') return record.status;
  if (record.status === 'expired') return 'expired';
  if (record.expiresAt && config.expiryGraceDays > 0) {
    const graceEnd = new Date(record.expiresAt);
    graceEnd.setDate(graceEnd.getDate() + config.expiryGraceDays);
    if (new Date() > graceEnd) return 'expired';
  } else if (record.expiresAt && new Date() > record.expiresAt) {
    return 'expired';
  }
  return record.status;
}

function statusMessage(status: LicenseStatus, planName: string | null, expiresAt: Date | null): string {
  switch (status) {
    case 'active':
      return expiresAt
        ? `Your ${planName || 'license'} is active until ${expiresAt.toISOString().slice(0, 10)}.`
        : `Your ${planName || 'license'} is active.`;
    case 'expired':
      return 'This license has expired. Please renew to continue using the extension.';
    case 'suspended':
      return 'This license has been suspended. Please contact support.';
    case 'invalid':
      return 'This license key is invalid, expired, or already assigned to another organization.';
    case 'none':
    default:
      return 'No license found for this organization. Enter a license key to activate.';
  }
}

export async function getLicenseStatus(
  organization: string,
  _userId: string
): Promise<LicenseStatusResponse> {
  const store = getDefaultLicenseStore();
  const record = await store.findByOrg(organization);
  if (!record) {
    return {
      status: 'none',
      planName: null,
      expiresAt: null,
      message: statusMessage('none', null, null),
    };
  }
  const status = effectiveStatus(record);
  return {
    status,
    planName: record.plan || null,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    message: statusMessage(status, record.plan, record.expiresAt),
  };
}

export async function activateLicense(
  request: LicenseActivateRequest
): Promise<LicenseActivateResponse> {
  if (!isLicenseConfigReadyForActivation(config)) {
    return {
      status: 'invalid',
      planName: null,
      expiresAt: null,
      message: 'License service is not configured. Please contact support.',
    };
  }

  const store = getDefaultLicenseStore();
  const normalizedKey = request.licenseKey.trim();
  const keyHash = hashLicenseKey(normalizedKey);

  logger.info('License activation attempt', {
    organization: request.organization,
    userId: request.userId,
    keyHashPrefix: keyHash.slice(0, 8) + '...',
  });

  const validation = await validateLicenseKey(
    normalizedKey,
    config.lemonSqueezyLicenseApiUrl,
    config.lemonSqueezyApiKey || undefined
  );

  if (!validation.valid || !validation.license_key) {
    return {
      status: 'invalid',
      planName: null,
      expiresAt: null,
      message: validation.error || 'This license key is invalid, expired, or already assigned to another organization.',
    };
  }

  const lk = validation.license_key;
  if (lk.status === 'disabled' || lk.status === 'expired') {
    return {
      status: 'invalid',
      planName: null,
      expiresAt: null,
      message: 'This license key is invalid, expired, or already assigned to another organization.',
    };
  }

  let existingByHash = await store.findByLicenseHash(keyHash);
  const storedOrganization = existingByHash?.organization?.trim() ?? '';

  if (existingByHash && storedOrganization === '') {
    existingByHash = await store.bindOrganization(existingByHash.id, request.organization);
  } else if (existingByHash && storedOrganization !== request.organization) {
    return {
      status: 'invalid',
      planName: null,
      expiresAt: null,
      message: 'License key is already assigned to another Azure DevOps organization.',
    };
  }

  const seatsLimit =
    lk.activation_limit != null
      ? lk.activation_limit
      : config.defaultSeatsPerKey;
  const seatsList = existingByHash ? await store.listSeats(existingByHash.id) : [];
  const orgSeats = seatsList.filter(s => s.organization === request.organization);
  const alreadyAssigned = orgSeats.some(s => s.userId === request.userId);

  if (!alreadyAssigned && orgSeats.length >= seatsLimit) {
    return {
      status: 'invalid',
      planName: null,
      expiresAt: null,
      message: 'License seat limit reached for this organization. Please upgrade or contact support.',
    };
  }

  const plan = planFromVariant(validation.meta?.variant_name ?? null);
  const expiresAt = lk.expires_at ? new Date(lk.expires_at) : null;

  const record: LicenseRecord = createLicenseRecord({
    id: existingByHash?.id,
    licenseKeyHash: keyHash,
    lemonLicenseId: lk.id,
    lemonOrderId: validation.meta?.order_id ?? null,
    lemonCustomerId: validation.meta?.customer_id ?? null,
    organization: request.organization,
    status: 'active',
    plan,
    seatsUsed: existingByHash ? existingByHash.seatsUsed : 0,
    seatsLimit: seatsLimit,
    expiresAt,
  });

  await store.upsert(record);

  if (!alreadyAssigned) {
    const seat = createSeatAssignment(record.id, request.organization, request.userId);
    await store.addSeat(seat);
    await store.update(record.id, { seatsUsed: orgSeats.length + 1 });
  }

  logger.info('License activated', {
    organization: request.organization,
    userId: request.userId,
    plan,
    licenseId: record.id,
  });

  return {
    status: 'active',
    planName: plan,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    message: 'License activated for this organization.',
  };
}
