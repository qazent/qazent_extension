/**
 * AI Activity Feed Component
 * Displays real-time progress of the PR analysis workflow (hub → backend → ADO).
 */

import * as React from 'react';
import { Spinner } from '@fluentui/react-components';

interface AIActivityFeedProps {
  currentStep: number | null;  // 1-6 for active step, null when not generating
  completedSteps: number[];    // Array of completed step indices
}

const AIActivityFeed: React.FC<AIActivityFeedProps> = ({ currentStep, completedSteps }) => {
  const steps = [
    { id: 1, label: 'Fetching your code changes...' },
    { id: 2, label: 'Ranking your hard work...' },
    { id: 3, label: 'Talking with the AI...' },
    { id: 4, label: 'Processing what the AI said...' },
    { id: 5, label: 'Sharing the results with you...' },
    { id: 6, label: '"I need to git pull --my-life-together", said the AI...' },
    { id: 7, label: 'Making sure everything is perfect...' },
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
        Analysis progress
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
              {step.label ? (
                <span>{step.label}</span>
              ) : (
                <span aria-hidden="true" style={{ minHeight: '1.4em' }}>
                  {'\u00A0'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export { AIActivityFeed };
