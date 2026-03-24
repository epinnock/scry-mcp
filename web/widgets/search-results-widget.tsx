import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { ResultCard, type ResultData } from "../components/result-card";

function SearchResultsWidget() {
  const [results, setResults] = useState<ResultData[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "scry-search-results", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (appInstance) => {
      appInstance.ontoolresult = (params) => {
        const sc = params.structuredContent as {
          results?: ResultData[];
          summary?: string;
        } | undefined;
        if (sc?.results) {
          setResults(sc.results);
          setSummary(sc.summary || `${sc.results.length} results`);
        }
        setLoading(false);
      };
    },
  });

  if (error) {
    return <div style={styles.error}>Error: {error.message}</div>;
  }

  if (!isConnected || loading) {
    return <div style={styles.loading}>Loading results...</div>;
  }

  if (results.length === 0) {
    return <div style={styles.empty}>No results found.</div>;
  }

  const handleOpenLink = (url: string) => {
    if (app) {
      app.openLink({ url }).catch(() => {
        window.open(url, "_blank");
      });
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.summary}>{summary}</div>
      <div style={styles.grid}>
        {results.map((result, i) => (
          <ResultCard
            key={`${result.name}-${i}`}
            result={result}
            onOpenLink={handleOpenLink}
          />
        ))}
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
  summary: {
    fontSize: "13px",
    color: "var(--color-text-secondary, #666)",
    marginBottom: "12px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: "10px",
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
};

createRoot(document.getElementById("root")!).render(<SearchResultsWidget />);
