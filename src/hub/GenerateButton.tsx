/**
 * Analyze PR primary action button
 */

import * as React from 'react';
import { Button } from "@fluentui/react-components";

interface GenerateButtonProps {
  isLoading: boolean;
  isDisabled: boolean;
  onClick: () => void;
  countdown?: number | null;
}

export const GenerateButton: React.FC<GenerateButtonProps> = ({
  isLoading,
  isDisabled,
  onClick,
  countdown
}) => {
  return (
    <div style={{ marginBottom: '16px', textAlign: 'center' }}>
      <Button
          appearance="primary"
          disabled={isLoading || isDisabled}
          onClick={onClick}
          style={{
            padding: '16px 28px',
            fontSize: '18px',
            fontWeight: 600,
            borderRadius: '0px',
            height: '56px',
            background: '#0078d4',
            transition: 'background 0.2s ease',
            color: '#FFFFFF',
          }}
          onMouseEnter={(e) => {
            if (isLoading) return;
            (e.currentTarget as HTMLButtonElement).style.background = '#106ebe';
          }}
          onMouseLeave={(e) => {
            if (isLoading) return;
            (e.currentTarget as HTMLButtonElement).style.background = '#0078d4';
          }}
        >
          {isLoading
            ? (countdown != null && countdown > 0
                ? `Analyzing... Estimated time remaining: ${countdown}s`
                : 'Analyzing...')
            : 'Analyze'}
        </Button>
    </div>
  );
};