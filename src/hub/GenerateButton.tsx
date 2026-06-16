/**
 * Analyze PR primary action button
 */

import * as React from 'react';
import { Button } from "@fluentui/react-components";

interface GenerateButtonProps {
  isLoading: boolean;
  isDisabled: boolean;
  onClick: () => void;
}

export const GenerateButton: React.FC<GenerateButtonProps> = ({
  isLoading,
  isDisabled,
  onClick
}) => {
  return (
    <div style={{ marginBottom: '16px', textAlign: 'center' }}>
      <style>{`
        @keyframes generatePulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.3; transform: scale(0.6); }
        }
        .generate-pulse-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #FFFFFF;
          display: inline-block;
          animation: generatePulse 1s ease-in-out infinite;
        }
      `}</style>
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
          {isLoading ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <span className="generate-pulse-dot" />
              Analyzing...
            </span>
          ) : 'Analyze'}
        </Button>
    </div>
  );
};