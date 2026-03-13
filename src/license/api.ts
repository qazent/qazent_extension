/**
 * License API client for the extension
 * Calls backend /license/status and /license/activate with Azure DevOps token and org URL
 */

import * as SDK from 'azure-devops-extension-sdk';
import { CommonServiceIds, ILocationService } from 'azure-devops-extension-api';

export interface LicenseStatusResponse {
  status: 'active' | 'expired' | 'none' | 'invalid' | 'suspended';
  planName: string | null;
  expiresAt: string | null;
  message: string;
}

export interface LicenseActivateResponse extends LicenseStatusResponse {}

async function getToken(): Promise<string> {
  const token = await SDK.getAccessToken();
  if (!token || !token.trim()) throw new Error('Failed to get access token');
  return token;
}

async function getOrgUrl(): Promise<string> {
  const locationService = await SDK.getService<ILocationService>(CommonServiceIds.LocationService);
  if (!locationService?.getServiceLocation) throw new Error('Unable to access Location Service');
  const orgUrl: string = await locationService.getServiceLocation(undefined, undefined);
  if (!orgUrl) throw new Error('Unable to determine organization URL');
  return orgUrl.replace(/\/+$/, '');
}

function buildUrl(base: string, path: string): string {
  const url = base.replace(/\/+$/, '') + path;
  if (!url.startsWith('http')) throw new Error('Invalid backend URL');
  return url;
}

/**
 * GET /license/status
 * Backend derives organization and userId from Authorization and X-Ado-Org-Url
 */
export async function getLicenseStatus(baseUrl: string): Promise<LicenseStatusResponse> {
  const token = await getToken();
  const orgUrl = await getOrgUrl();
  const url = buildUrl(baseUrl, '/license/status');
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Ado-Org-Url': orgUrl,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `Request failed (${res.status})`;
    try {
      const json = JSON.parse(text);
      if (json.message) msg = json.message;
      else if (json.error?.message) msg = json.error.message;
    } catch {
      if (text) msg = text.slice(0, 200);
    }
    throw new Error(msg);
  }
  return res.json() as Promise<LicenseStatusResponse>;
}

/**
 * POST /license/activate
 * Body: { licenseKey }. Backend uses token/org for organization and userId.
 */
export async function activateLicense(
  baseUrl: string,
  licenseKey: string
): Promise<LicenseActivateResponse> {
  const token = await getToken();
  const orgUrl = await getOrgUrl();
  const user = SDK.getUser();
  const url = buildUrl(baseUrl, '/license/activate');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Ado-Org-Url': orgUrl,
    },
    body: JSON.stringify({
      licenseKey: licenseKey.trim(),
      organization: orgUrl,
      userId: user?.id ?? '',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `Activation failed (${res.status})`;
    try {
      const json = JSON.parse(text);
      if (json.message) msg = json.message;
      else if (json.error?.message) msg = json.error.message;
    } catch {
      if (text) msg = text.slice(0, 200);
    }
    throw new Error(msg);
  }
  return res.json() as Promise<LicenseActivateResponse>;
}
