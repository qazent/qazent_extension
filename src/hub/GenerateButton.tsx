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
    <div style={{ marginBottom: '16px' }}>
      <Button
        appearance="primary"
        disabled={isLoading || isDisabled}
        onClick={onClick}
      >
        {isLoading
          ? (countdown != null && countdown > 0
              ? `Generating... Estimated time remaining: ${countdown}s`
              : 'Generating...')
          : 'Generate AI Test Cases'}
      </Button>
    </div>
  );
};
