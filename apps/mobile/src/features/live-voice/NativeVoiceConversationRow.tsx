import { View } from "react-native";
import { memo } from "react";
import {
  sameVoiceConversationItem,
  type VoiceConversationItem,
} from "@t3tools/client-runtime/live-voice";
import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { CopyTextButton } from "../threads/CopyTextButton";

export const NativeVoiceConversationRow = memo(
  function NativeVoiceConversationRow({ item }: { readonly item: VoiceConversationItem }) {
    if (item.kind === "notice")
      return (
        <AppText accessibilityLiveRegion="polite" className="py-2 text-xs text-foreground-muted">
          {item.text}
        </AppText>
      );
    if (item.kind !== "speech") {
      const label =
        item.kind === "call-start"
          ? "Voice"
          : item.call.status === "failed"
            ? "Gespräch fehlgeschlagen"
            : item.call.status === "unknown"
              ? "Gespräch unterbrochen"
              : "Gespräch beendet";
      return (
        <View className="flex-row flex-wrap items-center gap-2 py-3">
          <SymbolView name="mic" size={12} tintColorClassName="accent-foreground-muted" />
          <AppText className="text-xs text-foreground-muted">
            {label}
            {item.kind === "call-start" && !item.call.endedAt
              ? item.call.status === "active"
                ? " · Live"
                : item.call.status === "stopping"
                  ? " · Beenden…"
                  : item.call.status === "unknown"
                    ? " · Unterbrochen"
                    : " · Verbinden…"
              : ""}{" "}
            ·{" "}
            {new Date(item.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </AppText>
        </View>
      );
    }
    const entry = item.entry;
    const user = entry.speaker === "user";
    return (
      <View className={`min-w-0 gap-1 pb-4 ${user ? "items-end" : ""}`} testID={item.id}>
        <View className="flex-row flex-wrap items-center gap-2">
          <AppText className="text-xs font-t3-medium text-foreground-muted">
            {user ? "Du" : "Live"} · Voice
          </AppText>
          <AppText className="text-xs text-foreground-muted">
            {new Date(entry.occurredAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
            {entry.final ? "" : " …"}
          </AppText>
        </View>
        <View
          className={
            user ? "max-w-full rounded-2xl rounded-br-sm bg-subtle px-4 py-3" : "max-w-full"
          }
        >
          <AppText selectable className="text-base leading-6 text-foreground">
            {entry.text}
          </AppText>
        </View>
        <CopyTextButton accessibilityLabel="Beitrag kopieren" text={entry.text} />
      </View>
    );
  },
  (previous, next) => sameVoiceConversationItem(previous.item, next.item),
);
