import { useState, useMemo } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/esm/styles/prism";

// Bootstrap resets white-space on <code> elements which breaks newline rendering
// inside SyntaxHighlighter's <pre><code> output.
// Explicitly forcing white-space: pre on both tags is the fix.
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

function JsonCodeViewer({ headers, data }) {
  const [copied, setCopied] = useState(false);

  const jsonString = useMemo(() => {
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
      {/* Copy button — floats over the top-right of the code block */}
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