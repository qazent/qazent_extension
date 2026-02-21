/**
 * PR Information Section Component
 */

import * as React from 'react';
import { Card } from 'azure-devops-ui/Card';

interface PRInfoSectionProps {
  prTitle?: string;
  prId?: number;
  author?: string;
  filesChanged?: number;
}

export const PRInfoSection: React.FC<PRInfoSectionProps> = ({
  prTitle,
  prId,
  author,
  filesChanged
}) => {
  // Show loading state if data not available
  if (!prTitle || !prId || !author) {
    return (
      <Card className="pr-info-card" style={{ marginBottom: '16px', padding: '16px' }}>
        <div style={{ fontSize: '14px', color: '#666' }}>
          Loading PR information...
        </div>
      </Card>
    );
  }

  return (
    <Card className="pr-info-card" style={{ marginBottom: '16px', padding: '16px' }}>
      <div style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '12px' }}>
        Pull Request Information
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex' }}>
          <span style={{ fontWeight: 'bold', minWidth: '140px' }}>PR Title:</span>
          <span>{prTitle}</span>
        </div>

        <div style={{ display: 'flex' }}>
          <span style={{ fontWeight: 'bold', minWidth: '140px' }}>PR ID:</span>
          <span>#{prId}</span>
        </div>

        <div style={{ display: 'flex' }}>
          <span style={{ fontWeight: 'bold', minWidth: '140px' }}>Author:</span>
          <span>{author}</span>
        </div>

        <div style={{ display: 'flex' }}>
          <span style={{ fontWeight: 'bold', minWidth: '140px' }}>Files Changed:</span>
          <span>{filesChanged !== undefined ? filesChanged : 'N/A'}</span>
        </div>
      </div>
    </Card>
  );
};
