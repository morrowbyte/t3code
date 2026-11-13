import { executionEmbeddedScripts } from "@t3tools/client-runtime/work-log/embedded-scripts";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";

const MAX_ANALYZED_INPUT_LENGTH = 65_536;
const MAX_SHOWN_SCRIPTS = 16;

function RecordedCodeText(props: {
  readonly code: string;
  readonly language: string;
  readonly theme: "light" | "dark";
}) {
  const highlighted = useMarkdownCodeHighlight({
    code: props.code,
    language: props.language,
    theme: props.theme,
    enabled: props.code.length <= MAX_ANALYZED_INPUT_LENGTH,
  });
  if (props.code.length > MAX_ANALYZED_INPUT_LENGTH)
    return (
      <Text selectable className="font-mono text-2xs leading-normal text-foreground">
        {props.code}
      </Text>
    );
  return (
    <View className="min-w-0">
      {props.code.split(/\r?\n/u).map((line, index) => (
        // Source positions stay stable; soft wraps remain within the same numbered row.
        // oxlint-disable-next-line react/no-array-index-key
        <View key={index} className="min-w-0 flex-row gap-2">
          <Text
            accessible={false}
            className="w-7 text-right font-mono text-2xs leading-normal text-foreground-muted"
          >
            {index + 1}
          </Text>
          <Text
            selectable
            className="min-w-0 flex-1 font-mono text-2xs leading-normal text-foreground"
          >
            {highlighted?.[index]?.map((token, tokenIndex) => (
              // Token positions remain stable within this recorded source line.
              // oxlint-disable-next-line react/no-array-index-key
              <Text key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                {token.content}
              </Text>
            )) ?? line}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function RecordedExecutionCode(props: {
  readonly code: string;
  readonly language: string;
  readonly theme: "light" | "dark";
  readonly shell?: boolean;
  readonly onCopy?: (code: string) => void;
}) {
  const shell = props.shell ?? props.language === "shellscript";
  const scripts = useMemo(() => {
    if (!shell || props.code.length > MAX_ANALYZED_INPUT_LENGTH) return [];
    try {
      return [...executionEmbeddedScripts(props.code, props.language)].sort(
        (left, right) =>
          Number(left.language === "shellscript") - Number(right.language === "shellscript"),
      );
    } catch {
      return [];
    }
  }, [props.code, props.language, shell]);
  const [collapsedInput, setCollapsedInput] = useState<string | null>(null);
  const [copyResult, setCopyResult] = useState<{
    code: string;
    copied: boolean;
  } | null>(null);
  const originalOpen = collapsedInput !== props.code;
  const copyOriginal = async () => {
    if (props.onCopy) {
      props.onCopy(props.code);
      return;
    }
    const copied = await tryCopyTextWithHaptic(props.code, { target: "recorded input" });
    setCopyResult({ code: props.code, copied });
  };
  return (
    <View className="min-w-0 gap-2">
      <Button label="Copy input" tone="secondary" onPress={() => void copyOriginal()} />
      {copyResult?.code === props.code ? (
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          {copyResult.copied ? "Input copied." : "Could not copy input."}
        </Text>
      ) : null}
      {scripts.slice(0, MAX_SHOWN_SCRIPTS).map((script, index) => (
        // Positions identify scripts in this immutable recorded input, including duplicates.
        // oxlint-disable-next-line react/no-array-index-key
        <View key={index} className="min-w-0 gap-1">
          <Text className="font-t3-medium text-xs text-foreground-muted">
            {script.language}
            {script.shellTemplate ? " (before shell processing)" : ""}
          </Text>
          <RecordedCodeText code={script.text} language={script.language} theme={props.theme} />
        </View>
      ))}
      {scripts.length > MAX_SHOWN_SCRIPTS ? (
        <Text className="text-xs text-foreground-muted">
          Showing {MAX_SHOWN_SCRIPTS} of {scripts.length} embedded scripts.
        </Text>
      ) : null}
      {scripts.length > 0 ? (
        <Pressable
          className="min-h-14 justify-center"
          accessibilityRole="button"
          accessibilityState={{ expanded: originalOpen }}
          onPress={() => setCollapsedInput(originalOpen ? props.code : null)}
        >
          <Text className="font-t3-medium text-xs text-foreground-muted underline">
            {originalOpen ? "Hide original invocation" : "Show original invocation"}
          </Text>
        </Pressable>
      ) : null}
      {scripts.length === 0 || originalOpen ? (
        <RecordedCodeText code={props.code} language={props.language} theme={props.theme} />
      ) : null}
    </View>
  );
}
