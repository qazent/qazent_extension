/**
 * Generate Test Cases Button Component
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
          borderRadius: '12px',
          height: '56px',
          background: 'linear-gradient(135deg, #0078D4 0%, #005A9E 100%)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.boxShadow =
            '0 6px 18px rgba(0,0,0,0.25)';
          (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.boxShadow =
            '0 4px 12px rgba(0,0,0,0.15)';
          (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
        }}
      >
        <span
          style={{
            color: isLoading ? '#dbd8d8' : 'white',   //  change text color here
            transition: 'color 0.2s ease',
            background: isLoading
              ? 'linear-gradient(135deg, #6a6a6a 0%, #4a4a4a 100%)'
              : 'linear-gradient(135deg, #0078D4 0%, #005A9E 100%)',

          }}
        >
          {isLoading
            ? (countdown != null && countdown > 0
                ? `Generating... Estimated time remaining: ${countdown}s`
                : 'Generating...')
            : 'Generate AI Test Cases'}
        </span>
      </Button>
    </div>
  );
};