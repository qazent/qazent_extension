/**
 * Lemon Squeezy webhook handler: signature verification and event → license model mapping
 * @see https://docs.lemonsqueezy.com/help/webhooks/signing-requests
 */

import * as crypto from 'crypto';
import * as logger from '../utils/logger';
import { loadLicenseConfig, isLicenseConfigReadyForWebhooks } from '../config/license-config';
import { getDefaultLicenseStore, createLicenseRecord } from './model';
import { hashLicenseKey, planFromVariant } from './utils';
import type { LicenseRecord, LicenseStatus } from './types';
import type { IncomingMessage } from 'http';

const config = loadLicenseConfig();

const processedEvents = new Set<string>();
const MAX_PROCESSED_SIZE = 10_000;

function eventId(meta: { event_name?: string }, data: { id?: string }): string {
  return `${meta?.event_name ?? 'unknown'}:${data?.id ?? 'no-id'}`;
}

function isProcessed(id: string): boolean {
  return processedEvents.has(id);
}

function markProcessed(id: string): void {
  processedEvents.add(id);
  if (processedEvents.size > MAX_PROCESSED_SIZE) {
    const first = processedEvents.values().next().value;
    if (first) processedEvents.delete(first);
  }
}

export function verifySignature(rawBody: string, signature: string | undefined): boolean {
  const secret = config.lemonSqueezyWebhookSecret;
  if (!secret || !signature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const digest = hmac.digest('hex');
  try {
    const sigBuf = Buffer.from(signature, 'utf8');
    const digBuf = Buffer.from(digest, 'utf8');
    if (sigBuf.length !== digBuf.length) return false;
    return crypto.timingSafeEqual(digBuf, sigBuf);
  } catch {
    return false;
  }
}

export interface WebhookResult {
  statusCode: number;
  body?: Record<string, unknown>;
}

export async function processWebhook(
  req: IncomingMessage,
  rawBody: string
): Promise<WebhookResult> {
  if (!isLicenseConfigReadyForWebhooks(config)) {
    logger.warn('Lemon Squeezy webhook received but webhook secret not configured');
    return { statusCode: 503, body: { error: 'Webhook not configured' } };
  }

  const signature = req.headers['x-signature'] as string | undefined;
  if (!verifySignature(rawBody, signature)) {
    logger.warn('Lemon Squeezy webhook signature verification failed');
    return { statusCode: 401, body: { error: 'Invalid signature' } };
  }

  let payload: { meta?: { event_name?: string }; data?: { type?: string; id?: string; attributes?: Record<string, unknown> } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: { error: 'Invalid JSON' } };
  }

  const meta = payload.meta ?? {};
  const data = payload.data ?? {};
  const eventName = meta.event_name;
  const id = eventId(meta, data);

  if (isProcessed(id)) {
    logger.debug('Lemon Squeezy webhook idempotent skip', { eventName, id });
    return { statusCode: 200, body: { received: true } };
  }

  const store = getDefaultLicenseStore();
  const attrs = data.attributes ?? {};

  try {
    if (data.type === 'license-keys' && (eventName === 'license_key_created' || eventName === 'license_key_updated')) {
      await handleLicenseKeyEvent(store, data.id as string, attrs);
    } else if (data.type === 'orders') {
      if (eventName === 'order_created') {
        await handleOrderCreated(store, data.id as string, attrs);
      } else if (eventName === 'order_refunded') {
        await handleOrderRefunded(store, attrs);
      }
    } else if (data.type === 'subscriptions') {
      if (
        eventName === 'subscription_created' ||
        eventName === 'subscription_updated' ||
        eventName === 'subscription_resumed'
      ) {
        await handleSubscriptionActive(store, attrs);
      } else if (
        eventName === 'subscription_expired' ||
        eventName === 'subscription_cancelled' ||
        eventName === 'subscription_payment_failed'
      ) {
        await handleSubscriptionInactive(store, attrs);
      }
    }
  } catch (error) {
    logger.error('Lemon Squeezy webhook processing error', { eventName, error: String(error) });
    return { statusCode: 500, body: { error: 'Processing failed' } };
  }

  markProcessed(id);
  return { statusCode: 200, body: { received: true } };
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function handleLicenseKeyEvent(
  store: ReturnType<typeof getDefaultLicenseStore>,
  lemonId: string,
  attrs: Record<string, unknown>
): Promise<void> {
  const key = attrs.key as string | undefined;
  const status = attrs.status as string | undefined;
  const activationLimit = attrs.activation_limit as number | null | undefined;
  const expiresAt = parseDate(attrs.expires_at);
  if (!key) return;
  const keyHash = hashLicenseKey(key);
  const existing = await store.findByLicenseHash(keyHash);
  const statusMap: Record<string, LicenseStatus> = {
    active: 'active',
    inactive: 'active',
    disabled: 'suspended',
    expired: 'expired',
  };
  const ourStatus = statusMap[status ?? ''] ?? 'active';
  const record = createLicenseRecord({
    id: existing?.id,
    licenseKeyHash: keyHash,
    lemonLicenseId: typeof attrs.id === 'number' ? attrs.id : null,
    lemonOrderId: null,
    lemonCustomerId: null,
    organization: existing?.organization ?? '',
    status: ourStatus,
    plan: 'default',
    seatsUsed: existing?.seatsUsed ?? 0,
    seatsLimit: activationLimit ?? null,
    expiresAt,
  });
  await store.upsert(record);
  logger.info('License key event processed', { event: 'license_key', lemonId, status: ourStatus });
}

async function handleOrderCreated(
  store: ReturnType<typeof getDefaultLicenseStore>,
  _orderId: string,
  attrs: Record<string, unknown>
): Promise<void> {
  const orderId = attrs.id ?? attrs.order_id;
  const firstOrderItem = attrs.first_order_item as Record<string, unknown> | undefined;
  const productId = attrs.product_id ?? firstOrderItem?.product_id;
  const variantId = attrs.variant_id ?? firstOrderItem?.variant_id;
  const productName = (attrs.product_name as string) ?? (firstOrderItem?.product_name as string);
  const variantName = (attrs.variant_name as string) ?? (firstOrderItem?.variant_name as string);
  const licenseKey = attrs.license_key as Record<string, unknown> | undefined;
  const key = licenseKey?.key as string | undefined;
  if (!key) return;
  const keyHash = hashLicenseKey(key);
  const existing = await store.findByLicenseHash(keyHash);
  const plan = planFromVariant(variantName);
  const record = createLicenseRecord({
    id: existing?.id,
    licenseKeyHash: keyHash,
    lemonLicenseId: typeof licenseKey?.id === 'number' ? licenseKey.id : null,
    lemonOrderId: typeof orderId === 'number' ? orderId : null,
    lemonCustomerId: typeof attrs.customer_id === 'number' ? attrs.customer_id : null,
    organization: existing?.organization ?? '',
    status: 'active',
    plan,
    seatsUsed: existing?.seatsUsed ?? 0,
    seatsLimit: typeof licenseKey?.activation_limit === 'number' ? licenseKey.activation_limit : null,
    expiresAt: parseDate(licenseKey?.expires_at),
  });
  await store.upsert(record);
  logger.info('Order created processed', { orderId, productId, variantId, productName });
}

async function handleOrderRefunded(
  store: ReturnType<typeof getDefaultLicenseStore>,
  attrs: Record<string, unknown>
): Promise<void> {
  const orderId = attrs.id ?? attrs.order_id;
  const records = await findRecordsByOrderId(store, orderId);
  for (const r of records) {
    await store.update(r.id, { status: 'suspended' });
  }
  logger.info('Order refunded processed', { orderId, updated: records.length });
}

async function findRecordsByOrderId(
  store: ReturnType<typeof getDefaultLicenseStore>,
  orderId: unknown
): Promise<LicenseRecord[]> {
  const id = typeof orderId === 'number' ? orderId : null;
  if (id == null) return [];
  return store.findByLemonOrderId(id);
}

async function handleSubscriptionActive(
  store: ReturnType<typeof getDefaultLicenseStore>,
  attrs: Record<string, unknown>
): Promise<void> {
  const renewsAt = parseDate(attrs.renews_at);
  const endsAt = parseDate(attrs.ends_at);
  const productName = attrs.product_name as string | undefined;
  const variantName = attrs.variant_name as string | undefined;
  const plan = planFromVariant(variantName);
  const orderId = attrs.order_id;
  const records = await findRecordsByOrderId(store, orderId);
  const expiresAt = endsAt ?? renewsAt;
  for (const r of records) {
    await store.update(r.id, {
      status: 'active',
      plan,
      expiresAt,
    });
  }
  if (records.length === 0) {
    logger.debug('Subscription active: no local license record for order', { orderId, productName });
  } else {
    logger.info('Subscription active processed', { orderId, plan, expiresAt });
  }
}

async function handleSubscriptionInactive(
  store: ReturnType<typeof getDefaultLicenseStore>,
  attrs: Record<string, unknown>
): Promise<void> {
  const orderId = attrs.order_id;
  const records = await findRecordsByOrderId(store, orderId);
  for (const r of records) {
    await store.update(r.id, { status: 'expired' });
  }
  logger.info('Subscription inactive processed', { orderId, updated: records.length });
}
