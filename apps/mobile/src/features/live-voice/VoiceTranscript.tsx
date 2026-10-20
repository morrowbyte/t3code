import type { LiveVoiceState } from "@t3tools/client-runtime/live-voice";
import { useRef, useState, type ComponentRef } from "react";
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import * as Dialog from "../../components/ui/Dialog";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";

export function VoiceTranscript(props: { readonly entries: LiveVoiceState["transcript"] }) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const following = useRef(true);
  const gesturing = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const setFollowing = (next: boolean) => {
    following.current = next;
    setShowLatest(!next);
  };
  const atEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    return contentSize.height - contentOffset.y - layoutMeasurement.height <= 24;
  };
  const follow = () => {
    if (following.current) scroll.current?.scrollToEnd({ animated: false });
  };
  const finishGesture = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    gesturing.current = false;
    setFollowing(atEnd(event));
  };
  return (
    <View className="gap-1">
      <ScrollView
        ref={scroll}
        testID="voice-transcript"
        nestedScrollEnabled
        style={{ maxHeight: 160 }}
        scrollEventThrottle={16}
        onLayout={follow}
        onContentSizeChange={follow}
        onScrollBeginDrag={() => {
          gesturing.current = true;
          setFollowing(false);
        }}
        onScroll={(event) => {
          if (gesturing.current && !atEnd(event)) setFollowing(false);
        }}
        onScrollEndDrag={finishGesture}
        onMomentumScrollBegin={() => {
          gesturing.current = true;
        }}
        onMomentumScrollEnd={finishGesture}
      >
        {props.entries.map((entry, index) => (
          <View key={index} className="pb-2">
            <View className="flex-row items-center justify-between gap-2">
              <AppText className="text-xs font-t3-medium text-foreground-muted">
                {entry.speaker === "user" ? "You" : "Assistant"}
                {entry.final ? "" : "…"}
              </AppText>
              <IconButton
                icon="doc.on.doc"
                accessibilityLabel={`Copy ${entry.speaker === "user" ? "your" : "assistant"} transcript message ${index + 1}`}
                onPress={() => {
                  void tryCopyTextWithHaptic(entry.text).then((copied) => {
                    if (!copied) Dialog.alert("Could not copy", "Try again.");
                  });
                }}
              />
            </View>
            <AppText selectable className="text-sm text-foreground">
              {entry.text}
            </AppText>
          </View>
        ))}
      </ScrollView>
      {showLatest ? (
        <Button
          label="Zum Neuesten"
          tone="text"
          onPress={() => {
            setFollowing(true);
            scroll.current?.scrollToEnd({ animated: false });
          }}
        />
      ) : null}
    </View>
  );
}
