/**
 * AI Activity Feed Component
 * Displays real-time progress of the 5-step test case generation workflow
 */

import * as React from 'react';
import { Spinner } from '@fluentui/react-components';

interface AIActivityFeedProps {
  currentStep: number | null;  // 1-5 for active step, null when not generating
  completedSteps: number[];    // Array of completed step indices
}

const AIActivityFeed: React.FC<AIActivityFeedProps> = ({ currentStep, completedSteps }) => {
  const steps = [
    { id: 1, label: 'Fetching PR metadata' },
    { id: 2, label: 'Analyzing code diff' },
    { id: 3, label: 'Generating AI test cases' },
    { id: 4, label: 'Creating work item' },
    { id: 5, label: 'Posting PR comment' }
    // --- POST PR LABEL VAULTED ---
    // { id: 6, label: 'Posting PR label' }
  ];

  const getStepState = (stepId: number): 'pending' | 'active' | 'completed' => {
    if (completedSteps.includes(stepId)) {
      return 'completed';
    }
    if (currentStep === stepId) {
      return 'active';
    }
    return 'pending';
  };

  const renderStepIcon = (state: 'pending' | 'active' | 'completed') => {
    if (state === 'completed') {
      return (
        <span
          style={{
            color: '#107c10',
            fontSize: '16px',
            fontWeight: 'bold',
            lineHeight: '1'
          }}
        >
          ✓
        </span>
      );
    }

    if (state === 'active') {
      return <Spinner size="tiny" />;
    }

    // Pending state - CSS circle
    return (
      <span
        style={{
          display: 'inline-block',
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: '#ddd',
          flexShrink: 0
        }}
      />
    );
  };

  const getStepStyles = (state: 'pending' | 'active' | 'completed') => {
    const baseStyles: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '14px',
      lineHeight: '1.4',
      transition: 'opacity 200ms ease-in-out'
    };

    if (state === 'completed') {
      return {
        ...baseStyles,
        color: '#107c10',
        fontWeight: 400,
        opacity: 1
      };
    }

    if (state === 'active') {
      return {
        ...baseStyles,
        color: '#0078D4',
        fontWeight: 500,
        opacity: 1
      };
    }

    // Pending
    return {
      ...baseStyles,
      color: '#999',
      opacity: 0.6
    };
  };

  return (
    <div
      style={{
        background: 'white',
        padding: '20px 24px',
        borderRadius: '12px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.06)',
        border: '1px solid #e1e1e1'
      }}
    >
      <div
        style={{
          fontSize: '15px',
          fontWeight: 600,
          color: '#444',
          marginBottom: '12px'
        }}
      >
        AI Processing Steps
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}
      >
        {steps.map(step => {
          const state = getStepState(step.id);
          return (
            <div key={step.id} style={getStepStyles(state)}>
              {renderStepIcon(state)}
              <span>{step.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export { AIActivityFeed };
