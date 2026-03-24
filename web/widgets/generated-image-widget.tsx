import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";

interface GeneratedImageData {
  url?: string;
  base64?: string;
  prompt: string;
  aspectRatio?: string;
  quality?: string;
  model?: string;
  mimeType?: string;
  generatedAt?: string;
}

function GeneratedImageWidget() {
  const [imageData, setImageData] = useState<GeneratedImageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  const { isConnected, error } = useApp({
    appInfo: { name: "scry-generated-image-viewer", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (appInstance) => {
      appInstance.ontoolresult = (params) => {
        const sc = params.structuredContent as {
          generatedImage?: GeneratedImageData;
        } | undefined;
        if (sc?.generatedImage) {
          setImageData(sc.generatedImage);
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
    return <div style={styles.loading}>Generating image...</div>;
  }

  if (!imageData) {
    return <div style={styles.empty}>No image generated.</div>;
  }

  // Prefer presigned URL, fall back to base64 data URI
  const imageSrc = imageData.url
    || (imageData.base64
      ? `data:${imageData.mimeType || "image/png"};base64,${imageData.base64}`
      : undefined);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.prompt}>{imageData.prompt}</span>
      </div>
      {imageError || !imageSrc ? (
        <div style={styles.imageError}>
          Failed to load image.
          {imageData.url && (
            <>
              {" "}
              <a href={imageData.url} target="_blank" rel="noopener noreferrer" style={styles.link}>
                Open URL directly
              </a>
            </>
          )}
        </div>
      ) : (
        <img
          src={imageSrc}
          alt={imageData.prompt}
          style={styles.image}
          onError={() => setImageError(true)}
        />
      )}
      <div style={styles.meta}>
        {imageData.aspectRatio && <span style={styles.tag}>{imageData.aspectRatio}</span>}
        {imageData.quality && <span style={styles.tag}>{imageData.quality}</span>}
        {imageData.model && <span style={styles.tag}>{imageData.model}</span>}
      </div>
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
    marginBottom: "10px",
  },
  prompt: {
    fontSize: "13px",
    color: "var(--color-text-secondary, #666)",
    fontStyle: "italic",
  },
  image: {
    maxWidth: "100%",
    height: "auto",
    borderRadius: "6px",
    border: "1px solid var(--color-border-primary, #e0e0e0)",
    display: "block",
  },
  meta: {
    marginTop: "8px",
    display: "flex",
    gap: "6px",
    flexWrap: "wrap",
  },
  tag: {
    fontSize: "11px",
    padding: "2px 6px",
    borderRadius: "4px",
    background: "var(--color-bg-secondary, #f0f0f0)",
    color: "var(--color-text-secondary, #666)",
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

createRoot(document.getElementById("root")!).render(<GeneratedImageWidget />);
