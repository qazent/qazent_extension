/**
 * Shared "No valid license" message for gated hubs (PR Assistant tab, Settings hub).
 * Renders when license status is not 'active' or when the license check failed.
 */

import * as React from 'react';

export interface LicenseGateMessageProps {
  /** When true, show hint: "If the problem persists, check your network or try again later." */
  showNetworkHint?: boolean;
}

export const LicenseGateMessage: React.FC<LicenseGateMessageProps> = ({
  showNetworkHint = false,
}) => (
  <div
    style={{
      background: 'white',
      padding: '24px',
      borderRadius: '12px',
      boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
      border: '1px solid #e1e1e1',
      maxWidth: '560px',
    }}
  >
    <p style={{ margin: '0 0 12px', fontSize: '15px', lineHeight: 1.55, color: '#323130' }}>
      A valid license is required to use this feature.
    </p>
    <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.55, color: '#323130' }}>
      Go to <strong>Project Settings → QAZent - License</strong> to enter your license key.
    </p>
    {showNetworkHint && (
      <p
        style={{
          margin: '12px 0 0',
          fontSize: '14px',
          lineHeight: 1.5,
          color: '#605e5c',
        }}
      >
        If the problem persists, check your network or try again later.
      </p>
    )}
  </div>
);
