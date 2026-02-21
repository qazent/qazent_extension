/**
 * Test Case Card Component
 */

import * as React from 'react';
import { Card } from '@fluentui/react-card';
import { GeneratedTestCase } from '../types/extension-types';
import { Button } from "@fluentui/react-components";

interface TestCaseCardProps {
  testCase: GeneratedTestCase | null;
  onCopyToClipboard: () => void;
  onCreateWorkItem: () => void;
  isCreatingWorkItem: boolean;
}

export const TestCaseCard: React.FC<TestCaseCardProps> = ({
  testCase,
  onCopyToClipboard,
  onCreateWorkItem,
  isCreatingWorkItem
}) => {
  // Don't render if no test case
  if (!testCase) {
    return null;
  }

  // Format test case for clipboard
  const formatTestCaseText = (): string => {
    let text = `Title: ${testCase.title}\n\n`;

    if (testCase.preconditions && testCase.preconditions.length > 0) {
      text += 'Preconditions:\n';
      testCase.preconditions.forEach(pre => {
        text += `- ${pre}\n`;
      });
      text += '\n';
    }

    if (testCase.testSteps && testCase.testSteps.length > 0) {
      text += 'Test Steps:\n';
      testCase.testSteps.forEach((step, index) => {
        text += `${index + 1}. ${step}\n`;
      });
      text += '\n';
    }

    if (testCase.expectedResults && testCase.expectedResults.length > 0) {
      text += 'Expected Result:\n';
      testCase.expectedResults.forEach(result => {
        text += `- ${result}\n`;
      });
      text += '\n';
    }

    return text;
  };

  const handleCopyClick = () => {
    const text = formatTestCaseText();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => {
          onCopyToClipboard();
        })
        .catch(() => {
          alert('Failed to copy. Please select and copy manually.');
        });
    } else {
      alert('Clipboard not supported. Please select and copy manually.');
    }
  };

  return (
    <Card className="test-case-card" style={{ marginBottom: '16px', padding: '20px' }}>
      {/* Title */}
      <div style={{ fontSize: '22px', fontWeight: 'bold', marginBottom: '16px', textTransform: 'uppercase', color: '#e01134' }}>
        {testCase.title}
      </div>

      {/* Preconditions */}
      {testCase.preconditions && testCase.preconditions.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontWeight: 'bold', fontSize: '14px', marginBottom: '8px', textTransform: 'uppercase' }}>
            Preconditions
          </div>
          <ul style={{ marginLeft: '20px', marginTop: '0' }}>
            {testCase.preconditions.map((pre, index) => (
              <li key={index} style={{ marginBottom: '4px' }}>{pre}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Test Steps */}
      {testCase.testSteps && testCase.testSteps.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontWeight: 'bold', fontSize: '14px', marginBottom: '8px', textTransform: 'uppercase' }}>
            Test Steps
          </div>
          <ol style={{ marginLeft: '20px', marginTop: '0' }}>
            {testCase.testSteps.map((step, index) => (
              <li key={index} style={{ marginBottom: '4px' }}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Expected Results */}
      {testCase.expectedResults && testCase.expectedResults.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontWeight: 'bold', fontSize: '20px', marginBottom: '8px', textTransform: 'uppercase', color: '#107c10' }}>
            Expected Result
          </div>
          <ul style={{ marginLeft: '20px', marginTop: '0' }}>
            {testCase.expectedResults.map((result, index) => (
              <li key={index} style={{ marginBottom: '4px' }}>{result}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '12px', marginTop: '20px', justifyContent: 'flex-end',color: '#8e09e7' }}>
        <Button
          appearance="primary"
          size="small"
          onClick={handleCopyClick}
        >
          Copy to Clipboard
        </Button>
        <Button
          appearance="primary"
          disabled={isCreatingWorkItem}
          onClick={onCreateWorkItem}
        >
          {isCreatingWorkItem ? 'Creating...' : 'Create Work Item'}
        </Button>
      </div>
    </Card>
  );
};
