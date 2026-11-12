import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useThreadShell } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { requestThreadMessageJump } from "./threadMessageJump";
import type { readAgentReply } from "./agent-message-presentation";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function AgentReplyReference({
  reply,
}: {
  readonly reply: NonNullable<ReturnType<typeof readAgentReply>>;
}) {
  const threadRef = scopeThreadRef(
    EnvironmentId.make(reply.environmentId),
    ThreadId.make(reply.threadId),
  );
  const thread = useThreadShell(threadRef);
  const messageText = useAtomValue(
    environmentThreadDetails.threadAtom(threadRef),
    (detail) =>
      detail?.projection.messages.find((message) => message.id === reply.messageId)?.text ?? null,
  );
  const openLinkedThread = useOpenLinkedThread();
  return (
    <View className="min-w-0 border-l-2 border-border pl-3">
      <Text className="text-sm text-foreground-muted">Antwort auf</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Thread öffnen: ${thread?.title ?? reply.threadId}, Nachricht ${reply.messageId}`}
        className="min-h-11 justify-center"
        onPress={() => {
          requestThreadMessageJump(
            scopedThreadKey(threadRef.environmentId, threadRef.threadId),
            MessageId.make(reply.messageId),
          );
          openLinkedThread(threadRef);
        }}
      >
        <Text numberOfLines={3} className="text-sm leading-5 text-foreground">
          {messageText || `Nachricht ${reply.messageId}`}
        </Text>
      </Pressable>
    </View>
  );
}
