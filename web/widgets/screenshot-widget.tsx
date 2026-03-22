import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";

interface ScreenshotData {
  url: string;
  componentName?: string;
  mimeType?: string;
}

function ScreenshotWidget() {
  const [screenshot, setScreenshot] = useState<ScreenshotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  const { isConnected, error } = useApp({
    appInfo: { name: "scry-screenshot-viewer", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (appInstance) => {
      appInstance.ontoolresult = (params) => {
        const sc = params.structuredContent as {
          screenshot?: ScreenshotData;
        } | undefined;
        if (sc?.screenshot) {
          setScreenshot(sc.screenshot);
          setImageError(false);
        }
        setLoading(false);
      };
    },
  });

  if (error) {
    return <div style={styles.error}>Error: {error.message}</div>;
  }

  if (!isConnected || loading) {
    return <div style={styles.loading}>Loading screenshot...</div>;
  }

  if (!screenshot) {
    return <div style={styles.empty}>No screenshot available.</div>;
  }

  return (
    <div style={styles.container}>
      {screenshot.componentName && (
        <div style={styles.header}>{screenshot.componentName}</div>
      )}
      {imageError ? (
        <div style={styles.imageError}>
          Failed to load image.{" "}
          <a href={screenshot.url} target="_blank" rel="noopener noreferrer" style={styles.link}>
            Open URL directly
          </a>
        </div>
      ) : (
        <img
          src={screenshot.url}
          alt={screenshot.componentName || "Component screenshot"}
          style={styles.image}
          onError={() => setImageError(true)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "12px",
    fontFamily: "var(--font-sans, system-ui, sans-serif)",
    color: "var(--color-text-primary, #1a1a1a)",
  },
  header: {
    fontSize: "15px",
    fontWeight: 600,
    marginBottom: "10px",
  },
  image: {
    maxWidth: "100%",
    height: "auto",
    borderRadius: "6px",
    border: "1px solid var(--color-border-primary, #e0e0e0)",
    display: "block",
  },
  loading: {
    padding: "24px",
    textAlign: "center",
    color: "var(--color-text-secondary, #888)",
    fontSize: "13px",
  },
  empty: {
    padding: "24px",
    textAlign: "center",
    color: "var(--color-text-secondary, #888)",
    fontSize: "13px",
  },
  error: {
    padding: "24px",
    textAlign: "center",
    color: "#dc3545",
    fontSize: "13px",
  },
  imageError: {
    padding: "24px",
    textAlign: "center",
    color: "var(--color-text-secondary, #888)",
    fontSize: "13px",
  },
  link: {
    color: "var(--color-accent-primary, #0066cc)",
  },
};

createRoot(document.getElementById("root")!).render(<ScreenshotWidget />);
