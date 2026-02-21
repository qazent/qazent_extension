/**
 * Generate Test Cases Button Component
 */

import * as React from 'react';
import { Button } from 'azure-devops-ui/Button';
import { Spinner, SpinnerSize } from 'azure-devops-ui/Spinner';

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
        text={isLoading ? 'Generating...' : 'Generate AI Test Cases'}
        primary={true}
        disabled={isLoading || isDisabled}
        onClick={onClick}
        iconProps={isLoading ? { render: () => <Spinner size={SpinnerSize.small} /> } : undefined}
      />
    </div>
  );
};
