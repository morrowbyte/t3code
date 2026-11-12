import { commandHighlightLanguage } from "@t3tools/client-runtime/work-log/command-label";
import { Suspense, use, type ReactNode } from "react";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { MessageCopyButton } from "./MessageCopyButton";
import { HighlightedTokens } from "./HighlightedTokens";
import { PlainCodeLines } from "./RecordedSourceLines";

let embeddedScriptsModule: Promise<typeof import("../../lib/embeddedScripts")> | undefined;
function loadEmbeddedScripts() {
  embeddedScriptsModule ??= import("../../lib/embeddedScripts");
  return embeddedScriptsModule;
}

function HighlightedCommand({
  code,
  language,
  theme,
}: {
  code: string;
  language: string;
  theme: "light" | "dark";
}) {
  const { embeddedScripts } = use(loadEmbeddedScripts());
  const embedded = language === "shellscript" ? embeddedScripts(code) : [];
  return (
    <HighlightedTokens
      code={code}
      language={language}
      embedded={embedded}
      theme={theme}
      lineNumbers
    />
  );
}

export function EmbeddedScriptBlocks({
  command,
  language,
  theme,
  children,
}: {
  command: string;
  language: string;
  theme: "light" | "dark";
  children: ReactNode;
}) {
  if (command.length > 65_536) return children;
  const { executionEmbeddedScripts } = use(loadEmbeddedScripts());
  const scripts = executionEmbeddedScripts(command, language).toSorted(
    (left, right) =>
      Number(left.language === "shellscript") - Number(right.language === "shellscript"),
  );
  if (scripts.length === 0) return children;
  const languageNames: Record<string, string> = {
    shellscript: "Shell",
    python: "Python",
    javascript: "JavaScript",
    typescript: "TypeScript",
    powershell: "PowerShell",
    sql: "SQL",
  };
  return (
    <div className="min-w-0 space-y-3">
      {scripts.slice(0, 16).map((script) => {
        const name = languageNames[script.language] ?? script.language;
        const plain = <PlainCodeLines code={script.text} />;
        return (
          <section key={`${script.starts[0]}:${script.language}`} className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">
                {name}
                {script.shellTemplate ? " · before shell processing" : ""}
              </span>
            </div>
            <pre
              aria-label={`Embedded ${name} script`}
              tabIndex={0}
              className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <RenderErrorBoundary fallback={plain} resetKeys={[script.text]}>
                <Suspense fallback={plain}>
                  <HighlightedTokens
                    code={script.text}
                    language={script.language}
                    theme={theme}
                    lineNumbers
                  />
                </Suspense>
              </RenderErrorBoundary>
            </pre>
          </section>
        );
      })}
      <details open className="min-w-0 text-xs">
        <summary className="cursor-pointer text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          Shell invocation{scripts.length > 16 ? ` · ${scripts.length} embedded scripts` : ""}
        </summary>
        <div className="mt-2 min-w-0">{children}</div>
      </details>
    </div>
  );
}

export function ShellCommandBlock({
  command,
  language,
}: {
  command: string;
  language?: string | undefined;
}) {
  const theme = useRenderedAppearance();
  if (!command) return null;
  const plain = <PlainCodeLines code={command} />;
  const resolvedLanguage = language ?? commandHighlightLanguage(command);
  const original = (
    <pre
      aria-label="Recorded input"
      tabIndex={0}
      className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <RenderErrorBoundary fallback={plain} resetKeys={[command]}>
        <Suspense fallback={plain}>
          {command.length > 65_536 ? (
            plain
          ) : (
            <HighlightedCommand code={command} language={resolvedLanguage} theme={theme} />
          )}
        </Suspense>
      </RenderErrorBoundary>
    </pre>
  );
  return (
    <div className="min-w-0 text-foreground/85">
      <div className="flex justify-end">
        <MessageCopyButton text={command} label="Copy recorded input" variant="ghost" />
      </div>
      <RenderErrorBoundary fallback={original} resetKeys={[command]}>
        <Suspense fallback={original}>
          <EmbeddedScriptBlocks command={command} language={resolvedLanguage} theme={theme}>
            {original}
          </EmbeddedScriptBlocks>
        </Suspense>
      </RenderErrorBoundary>
    </div>
  );
}
