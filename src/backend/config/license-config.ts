/**
 * License module: environment-driven configuration
 */

export interface LicenseConfig {
  lemonSqueezyLicenseApiUrl: string;
  lemonSqueezyApiKey: string;
  lemonSqueezyWebhookSecret: string;
  licenseHashSalt: string;
  /** If set, use Postgres for license storage; otherwise in-memory. */
  databaseUrl: string;
  defaultSeatsPerKey: number;
  expiryGraceDays: number;
  allowedProductIds: number[];
}

function parseOptionalInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? defaultValue : n;
}

function parseAllowedProductIds(value: string | undefined): number[] {
  if (!value || value.trim() === '') return [];
  return value
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n));
}

/**
 * Load license configuration from environment variables.
 * Required for activation: LICENSE_HASH_SALT, LEMON_SQUEEZY_WEBHOOK_SECRET (for webhooks).
 */
export function loadLicenseConfig(): LicenseConfig {
  return {
    lemonSqueezyLicenseApiUrl:
      process.env.LEMON_SQUEEZY_LICENSE_API_URL || 'https://api.lemonsqueezy.com/v1/licenses',
    lemonSqueezyApiKey: process.env.LEMON_SQUEEZY_API_KEY || '',
    lemonSqueezyWebhookSecret: process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || '',
    licenseHashSalt: process.env.LICENSE_HASH_SALT || '',
    databaseUrl: process.env.DATABASE_URL || '',
    defaultSeatsPerKey: parseOptionalInt(process.env.LICENSE_DEFAULT_SEATS_PER_KEY, 5),
    expiryGraceDays: parseOptionalInt(process.env.LICENSE_EXPIRY_GRACE_DAYS, 0),
    allowedProductIds: parseAllowedProductIds(process.env.LICENSE_ALLOWED_PRODUCT_IDS),
  };
}

export function isLicenseConfigReadyForActivation(config: LicenseConfig): boolean {
  return Boolean(config.licenseHashSalt?.trim());
}

export function isLicenseConfigReadyForWebhooks(config: LicenseConfig): boolean {
  return Boolean(config.lemonSqueezyWebhookSecret?.trim());
}
