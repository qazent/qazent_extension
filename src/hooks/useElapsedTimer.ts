/**
 * Count-up timer that runs while active and reports timedOut when elapsed >= timeoutSeconds.
 * Does not block any async work; purely time-based for UX (e.g. license check loading screen).
 */

import * as React from 'react';

const DEFAULT_TIMEOUT_SECONDS = 90;

export interface UseElapsedTimerOptions {
  timeoutSeconds?: number;
}

export function useElapsedTimer(
  isActive: boolean,
  options?: UseElapsedTimerOptions
): { elapsedSeconds: number; timedOut: boolean } {
  const timeoutSeconds = options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const prevActiveRef = React.useRef(isActive);

  // On transition to active (e.g. Retry), treat elapsed as 0 this render so timedOut is false.
  // Otherwise reset runs in effect (post-render) and consumer's timeout effect would see stale
  // elapsedSeconds >= 90 and immediately abort the new request.
  const justBecameActive = isActive && !prevActiveRef.current;
  const effectiveElapsed = justBecameActive ? 0 : elapsedSeconds;

  // Reset state when we transition to active (effect runs after render)
  React.useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      setElapsedSeconds(0);
    }
    prevActiveRef.current = isActive;
  }, [isActive]);

  React.useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive]);

  const timedOut = isActive && effectiveElapsed >= timeoutSeconds;

  return { elapsedSeconds: effectiveElapsed, timedOut };
}
