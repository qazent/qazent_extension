/**
 * Shared license-check loading and timeout screen.
 * Shows spinner, count-up timer, progressive "long wait" messages, and on timeout an error + Retry.
 */

import * as React from 'react';
import { Spinner, Button } from '@fluentui/react-components';

export interface LicenseCheckScreenProps {
  elapsedSeconds: number;
  timedOut: boolean;
  onRetry: () => void;
}

function formatTimer(seconds: number): string {
  if (seconds === 1) return '1 second';
  return `${seconds} seconds`;
}

function getLongWaitMessage(elapsedSeconds: number): string | null {
  if (elapsedSeconds >= 120) {
    return 'If this is your first time using the extension, the server may still be starting. Otherwise, you might not have a license.';
  }
  if (elapsedSeconds >= 30) {
    return 'Still checking… this can take up to a few minutes on first use.';
  }
  if (elapsedSeconds >= 10) {
    return 'This is taking longer than usual. The server may be cold-starting.';
  }
  return null;
}

export const LicenseCheckScreen: React.FC<LicenseCheckScreenProps> = ({
  elapsedSeconds,
  timedOut,
  onRetry,
}) => {
  const longWaitMessage = getLongWaitMessage(elapsedSeconds);

  if (timedOut) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          background: 'white',
          padding: '24px',
          borderRadius: '12px',
          boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
          border: '1px solid #e1e1e1',
          maxWidth: '560px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: '15px',
            lineHeight: 1.55,
            color: '#323130',
          }}
        >
          We couldn't verify your license. This may be due to a missing license or a backend startup failure.
        </p>
        <Button appearance="primary" onClick={onRetry} aria-label="Retry license check">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Checking your license. ${formatTimer(elapsedSeconds)}.`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '12px',
        padding: '24px',
        background: 'white',
        borderRadius: '12px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
        border: '1px solid #e1e1e1',
        maxWidth: '560px',
      }}
    >
      <Spinner size="medium" aria-hidden />
      <p
        style={{
          margin: 0,
          fontSize: '15px',
          fontWeight: 500,
          color: '#323130',
        }}
      >
        Checking your license…
      </p>
      <p
        style={{
          margin: 0,
          fontSize: '14px',
          color: '#605e5c',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatTimer(elapsedSeconds)}
      </p>
      {longWaitMessage && (
        <p
          style={{
            margin: 0,
            marginTop: '8px',
            fontSize: '14px',
            lineHeight: 1.5,
            color: '#605e5c',
            textAlign: 'center',
            maxWidth: '480px',
          }}
        >
          {longWaitMessage}
        </p>
      )}
    </div>
  );
};
