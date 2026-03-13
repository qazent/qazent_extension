/**
 * License module: HTTP handlers for /license/status, /license/activate, and /webhooks/lemon-squeezy
 * Used by the main server; no Express dependency.
 */

import * as http from 'http';
import type { AuthenticatedRequest } from '../middleware/authenticate';
import * as licenseService from './service';
import * as webhookHandler from './webhook-handler';
import * as logger from '../utils/logger';

export interface LicenseRoutesOptions {
  handleWebhook: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
}

/**
 * GET /license/status?organization=...&userId=...
 * Responds with LicenseStatusResponse. Organization and userId are taken from authenticated request context.
 */
export async function handleLicenseStatus(
  req: AuthenticatedRequest,
  res: http.ServerResponse
): Promise<void> {
  try {
    const organization = req.orgUrl ? extractOrgName(req.orgUrl) : undefined;
    const userId = req.user?.id;
    if (!organization || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'none',
          planName: null,
          expiresAt: null,
          message: 'Missing organization or user context.',
        })
      );
      return;
    }
    const result = await licenseService.getLicenseStatus(organization, userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    logger.error('License status failed', {
      error: String(error),
      requestId: req.requestId,
    });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'none',
        planName: null,
        expiresAt: null,
        message: 'Failed to retrieve license status.',
      })
    );
  }
}

/**
 * POST /license/activate
 * Body: LicenseActivateRequest. Organization and userId are overridden from authenticated context.
 */
export async function handleLicenseActivate(
  req: AuthenticatedRequest,
  res: http.ServerResponse,
  body: string
): Promise<void> {
  try {
    const payload = JSON.parse(body) as { licenseKey?: string; organization?: string; userId?: string };
    const organization = req.orgUrl ? extractOrgName(req.orgUrl) : undefined;
    const userId = req.user?.id;
    if (!organization || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'invalid',
          message: 'Missing organization or user context.',
        })
      );
      return;
    }
    const licenseKey =
      typeof payload.licenseKey === 'string' ? payload.licenseKey.trim() : '';
    if (!licenseKey || licenseKey.length < 10) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'invalid',
          message: 'A valid license key is required.',
        })
      );
      return;
    }
    const result = await licenseService.activateLicense({
      licenseKey,
      organization,
      userId,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    logger.error('License activate failed', {
      error: String(error),
      requestId: req.requestId,
    });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'invalid',
        message: 'Activation request failed. Please try again.',
      })
    );
  }
}

/**
 * POST /webhooks/lemon-squeezy
 * Raw body must be passed for signature verification. No auth middleware.
 */
export async function handleLemonSqueezyWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string
): Promise<void> {
  try {
    const result = await webhookHandler.processWebhook(req, rawBody);
    res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body ?? {}));
  } catch (error) {
    logger.error('Lemon Squeezy webhook failed', { error: String(error) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Webhook processing failed' }));
  }
}

function extractOrgName(orgUrl: string): string {
  const url = new URL(orgUrl);
  if (url.hostname === 'dev.azure.com') {
    return url.pathname.split('/').filter(Boolean)[0] ?? orgUrl;
  }
  if (url.hostname.endsWith('.visualstudio.com')) {
    return url.hostname.split('.')[0] ?? orgUrl;
  }
  return orgUrl;
}
