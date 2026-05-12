import { useState, useMemo } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/esm/styles/prism";

const PRE_STYLE = {
  margin: 0,
  borderRadius: 0,
  whiteSpace: "pre",
  wordBreak: "normal",
  overflowWrap: "normal",
  fontSize: "14px",
};
const CODE_STYLE = {
  whiteSpace: "pre-wrap",
  display: "block",
  overflowX: "auto",
  background: "transparent",
  padding: 0,
};

// ── JSON skeleton ─────────────────────────────────────────────────────────────

const JSON_SKEL_STYLES = `
  @keyframes json-shimmer {
    0%   { background-position: -200% 0; }
    100% { background-position:  200% 0; }
  }
  .json-skel-line {
    background: linear-gradient(90deg, #e8e8e8 25%, #f4f4f4 50%, #e8e8e8 75%);
    background-size: 200% 100%;
    animation: json-shimmer 1.4s ease-in-out infinite;
    border-radius: 3px;
    height: 13px;
    display: inline-block;
  }
`;

// Line widths mimicking typical JSON structure: brackets, keys, values
const SKEL_LINES = [
  { indent: 0, w: 8 },
  { indent: 1, w: 55 },
  { indent: 1, w: 38 },
  { indent: 1, w: 72 },
  { indent: 1, w: 44 },
  { indent: 1, w: 60 },
  { indent: 0, w: 10 },
  { indent: 0, w: 8 },
  { indent: 1, w: 48 },
  { indent: 1, w: 65 },
  { indent: 1, w: 30 },
  { indent: 1, w: 80 },
  { indent: 1, w: 42 },
  { indent: 0, w: 10 },
  { indent: 0, w: 8 },
  { indent: 1, w: 70 },
  { indent: 1, w: 35 },
  { indent: 1, w: 58 },
  { indent: 1, w: 50 },
  { indent: 1, w: 66 },
  { indent: 0, w: 10 },
  { indent: 0, w: 8 },
  { indent: 1, w: 40 },
  { indent: 1, w: 75 },
  { indent: 1, w: 28 },
];

function JsonSkeleton() {
  return (
    <>
      <style>{JSON_SKEL_STYLES}</style>
      <div
        style={{
          flex: 1,
          overflow: "hidden",
          background: "#f5f5f5",
          padding: "16px 20px",
          fontFamily: "monospace",
        }}
      >
        {SKEL_LINES.map((line, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: 6,
              paddingLeft: line.indent * 24,
            }}
          >
            {/* line number */}
            <span
              style={{
                minWidth: 28,
                marginRight: 16,
                color: "#ccc",
                fontSize: 12,
                userSelect: "none",
              }}
            >
              {i + 1}
            </span>
            <span
              className="json-skel-line"
              style={{
                width: `${line.w}%`,
                animationDelay: `${(i % 7) * 0.08}s`,
              }}
            />
          </div>
        ))}
      </div>
    </>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

function JsonCodeViewer({ headers, data, loading = false }) {
  const [copied, setCopied] = useState(false);

  const jsonString = useMemo(() => {
    if (!headers.length && !data.length) return "[]";
    const array = data.map((row) =>
      Object.fromEntries(headers.map((h, i) => [h, row[i] ?? null]))
    );
    return JSON.stringify(array, null, 2);
  }, [headers, data]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (loading && !data.length) {
    return <JsonSkeleton />;
  }

  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ position: "absolute", top: 26, right: 32, zIndex: 10 }}>
        <button
          className="btn btn-sm btn-outline-dark d-flex align-items-center gap-1"
          onClick={handleCopy}
          title="Копировать JSON"
        >
          {copied ? (
            <>
              <i className="bi bi-check-lg" />
              Скопировано
            </>
          ) : (
            <>
              <i className="bi bi-clipboard" />
              Копировать
            </>
          )}
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        <SyntaxHighlighter
          language="json"
          style={vs}
          customStyle={PRE_STYLE}
          codeTagProps={{ style: CODE_STYLE }}
        >
          {jsonString}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

export default JsonCodeViewer;
