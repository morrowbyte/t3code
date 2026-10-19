import { memo, useEffect, useState } from "react";
import styles from "./markdown-math.module.css";

let engine: Promise<typeof import("katex")> | undefined;

function loadMathEngine() {
  return (engine ??= import("katex"));
}

export const MarkdownMath = memo(function MarkdownMath({
  source,
  raw,
  display,
  closed,
  isStreaming,
}: {
  source: string;
  raw: string;
  display: boolean;
  closed: boolean;
  isStreaming: boolean;
}) {
  const [rendered, setRendered] = useState<{
    source: string;
    display: boolean;
    html: string | null;
  }>();
  useEffect(() => {
    if (!closed) return;
    let current = true;
    const publish = (html: string | null) => {
      if (current) setRendered({ source, display, html });
    };
    if (source.length > 4096) {
      publish(null);
      return;
    }
    loadMathEngine().then(
      (katex) => {
        try {
          publish(
            katex.renderToString(source, {
              displayMode: display,
              output: "mathml",
              trust: false,
              throwOnError: true,
              strict: "ignore",
              maxSize: 6,
              maxExpand: 200,
            }),
          );
        } catch {
          publish(null);
        }
      },
      () => publish(null),
    );
    return () => {
      current = false;
    };
  }, [source, display, closed]);

  const result = rendered?.source === source && rendered.display === display ? rendered : undefined;
  const pending = (!closed && isStreaming) || (closed && result === undefined);
  const Tag = display ? "div" : "span";
  return (
    <Tag
      className={`${styles.math} ${display ? styles.display : styles.inline}`}
      data-markdown-math={display ? "display" : "inline"}
      data-markdown-copy={raw}
      data-math-state={pending ? "pending" : result?.html ? "ready" : "source"}
      aria-busy={pending || undefined}
      {...(display ? { tabIndex: 0, role: "region", "aria-label": "Formel" } : {})}
    >
      {pending ? (
        <span role="status" className={styles.pending}>
          Formel…
        </span>
      ) : result?.html ? (
        <span dangerouslySetInnerHTML={{ __html: result.html }} />
      ) : (
        <span className={styles.source}>{raw}</span>
      )}
    </Tag>
  );
});
