import { commandHighlightLanguage } from "@t3tools/client-runtime/work-log/command-label";
import { Suspense, use } from "react";
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
  return (
    <div className="min-w-0 text-foreground/85">
      <div className="flex justify-end">
        <MessageCopyButton text={command} label="Copy recorded input" variant="ghost" />
      </div>
      <pre
        aria-label="Recorded input"
        tabIndex={0}
        className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] select-text"
      >
        <RenderErrorBoundary fallback={plain} resetKeys={[command]}>
          <Suspense fallback={plain}>
            {command.length > 65_536 ? (
              plain
            ) : (
              <HighlightedCommand
                code={command}
                language={language ?? commandHighlightLanguage(command)}
                theme={theme}
              />
            )}
          </Suspense>
        </RenderErrorBoundary>
      </pre>
    </div>
  );
}
