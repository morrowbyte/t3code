import { Button } from "../../components/ui/Button";
import { QuestionAttachments } from "./QuestionAttachments";
import { UserFormField } from "./UserFormField";
import {
  questionDictationBlocksSubmission,
  questionDictationOwnerKey,
  questionDictationRequestKey,
} from "./questionDictationDraft";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { useThreadSelection } from "../../state/use-thread-selection";
import type { EnvironmentId, RuntimeRequestId, ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import {
  markdownProseDirection,
  textDirection,
  type TextDirection,
} from "@t3tools/shared/textDirection";
import { useRef } from "react";
import { Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { cn } from "../../lib/cn";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useThreadShell } from "../../state/entities";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useLiveThreadLinkLabels } from "../../state/entities";
import {
  isPendingUserInputOptionSelected,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import type { PendingUserInput } from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly origin?: ScopedThreadRef | undefined;
  readonly environmentId: EnvironmentId;
  readonly canOperateThread: boolean;
  readonly pendingUserInput: PendingUserInput;
  readonly maxHeight: DerivedValue<number>;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onStopThread?: () => void;
  readonly inline?: boolean;
  readonly cardProgress?: SharedValue<number>;
  readonly cardCoverage?: SharedValue<number>;
  readonly onInputFocusChange?: (focused: boolean) => void;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly onSelectOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
  readonly onDismiss: () => Promise<unknown>;
}

function proseDirectionStyle(text: string, setDirection: TextDirection | undefined) {
  const direction = textDirection(text);
  return {
    ...(direction ? { direction, writingDirection: direction } : null),
    textAlign: (direction === "rtl") === (setDirection === "rtl") ? "left" : "right",
  } as const;
}

