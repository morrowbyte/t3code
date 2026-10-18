/* oxlint-disable react/no-array-index-key -- Protocol lists only append; positional keys preserve existing rows, points and disclosures as records arrive. */
import { memo, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import {
  parseStreamableUi,
  STREAMABLE_UI_LIMITS,
  type VisualSource,
  type VisualTable,
} from "@t3tools/shared/streamableUi";
import type { EnvironmentId } from "@t3tools/contracts";
import { AppText as Text } from "../components/ui/AppText";
import { RichChart, RichVisualBody } from "./StreamableUiRich";

function Sources({
  sources,
  onLinkPress,
}: {
  sources: VisualSource[];
  onLinkPress: ((href: string) => void) | undefined;
}) {
  if (sources.length === 0) return null;
  return (
    <View accessibilityLabel="Sources" className="flex-row flex-wrap gap-x-4">
      {sources.map((source, index) => (
        <Pressable
          key={index}
          accessibilityRole="link"
          accessibilityLabel={source.label}
          accessibilityHint={source.url}
          className="min-h-11 justify-center active:opacity-65"
          onPress={() => (onLinkPress ? onLinkPress(source.url) : void Linking.openURL(source.url))}
        >
          <Text className="text-xs text-md-link underline">{source.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function DataTable({ title, columns, rows }: Pick<VisualTable, "title" | "columns" | "rows">) {
  return (
    <ScrollView horizontal accessibilityLabel={title} className="max-w-full">
      <View>
        <View className="flex-row border-b border-border bg-subtle">
          {columns.map((column, index) => (
            <Text
              key={index}
              accessibilityRole="header"
              className="px-3 py-2 font-t3-bold text-sm"
              style={{ width: 136 }}
            >
              {column}
            </Text>
          ))}
        </View>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} className="flex-row border-b border-border">
            {row.map((cell, index) => (
              <Text
                key={index}
                selectable
                accessibilityLabel={`${columns[index]}: ${cell === null ? "—" : cell}`}
                className="px-3 py-2 text-sm tabular-nums"
                style={{ width: 136 }}
              >
                {cell === null ? "—" : cell}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function SourceError({ code, error }: { code: string; error: string }) {
  const [showSource, setShowSource] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showSource }}
        className="min-h-11 justify-center active:opacity-65"
        onPress={() => setShowSource((value) => !value)}
      >
        <Text className="text-xs text-foreground-muted">
          {error} {showSource ? "Hide" : "View"} source
        </Text>
      </Pressable>
      {showSource ? (
        <ScrollView nestedScrollEnabled style={{ maxHeight: 256 }}>
          <Text selectable className="font-mono text-xs text-foreground-muted">
            {code.slice(0, STREAMABLE_UI_LIMITS.characters)}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

export const NativeStreamableUi = memo(function NativeStreamableUi({
  code,
  isStreaming,
  environmentId = null,
  onLinkPress,
}: {
  code: string;
  isStreaming: boolean;
  environmentId?: EnvironmentId | null | undefined;
  onLinkPress?: ((href: string) => void) | undefined;
}) {
  const parsed = useMemo(() => parseStreamableUi(code, isStreaming), [code, isStreaming]);
  return (
    <View className="my-3 min-w-0 gap-3">
      {parsed.components.map((component) => (
        <View
          key={component.id}
          className="min-w-0 gap-3 rounded-lg border border-border bg-card p-4"
        >
          {component.type === "metric" ? (
            <View className="gap-1">
              <Text className="text-xs text-foreground-muted">{component.label}</Text>
              <Text selectable className="font-t3-bold text-2xl tabular-nums">
                {component.value}
              </Text>
              {component.detail ? (
                <Text className="text-xs text-foreground-muted">{component.detail}</Text>
              ) : null}
            </View>
          ) : (
            <>
              <Text accessibilityRole="header" className="font-t3-bold text-sm">
                {component.title}
              </Text>
              {component.type === "table" ? (
                <DataTable {...component} />
              ) : component.type === "chart" ? (
                <RichChart chart={component} />
              ) : (
                <RichVisualBody component={component} environmentId={environmentId} />
              )}
            </>
          )}
          <Sources sources={component.sources} onLinkPress={onLinkPress} />
        </View>
      ))}
      {parsed.pending ? (
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          Receiving visual data…
        </Text>
      ) : null}
      {parsed.error ? <SourceError code={code} error={parsed.error} /> : null}
    </View>
  );
});
