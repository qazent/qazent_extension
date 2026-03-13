/**
 * License panel: status display and license key activation
 */

import * as React from 'react';
import * as SDK from 'azure-devops-extension-sdk';
import { FluentProvider, webLightTheme, Button, Field, Input, Spinner } from '@fluentui/react-components';
import type { LicenseStatusResponse } from './api';
import { getLicenseStatus, activateLicense } from './api';

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  expired: 'Expired',
  none: 'No license',
  invalid: 'Invalid',
  suspended: 'Suspended',
};

export const LicensePanel: React.FC = () => {
  const [backendUrl, setBackendUrl] = React.useState('https://api.qazent.com');
  const [status, setStatus] = React.useState<LicenseStatusResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [licenseKey, setLicenseKey] = React.useState('');
  const [activating, setActivating] = React.useState(false);
  const [activateError, setActivateError] = React.useState<string | null>(null);
  const [activateSuccess, setActivateSuccess] = React.useState(false);

  const loadStatus = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getLicenseStatus(backendUrl);
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cannot reach license server. Please check your network or try again later.');
      setStatus({
        status: 'none',
        planName: null,
        expiresAt: null,
        message: 'Unable to load license status.',
      });
    } finally {
      setLoading(false);
    }
  }, [backendUrl]);

  React.useEffect(() => {
    const init = async () => {
      try {
        await SDK.init({ loaded: false });
        await SDK.ready();
        const extContext = SDK.getExtensionContext() as { contributions?: Array<{ id: string; properties?: { backendUrl?: string } }> };
        const contributionId = SDK.getContributionId();
        const contribution = extContext?.contributions?.find((c: { id: string }) => c.id === contributionId);
        const url = contribution?.properties?.backendUrl;
        if (url) setBackendUrl(url);
        SDK.notifyLoadSucceeded();
      } catch {
        SDK.notifyLoadSucceeded();
      }
    };
    init();
  }, []);

  React.useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleActivate = async () => {
    const key = licenseKey.trim();
    if (!key || key.length < 10) {
      setActivateError('Please enter a valid license key.');
      return;
    }
    setActivating(true);
    setActivateError(null);
    setActivateSuccess(false);
    try {
      const data = await activateLicense(backendUrl, key);
      setStatus(data);
      if (data.status === 'active') {
        setActivateSuccess(true);
        setLicenseKey('');
      } else {
        setActivateError(data.message || 'Activation failed.');
      }
    } catch (err) {
      setActivateError(err instanceof Error ? err.message : 'Cannot reach license server. Please check your network or try again later.');
    } finally {
      setActivating(false);
    }
  };

  const statusBadgeStyle = (s: string) => {
    switch (s) {
      case 'active': return { background: '#107c10', color: '#fff' };
      case 'expired': return { background: '#d83b01', color: '#fff' };
      case 'suspended': return { background: '#d83b01', color: '#fff' };
      case 'invalid': return { background: '#605e5c', color: '#fff' };
      default: return { background: '#8a8886', color: '#fff' };
    }
  };

  return (
    <FluentProvider theme={webLightTheme}>
      <div style={{ padding: '24px', maxWidth: '560px' }}>
        <h2 style={{ marginTop: 0 }}>License</h2>

        {loading ? (
          <Spinner label="Loading license status..." />
        ) : error ? (
          <div style={{ marginBottom: 16, color: '#d83b01' }}>{error}</div>
        ) : null}

        {!loading && status && (
          <>
            <div style={{ marginBottom: 16 }}>
              <span
                style={{
                  display: 'inline-block',
                  padding: '4px 12px',
                  borderRadius: 4,
                  fontWeight: 600,
                  ...statusBadgeStyle(status.status),
                }}
              >
                {STATUS_LABELS[status.status] ?? status.status}
              </span>
              {status.planName && (
                <span style={{ marginLeft: 8 }}>{status.planName}</span>
              )}
              {status.expiresAt && (
                <span style={{ marginLeft: 8, color: '#605e5c' }}>
                  Expires: {new Date(status.expiresAt).toLocaleDateString()}
                </span>
              )}
            </div>
            <p style={{ margin: '0 0 24px', color: '#605e5c' }}>{status.message}</p>
          </>
        )}

        <h3 style={{ marginBottom: 8 }}>Enter License Key</h3>
        <Field label="License key" style={{ marginBottom: 12 }}>
          <Input
            type="text"
            value={licenseKey}
            onChange={(_, d) => setLicenseKey(d.value)}
            placeholder="Paste your license key"
            disabled={activating}
            style={{ width: '100%' }}
          />
        </Field>
        {activateError && (
          <div style={{ marginBottom: 12, color: '#d83b01' }}>{activateError}</div>
        )}
        {activateSuccess && (
          <div style={{ marginBottom: 12, color: '#107c10' }}>License activated successfully.</div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            appearance="primary"
            onClick={handleActivate}
            disabled={activating || !licenseKey.trim()}
          >
            {activating ? 'Activating...' : 'Activate'}
          </Button>
          <Button appearance="secondary" onClick={loadStatus} disabled={loading}>
            Refresh status
          </Button>
        </div>
      </div>
    </FluentProvider>
  );
};
