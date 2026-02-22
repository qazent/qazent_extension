import * as React from "react";
import { Spinner } from "@fluentui/react-components";

interface LoadingIndicatorProps {
  message?: string;
  estimatedSeconds?: number; // e.g., 40 for test generation
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  message = "Processing...",
  estimatedSeconds = 40
}) => {
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const percent = Math.min((elapsed / estimatedSeconds) * 100, 100);
  const remaining = Math.max(estimatedSeconds - elapsed, 0);

  return (
    <div
      style={{
        padding: "20px",
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "12px"
      }}
    >
      <Spinner size="large" />

      <div style={{ fontSize: "16px", fontWeight: 600 }}>
        {message}
      </div>

      <div style={{ fontSize: "14px", opacity: 0.8 }}>
        Estimated time remaining: {remaining}s
      </div>

      <div
        style={{
          width: "80%",
          height: "6px",
          background: "#ddd",
          borderRadius: "4px",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: "100%",
            background: "#0078d4",
            transition: "width 0.5s linear"
          }}
        />
      </div>
    </div>
  );
};