function QuestionText(props: {
  readonly markdown: string;
  readonly origin?: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly setDirection: TextDirection | undefined;
}) {
  const styles = useMarkdownPreviewStyles();
  const markdown = useLiveThreadLinkLabels(props.markdown, props.environmentId);
  const thread = useThreadShell(props.origin ?? null);
  const openLink = useOpenPullRequest(
    thread
      ? { context: { environmentId: thread.environmentId, projectId: thread.projectId } }
      : undefined,
  );
  return (
    <SelectableMarkdownText
      markdown={markdown}
      textStyle={styles.nativeTextStyle}
      writingDirection={markdownProseDirection(markdown)}
      // Android's renderer aligns relative to each paragraph's direction.
      textAlign={
        Platform.OS === "android" ? undefined : props.setDirection === "rtl" ? "right" : "left"
      }
      onLinkPress={(href) => void openLink(href)}
    />
  );
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const { selectedThread } = useThreadSelection();
  const origin =
    props.origin ??
    (selectedThread
      ? { environmentId: selectedThread.environmentId, threadId: selectedThread.id }
      : null);
  const voice = useGlobalVoiceInput();
  const dictatingAnswer = questionDictationBlocksSubmission(
    origin,
    props.pendingUserInput.requestId,
    voice.ownerKey,
    voice.state,
  );
  const questionCount = props.pendingUserInput.questions.length;
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const responseDisabled = !canRespond || isResponding;
  const setDirection = markdownProseDirection(
    props.pendingUserInput.questions
      .flatMap((question) => [
        question.header,
        question.question,
        ...question.options.flatMap((option) => [option.label, option.description ?? ""]),
      ])
      .join(" "),
  );

  const defaultProgress = useSharedValue(1);
  const defaultCoverage = useSharedValue(0);
  const cardProgress = props.cardProgress ?? defaultProgress;
  const cardCoverage = props.cardCoverage ?? defaultCoverage;
  const { maxHeight } = props;
  const inline = props.inline === true;
  const barHeightRef = useRef(0);
  const cardHeightRef = useRef(0);
  const cardHeight = useSharedValue(0);
  const notifyCoverage = () => {
    // The card resizes with the keyboard every frame, so easing each sample would leave the
    // feed inset and floating controls trailing it.
    cardCoverage.set(Math.max(0, cardHeightRef.current - barHeightRef.current));
  };
  const handleBarLayout = (event: LayoutChangeEvent) => {
    barHeightRef.current = event.nativeEvent.layout.height;
    notifyCoverage();
  };
  const handleCardLayout = (event: LayoutChangeEvent) => {
    cardHeightRef.current = event.nativeEvent.layout.height;
    cardHeight.set(event.nativeEvent.layout.height);
    notifyCoverage();
  };
  const cardAnimatedStyle = useAnimatedStyle(() => {
    if (inline) return { maxHeight: maxHeight.value };
    const progress = cardProgress.value;
    const travel = Platform.OS === "android" ? cardCoverage.value : cardHeight.value;
    return {
      maxHeight: maxHeight.value,
      opacity:
        Platform.OS === "android"
          ? Math.min(1, (progress * cardHeight.value) / Math.max(1, cardHeight.value - travel))
          : 1,
      transform: [{ translateY: (1 - progress) * travel }],
    };
  });
  // Android hit-tests inside the parent; its height is also the space the card takes below the feed.
  const androidBoundsStyle = useAnimatedStyle(() => ({
    paddingTop: cardCoverage.value * cardProgress.value,
  }));
  const overlayHeightStyle = useAnimatedStyle(() => ({ height: maxHeight.value }));

  const bar = (
    <View
      onLayout={handleBarLayout}
      pointerEvents={props.collapsed ? "auto" : "none"}
      accessibilityElementsHidden={!props.collapsed}
      importantForAccessibility={props.collapsed ? "auto" : "no-hide-descendants"}
      className="flex-row items-center gap-2 rounded-full border border-border bg-card-alt py-1.5 pl-4 pr-1.5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Expand user input, ${questionCount} question${
          questionCount === 1 ? "" : "s"
        }`}
        onPress={props.onToggleCollapsed}
        className="min-h-10 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          User input needed
        </Text>
        <Text className="font-sans text-xs text-foreground-muted">
          {questionCount} question{questionCount === 1 ? "" : "s"}
        </Text>
        <View className="flex-1" />
        <SymbolView
          name="chevron.up"
          size={12}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      </Pressable>
      {props.onStopThread ? (
        <ControlPill
          accessibilityLabel="Stop"
          icon="stop.fill"
          variant="danger"
          className="h-9 w-9"
          disabled={!props.canOperateThread}
          onPress={props.onStopThread}
        />
      ) : null}
    </View>
  );
  const card = (
    <Animated.View
      onLayout={handleCardLayout}
      pointerEvents={props.collapsed ? "none" : "auto"}
      accessibilityElementsHidden={props.collapsed}
      importantForAccessibility={props.collapsed ? "no-hide-descendants" : "auto"}
      className="overflow-hidden gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
      style={cardAnimatedStyle}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Collapse user input"
        onPress={props.onToggleCollapsed}
        className="flex-row items-start gap-2"
      >
        <View className="flex-1 gap-2.5">
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
            User input needed
          </Text>
          <Text className="font-t3-bold text-lg text-foreground">
            {props.pendingUserInput.questions.some((question) => question.field)
              ? props.pendingUserInput.questions[0]?.header
              : "Fill in the pending answers"}
          </Text>
        </View>
        <View className="h-8 w-8 items-center justify-center rounded-full bg-subtle-strong">
          <SymbolView
            name="chevron.down"
            size={13}
            tintColorClassName={"accent-icon-subtle"}
            type="monochrome"
          />
        </View>
      </Pressable>
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-2.5 pb-1"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ flexShrink: 1 }}
      >
        {!canRespond ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            The provider process for this request is no longer available. Interrupt or restart the
            run to continue.
          </Text>
        ) : null}
        {props.pendingUserInput.questions.map((question) => {
          const draft = props.drafts[question.id];
          if (question.field)
            return (
              <UserFormField
                key={question.id}
                field={question.field}
                draft={draft}
                disabled={responseDisabled || !props.canOperateThread}
                onChange={(value) =>
                  props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
                }
                onToggle={(value) =>
                  props.onSelectOption(props.pendingUserInput.requestId, question, value)
                }
                onInputFocusChange={props.onInputFocusChange}
              />
            );
          return (
            <View key={question.id} className="gap-2 pt-1">
              <Text
                className="font-t3-bold text-xs uppercase tracking-[1px] text-foreground-muted"
                style={proseDirectionStyle(question.header, setDirection)}
              >
                {question.header}
              </Text>
              <QuestionText
                origin={origin ?? undefined}
                markdown={question.question}
                environmentId={props.environmentId}
                setDirection={setDirection}
              />
              <View className="gap-2">
                {question.options.map((option) => {
                  const optionValue = option.value ?? option.label.trim();
                  const selected = isPendingUserInputOptionSelected(question, draft, optionValue);
                  const description =
                    option.description !== option.label ? option.description : undefined;
                  return (
                    <Pressable
                      key={optionValue}
                      accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                      accessibilityState={{ checked: selected, disabled: responseDisabled }}
                      disabled={responseDisabled}
                      className={cn(
                        "min-h-12 w-full rounded-2xl border px-3.5 py-3",
                        selected ? "border-primary bg-primary/10" : "border-border bg-input",
                      )}
                      onPress={() =>
                        props.onSelectOption(
                          props.pendingUserInput.requestId,
                          question,
                          optionValue,
                        )
                      }
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text
                          className={cn(
                            "font-t3-bold text-sm",
                            selected ? "text-foreground" : "text-foreground-secondary",
                          )}
                          style={proseDirectionStyle(option.label, setDirection)}
                        >
                          {option.label}
                        </Text>
                        {description ? (
                          <Text
                            className="font-sans text-sm leading-5 text-foreground-muted"
                            style={proseDirectionStyle(description, setDirection)}
                          >
                            {description}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              {question.allowCustomAnswer !== false ? (
                <QuestionAttachments
                  key={
                    origin
                      ? questionDictationOwnerKey(
                          origin,
                          props.pendingUserInput.requestId,
                          question.id,
                        )
                      : question.id
                  }
                  origin={origin ?? undefined}
                  requestId={props.pendingUserInput.requestId}
                  question={question}
                  questions={props.pendingUserInput.questions}
                  disabled={responseDisabled}
                  dictationDisabled={!props.canOperateThread || props.collapsed}
                  value={draft?.customAnswer ?? ""}
                  onChangeText={(value) =>
                    props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
                  }
                  onInputFocusChange={props.onInputFocusChange}
                />
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      <Button
        label="Submit answers"
        fullWidth
        tone={props.answers ? "primary" : "secondary"}
        disabled={
          !props.canOperateThread || responseDisabled || dictatingAnswer || props.answers === null
        }
        onPress={() => {
          if (
            questionDictationBlocksSubmission(
              origin,
              props.pendingUserInput.requestId,
              voice.session.ownerKey,
              voice.session.controller.currentState,
            )
          )
            return;
          void props.onSubmit();
        }}
      />
      {props.pendingUserInput.dismissible ? (
        <Button
          label={
            props.pendingUserInput.questions.some((question) => question.field)
              ? "Cancel"
              : "Dismiss without answering"
          }
          tone="text"
          disabled={isResponding || !props.canOperateThread}
          onPress={() => {
            if (
              origin &&
              voice.session.ownerKey?.startsWith(
                questionDictationRequestKey(origin, props.pendingUserInput.requestId),
              )
            )
              voice.session.cancel(voice.session.ownerKey);
            void props.onDismiss();
          }}
        />
      ) : null}
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-tertiary">
          This connection cannot submit answers.
        </Text>
      ) : null}
    </Animated.View>
  );
  if (inline) return props.collapsed ? bar : card;
  return (
    <Animated.View
      className="relative"
      style={Platform.OS === "android" ? androidBoundsStyle : undefined}
    >
      {bar}
      <Animated.View
        pointerEvents={props.collapsed ? "none" : "box-none"}
        className="absolute inset-x-0 bottom-0 justify-end overflow-hidden"
        style={overlayHeightStyle}
      >
        {card}
      </Animated.View>
    </Animated.View>
  );
}
