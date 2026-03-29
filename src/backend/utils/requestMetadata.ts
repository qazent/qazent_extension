import * as http from 'http';

const CLIENT_IP_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
] as const;

type ForwardedIpHeader = (typeof CLIENT_IP_HEADERS)[number];

export interface RequestNetworkContext {
  forwardedIp?: string;
  forwardedIpHeader?: ForwardedIpHeader;
  forwardedFor?: string;
  remoteAddress?: string;
  origin?: string;
  host?: string;
}

function getHeaderValue(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (!value) {
    return undefined;
  }

  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIp(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const firstValue = value.split(',')[0]?.trim();
  if (!firstValue) {
    return undefined;
  }

  if (firstValue === '::1') {
    return '127.0.0.1';
  }

  if (firstValue.startsWith('::ffff:')) {
    return firstValue.slice('::ffff:'.length);
  }

  return firstValue;
}

/** True when an IP string represents loopback (local dev); used to skip IP-based rate limits. */
export function isLoopbackAddress(ip: string): boolean {
  if (!ip || ip === 'unknown') {
    return false;
  }
  if (ip === '::1') {
    return true;
  }
  if (ip.startsWith('127.')) {
    return true;
  }
  return false;
}

export function getRequestNetworkContext(req: http.IncomingMessage): RequestNetworkContext {
  const forwardedFor = getHeaderValue(req, 'x-forwarded-for');
  const remoteAddress = normalizeIp(req.socket.remoteAddress);

  for (const headerName of CLIENT_IP_HEADERS) {
    const headerValue = getHeaderValue(req, headerName);
    const forwardedIp = normalizeIp(headerValue);

    if (forwardedIp) {
      return {
        forwardedIp,
        forwardedIpHeader: headerName,
        forwardedFor,
        remoteAddress,
        origin: getHeaderValue(req, 'origin'),
        host: getHeaderValue(req, 'host'),
      };
    }
  }

  return {
    forwardedFor,
    remoteAddress,
    origin: getHeaderValue(req, 'origin'),
    host: getHeaderValue(req, 'host'),
  };
}

export function getClientIp(req: http.IncomingMessage): string {
  const network = getRequestNetworkContext(req);
  return network.forwardedIp || network.remoteAddress || 'unknown';
}
