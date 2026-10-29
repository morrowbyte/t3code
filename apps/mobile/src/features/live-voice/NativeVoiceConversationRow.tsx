import { View } from "react-native";
import { memo } from "react";
import {
  sameVoiceConversationItem,
  type VoiceConversationItem,
} from "@t3tools/client-runtime/live-voice";
import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { CopyTextButton } from "../threads/CopyTextButton";
import { AgentIdentityLabel } from "../agent-identity/AgentIdentityLabel";

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
    const bubble = item.bubble;
    return (
      <View className={`relative min-w-0 gap-1 pb-3 ${user ? "items-end" : ""}`} testID={item.id}>
        <View className="min-h-7 flex-row flex-wrap items-center gap-2 pr-9">
          {!user && bubble ? <AgentIdentityLabel threadRef={bubble} avatarSize={24} /> : null}
          {user && bubble ? (
            <SymbolView name="mic" size={12} tintColorClassName="accent-foreground-muted" />
          ) : null}
          <AppText className="text-xs font-t3-medium text-foreground-muted">
            {user
              ? bubble
                ? "Du · Mikrofon"
                : "Du · Voice"
              : bubble
                ? "GPT Live"
                : "Live · Voice"}
          </AppText>
          <AppText className="text-xs text-foreground-muted">
            {new Date(entry.occurredAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
            {entry.final ? "" : bubble?.settled ? " · Unvollständig" : " …"}
          </AppText>
        </View>
        <View
          className={
            user
              ? "max-w-full rounded-2xl rounded-br-sm bg-subtle px-4 py-3"
              : bubble
                ? "max-w-full rounded-2xl rounded-bl-sm border border-border bg-subtle px-4 py-3"
                : "max-w-full"
          }
        >
          <AppText selectable className="text-base leading-6 text-foreground">
            {entry.text}
          </AppText>
        </View>
        <View className="absolute top-0 right-0">
          <CopyTextButton accessibilityLabel="Beitrag kopieren" text={entry.text} />
        </View>
      </View>
    );
  },
  (previous, next) => sameVoiceConversationItem(previous.item, next.item),
);
