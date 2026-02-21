/**
 * Generate Test Cases Button Component
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
    <div style={{ marginBottom: '16px' }}>
      <Button
        appearance="primary"
        disabled={isLoading || isDisabled}
        onClick={onClick}
      >
        {isLoading ? 'Generating...' : 'Generate AI Test Cases'}
      </Button>
    </div>
  );
};
