import React from "react";

export interface ResultData {
  name: string;
  score: number;
  screenshotUrl?: string;
  searchableText?: string;
  figmaUrl?: string;
  githubUrl?: string;
  storybookUrl?: string;
  tags?: string[];
  projectId?: string;
}

interface ResultCardProps {
  result: ResultData;
  onOpenLink?: (url: string) => void;
}

export function ResultCard({ result, onOpenLink }: ResultCardProps) {
  const handleClick = () => {
    if (result.screenshotUrl && onOpenLink) {
      onOpenLink(result.screenshotUrl);
    }
  };

  return (
    <div style={styles.card} onClick={handleClick}>
      {result.screenshotUrl && (
        <div style={styles.imageContainer}>
          <img
            src={result.screenshotUrl}
            alt={result.name}
            style={styles.image}
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      )}
      <div style={styles.info}>
        <div style={styles.name}>{result.name}</div>
        <div style={styles.score}>
          Score: {result.score.toFixed(3)}
        </div>
        {result.searchableText && (
          <div style={styles.description}>{result.searchableText}</div>
        )}
        {result.tags && result.tags.length > 0 && (
          <div style={styles.tags}>
            {result.tags.map((tag) => (
              <span key={tag} style={styles.tag}>{tag}</span>
            ))}
          </div>
        )}
        <div style={styles.links}>
          {result.figmaUrl && (
            <a
              href={result.figmaUrl}
              onClick={(e) => {
                e.stopPropagation();
                onOpenLink?.(result.figmaUrl!);
                e.preventDefault();
              }}
              style={styles.link}
            >
              Figma
            </a>
          )}
          {result.githubUrl && (
            <a
              href={result.githubUrl}
              onClick={(e) => {
                e.stopPropagation();
                onOpenLink?.(result.githubUrl!);
                e.preventDefault();
              }}
              style={styles.link}
            >
              GitHub
            </a>
          )}
          {result.storybookUrl && (
            <a
              href={result.storybookUrl}
              onClick={(e) => {
                e.stopPropagation();
                onOpenLink?.(result.storybookUrl!);
                e.preventDefault();
              }}
              style={styles.link}
            >
              Storybook
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid var(--color-border-primary, #e0e0e0)",
    borderRadius: "8px",
    overflow: "hidden",
    cursor: "pointer",
    background: "var(--color-background-secondary, #fff)",
    transition: "box-shadow 0.15s ease",
  },
  imageContainer: {
    width: "100%",
    aspectRatio: "16/10",
    overflow: "hidden",
    background: "var(--color-background-tertiary, #f5f5f5)",
  },
  image: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  info: {
    padding: "8px 10px",
  },
  name: {
    fontWeight: 600,
    fontSize: "13px",
    marginBottom: "2px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  score: {
    fontSize: "11px",
    color: "var(--color-text-secondary, #888)",
    marginBottom: "4px",
  },
  description: {
    fontSize: "11px",
    color: "var(--color-text-secondary, #666)",
    marginBottom: "4px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tags: {
    display: "flex",
    flexWrap: "wrap",
    gap: "3px",
    marginBottom: "4px",
  },
  tag: {
    fontSize: "10px",
    padding: "1px 5px",
    borderRadius: "3px",
    background: "var(--color-background-tertiary, #eee)",
    color: "var(--color-text-secondary, #555)",
  },
  links: {
    display: "flex",
    gap: "8px",
  },
  link: {
    fontSize: "11px",
    color: "var(--color-accent-primary, #0066cc)",
    textDecoration: "none",
  },
};
