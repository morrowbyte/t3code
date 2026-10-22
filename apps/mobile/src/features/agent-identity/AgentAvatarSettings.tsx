import type { ScopedThreadRef } from "@t3tools/contracts";
import { deriveAgentIdentity } from "@t3tools/client-runtime/state/agent-identity";
import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useQuietThreadShell } from "../../state/entities";
import { useAgentAvatar, useAgentAvatarActions } from "../../state/agentAvatars";
import { AgentIdentityLabel } from "./AgentIdentityLabel";
import { useAgentIdentityTheme } from "./useAgentIdentityTheme";

export function AgentAvatarSettings({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { theme } = useAgentIdentityTheme();
  const thread = useQuietThreadShell(threadRef);
  const identity = deriveAgentIdentity(threadRef, thread?.lineage, theme);
  const avatar = useAgentAvatar(threadRef, theme);
  const actions = useAgentAvatarActions(threadRef, theme);
  const generating = avatar.data?.status === "generating";
  const error = actions.error ?? avatar.error ?? avatar.data?.error;
  const hasImage = Boolean(avatar.data?.attachmentId);

  return (
    <View className="gap-2 px-4 py-3">
      <AppText className="font-t3-medium text-foreground">Agentenbild</AppText>
      <AgentIdentityLabel threadRef={threadRef} />
      <AppText className="text-xs text-foreground-muted">ChatGPT-Subscription</AppText>
      <AppText className="text-xs text-foreground-muted" accessibilityLiveRegion="polite">
        {generating
          ? "Wird erzeugt…"
          : actions.pending
            ? "Anfrage läuft…"
            : avatar.isPending && !avatar.data
              ? "Wird geladen…"
              : avatar.data?.status === "failed"
                ? "Fehlgeschlagen"
                : avatar.data?.status === "cancelled"
                  ? "Abgebrochen"
                  : avatar.data?.status === "ready"
                    ? "Bereit"
                    : ""}
      </AppText>
      {error ? (
        <AppText className="text-xs text-danger" accessibilityRole="alert">
          {error}
        </AppText>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {generating ? (
          <Button
            label="Abbrechen"
            disabled={!actions.canCancel || actions.pending}
            onPress={() => void actions.cancel()}
          />
        ) : (
          <Button
            label={
              avatar.data?.status === "failed"
                ? "Erneut versuchen"
                : hasImage
                  ? "Neu erzeugen"
                  : "Avatar erzeugen"
            }
            disabled={
              !actions.canGenerate || actions.pending || !avatar.data || Boolean(avatar.error)
            }
            onPress={() => void actions.generate(identity.name, hasImage)}
          />
        )}
        {avatar.error ? <Button tone="text" label="Erneut laden" onPress={avatar.refresh} /> : null}
      </View>
    </View>
  );
}
