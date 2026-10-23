import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { memo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useThreadShell } from "../../state/entities";
import { AgentIdentityLabel } from "../agent-identity/AgentIdentityLabel";
import { agentMessagePreview, parseAgentMessage } from "./agent-message-presentation";

export const AgentMessage = memo(function AgentMessage(
  props: {
    readonly messageId: string;
    readonly text: string;
    readonly previewText?: string;
    readonly environmentId: EnvironmentId;
    readonly senderThreadId?: ThreadId;
    readonly direction?: "incoming" | "outgoing";
    readonly deliveryLabel?: string;
    readonly attachments?: ReactNode;
    readonly timestampLabel: string;
    readonly streaming: boolean;
    readonly children: (bodyText: string) => ReactNode;
  } & (
    | { readonly attribution: "agent" | "unknown" }
    | { readonly attribution: "human" | "synthetic"; readonly principalLabel: string }
  ),
) {
  const originalOrder = props.attribution === "human" || props.attribution === "synthetic";
  const navigation = useNavigation();
  const sender = useThreadShell(
    props.senderThreadId && !originalOrder
      ? { environmentId: props.environmentId, threadId: props.senderThreadId }
      : null,
  );
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState(false);
  const [technical, setTechnical] = useState(false);
  const trigger = useRef<ComponentRef<typeof View>>(null);
  const structured = originalOrder ? null : parseAgentMessage(props.text);
  const collapse = () => {
    setExpanded(false);
    setRaw(false);
    setTechnical(false);
    trigger.current?.focus();
  };
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const actor =
    props.attribution === "synthetic"
      ? "Synthetic test order"
      : originalOrder
        ? "Human order"
        : props.attribution === "agent"
          ? "Agent"
          : "MCP";
  const direction = props.direction === "outgoing" ? "An" : "Von";
  const metadata = (
    <View className="w-full min-w-0 flex-row items-center gap-1.5">
      {!originalOrder ? (
        <View className="shrink-0">
          <SymbolView
            name={props.direction === "outgoing" ? "arrow.up.right" : "arrow.down.left"}
            size={20}
            tintColorClassName="accent-foreground-muted"
          />
        </View>
      ) : null}
      <Text className="text-base leading-5 text-foreground-muted">
        {originalOrder ? "Host order" : direction}
      </Text>
      {props.senderThreadId && !originalOrder ? (
        <View className="min-w-0 flex-1">
          <AgentIdentityLabel
            threadRef={{ environmentId: props.environmentId, threadId: props.senderThreadId }}
            featureTitle={sender?.title}
            size="md"
            avatarSize={24}
          />
        </View>
      ) : (
        <Text
          className="min-w-0 flex-1 text-base leading-5 text-foreground-muted"
          numberOfLines={1}
        >
          {originalOrder ? `Principal: ${props.principalLabel}` : actor}
        </Text>
      )}
    </View>
  );

  return (
    <View
      className={`mb-3 w-full border-border bg-grouped-card px-3 py-2.5 ${originalOrder ? "rounded border" : "border-l-2"}`}
    >
      <View className="min-h-11 flex-row items-center gap-3">
        {props.senderThreadId && !originalOrder ? (
          <Pressable
            className="min-h-11 min-w-0 flex-1 justify-center"
            accessibilityRole="button"
            accessibilityLabel={`Open ${props.direction === "outgoing" ? "receiving" : "sending"} thread, ${sender?.title ?? actor}`}
            onPress={() => {
              if (props.senderThreadId) {
                navigation.navigate("Thread", {
                  environmentId: String(props.environmentId),
                  threadId: String(props.senderThreadId),
                });
              }
            }}
          >
            {metadata}
          </Pressable>
        ) : (
          <View className="min-w-0 flex-1">{metadata}</View>
        )}
        <View className="shrink-0 items-end gap-1">
          <Text className="text-xs tabular-nums text-foreground-muted">{props.timestampLabel}</Text>
          {structured?.status && structured.status !== "info" ? (
            <Text
              accessibilityLabel={`Nachrichtenstatus: ${structured.status}`}
              className="text-sm font-t3-medium text-foreground-muted"
            >
              {structured.status}
            </Text>
          ) : null}
        </View>
      </View>
      <View className={originalOrder ? undefined : "pl-6"}>
        <Pressable
          ref={trigger}
          className="min-h-12 flex-row items-start gap-3 py-2"
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${props.attribution === "synthetic" ? "synthetic test order" : originalOrder ? "human order" : props.attribution === "agent" ? "agent message" : "MCP message"}`}
          accessibilityState={{ expanded }}
          onPress={() => (expanded ? collapse() : setExpanded(true))}
        >
          <Text
            selectable={originalOrder}
            className="min-w-0 flex-1 text-base font-t3-medium leading-6 text-foreground"
          >
            {props.previewText ??
              (originalOrder ? props.text : structured?.summary) ??
              (agentMessagePreview(props.text) ||
                (props.attribution === "agent" ? "Agent message" : "MCP message"))}
          </Text>
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={16}
            tintColorClassName="accent-foreground-muted"
            style={{ marginTop: 4 }}
          />
        </Pressable>
        {props.deliveryLabel ? (
          <Text className="text-xs text-foreground-muted">{props.deliveryLabel}</Text>
        ) : null}
        {expanded ? (
          <View className="gap-4 pt-3">
            {props.attachments}
            {originalOrder ? (
              <Text selectable className="text-base leading-6 text-foreground">
                {props.text}
              </Text>
            ) : structured?.kind === "structured" ? (
              structured.sections.map((section, index) =>
                section.kind === "technical" ? (
                  <View key={index}>
                    <Button
                      label={technical ? "Technik verbergen" : "Technik"}
                      tone="text"
                      onPress={() => setTechnical((value) => !value)}
                    />
                    {technical ? props.children(section.text) : null}
                  </View>
                ) : (
                  <View key={index} className="gap-2">
                    <Text className="font-t3-medium text-sm text-foreground-muted">
                      {section.label}
                    </Text>
                    {props.children(section.text)}
                  </View>
                ),
              )
            ) : (
              props.children(props.text)
            )}
          </View>
        ) : null}
        {expanded ? (
          <View className="mt-2 flex-row flex-wrap items-center gap-2">
            <Button
              label={raw ? "Hide original" : "Original"}
              tone="text"
              onPress={() => setRaw((value) => !value)}
            />
            <Button
              label={copiedText === props.text ? "Copied" : "Copy original"}
              tone="text"
              disabled={props.text.length === 0}
              onPress={() => {
                void tryCopyTextWithHaptic(props.text).then((copied) => {
                  if (copied) setCopiedText(props.text);
                  else Dialog.alert("Could not copy", "Try again.");
                });
              }}
            />
            {expanded ? <Button label="Show less" tone="text" onPress={collapse} /> : null}
            {props.streaming ? (
              <Text accessibilityRole="text" className="text-xs text-foreground-muted">
                Receiving…
              </Text>
            ) : null}
          </View>
        ) : props.streaming ? (
          <Text className="mt-2 text-xs text-foreground-muted">Receiving…</Text>
        ) : null}
        {raw ? (
          <Text
            selectable
            className="mt-3 rounded-lg border border-border p-3 font-t3-mono text-sm leading-6 text-foreground"
          >
            {props.text}
          </Text>
        ) : null}
      </View>
    </View>
  );
});
