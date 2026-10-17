import { useMemo } from "react";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";
import { SelectableMarkdownText } from "./SelectableMarkdownText";
import { NativeStreamableUi } from "./StreamableUi";
import { splitStreamableUiMarkdown } from "./streamableUiMarkdown";

export function StreamableAssistantMarkdown({
  isStreaming,
  ...props
}: SelectableMarkdownTextProps & { readonly isStreaming: boolean }) {
  const segments = useMemo(() => splitStreamableUiMarkdown(props.markdown), [props.markdown]);
  return segments.map((segment) =>
    segment.kind === "visual" ? (
      <NativeStreamableUi
        key={`visual:${segment.sourceOffset}`}
        code={segment.code}
        isStreaming={isStreaming && !segment.closed}
        onLinkPress={props.onLinkPress}
      />
    ) : segment.markdown.trim() ? (
      <SelectableMarkdownText
        key={`markdown:${segment.sourceOffset}`}
        {...props}
        markdown={
          segment.referenceDefinitions
            ? `${segment.referenceDefinitions}\n\n${segment.markdown}`
            : segment.markdown
        }
      />
    ) : null,
  );
}
