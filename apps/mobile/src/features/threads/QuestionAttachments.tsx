import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Dialog from "../../components/ui/Dialog";
import { TextInputWrapper } from "expo-paste-input";
import { QuestionAnswerInput } from "./QuestionAnswerInput";
import { useNativePaste } from "../../lib/useNativePaste";
import { convertPastedImagesToAttachments } from "../../lib/composerImages";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ScopedThreadRef,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { ComposerAttachmentButton } from "./ComposerAttachmentButton";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { pickComposerFiles, pickComposerMedia } from "../../lib/composerImages";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useNavigation } from "@react-navigation/native";
import {
  FilePreviewModal,
  type FilePreviewItem,
  type FilePreviewSource,
} from "../../components/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { useServerConfigs } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import { applyComposerImageAnnotation } from "../../state/apply-image-annotation";
import { composerImageGallery } from "../../lib/composerImageGallery";
import { filePreviewKey } from "../../lib/filePreviewGallery";
import type { SendImageAnnotation } from "../../lib/imageAnnotation";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  removeComposerDraftAttachment,
  releaseUnusedComposerAttachmentFiles,
} from "../../state/use-composer-drafts";
import {
  changeQuestionAttachmentPreparation,
  questionAttachmentDraftKey,
  questionAttachmentPreparationAtom,
} from "../../state/question-attachments";

export function QuestionAttachments(props: {
  origin?: ScopedThreadRef | undefined;
  requestId: string;
  question: UserInputQuestion;
  questions: ReadonlyArray<UserInputQuestion>;
  disabled: boolean;
  dictationDisabled: boolean;
  value: string;
  onChangeText: (value: string) => void;
  onInputFocusChange?: ((focused: boolean) => void) | undefined;
}) {
  const { selectedThread } = useThreadSelection();
  const origin =
    props.origin ??
    (selectedThread
      ? { environmentId: selectedThread.environmentId, threadId: selectedThread.id }
      : null);
  const key = origin
    ? questionAttachmentDraftKey(
        origin.environmentId,
        origin.threadId,
        props.requestId,
        props.question.id,
      )
    : null;
  const navigation = useNavigation();
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const configs = useServerConfigs();
  const drafts = useAtomValue(composerDraftsAtom);
  const focusedRef = useRef(false);
  const onInputFocusChange = props.onInputFocusChange;
  const annotationTarget = useRef({
    key,
    disabled: props.disabled,
    value: props.value,
    onChangeText: props.onChangeText,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Async annotation callbacks must use the committed question, response lock and answer.
  useLayoutEffect(() => {
    annotationTarget.current = {
      key,
      disabled: props.disabled,
      value: props.value,
      onChangeText: props.onChangeText,
    };
  }, [key, props.disabled, props.value, props.onChangeText]);
  // The caller keys this component by request and question, so unmounting ends any open
  // picker's scope.
  const pickerScope = useRef<{ active: boolean }>({ active: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens a scope that native picker and paste callbacks check, and closes it on unmount
  useLayoutEffect(() => {
    const scope = { active: true };
    pickerScope.current = scope;
    return () => {
      scope.active = false;
    };
  }, []);
  // Unmounted inputs never emit onBlur; explicitly release keyboard ownership.
  const releaseFocus = useEffectEvent(() => {
    if (focusedRef.current) onInputFocusChange?.(false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases keyboard ownership on unmount, since an unmounted native input never emits blur
  useEffect(() => () => releaseFocus(), []);
  const append = (
    key: string,
    attachments: Parameters<typeof appendComposerDraftAttachments>[1],
  ) => {
    if (!origin) return 0;
    const current = appAtomRegistry.get(composerDraftsAtom);
    const otherCount = props.questions.reduce((count, question) => {
      const target = questionAttachmentDraftKey(
        origin.environmentId,
        origin.threadId,
        props.requestId,
        question.id,
      );
      return target === key ? count : count + (current[target]?.attachments.length ?? 0);
    }, 0);
    return appendComposerDraftAttachments(key, attachments, {
      maxAttachments: Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - otherCount),
    });
  };
  const paste = useNativePaste((uris) => {
    const scope = pickerScope.current;
    if (!origin || props.disabled || !configs.get(origin.environmentId)) return;
    const key = questionAttachmentDraftKey(
      origin.environmentId,
      origin.threadId,
      props.requestId,
      props.question.id,
    );
    changeQuestionAttachmentPreparation(key, 1);
    void convertPastedImagesToAttachments({
      uris,
      existingCount: appAtomRegistry.get(composerDraftsAtom)[key]?.attachments.length ?? 0,
    })
      .then(async (images) => {
        if (
          scope.active &&
          (appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0
        ) {
          if (append(key, images) > 0)
            Dialog.alert("Could not paste image", "Too many attachments.");
        } else await releaseUnusedComposerAttachmentFiles(images);
      })
      .catch((error) =>
        Dialog.alert(
          "Could not paste image",
          error instanceof Error ? error.message : "Try again.",
        ),
      )
      .finally(() => changeQuestionAttachmentPreparation(key, -1));
  });
  if (!origin || !key || props.question.allowCustomAnswer === false) return null;
  const { environmentId, threadId } = origin;
  const capabilities = configs.get(environmentId)?.environment.capabilities;
  const canAttach = capabilities !== undefined;
  const attachments = drafts[key]?.attachments ?? [];
  const getImageAnnotation = (item: FilePreviewItem) => {
    const attachmentId = "attachment" in item ? item.attachment.id : item.draftAttachmentId;
    const attachment = attachments.find((entry) => entry.id === attachmentId);
    if (!attachment) return undefined;
    return (async (image, text, signal) => {
      const scope = pickerScope.current;
      const isCurrent = () =>
        scope.active &&
        navigation.isFocused() &&
        annotationTarget.current.key === key &&
        !annotationTarget.current.disabled;
      if (!isCurrent()) return false;
      changeQuestionAttachmentPreparation(key, 1);
      return applyComposerImageAnnotation({
        draftKey: key,
        attachmentId: attachment.id,
        image,
        text,
        signal,
        isCurrent: () =>
          isCurrent() && (appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0,
        onComment: (comment) => {
          const target = annotationTarget.current;
          target.onChangeText(`${target.value}${target.value ? "\n\n" : ""}${comment}`);
        },
      }).finally(() => changeQuestionAttachmentPreparation(key, -1));
    }) satisfies SendImageAnnotation;
  };
  const openPreview = (source: FilePreviewSource) => {
    if (source.kind !== "image") {
      setPreviewFile(source);
      return;
    }
    const gallery = composerImageGallery(attachments).map((item) => ({
      ...item,
      onApplyAnnotation: getImageAnnotation(item),
    }));
    setPreviewFile({
      ...source,
      gallery,
      onApplyAnnotation: gallery.find((item) => filePreviewKey(item) === filePreviewKey(source))
        ?.onApplyAnnotation,
    });
  };
  const pick = async (kind: "media" | "files") => {
    const scope = pickerScope.current;
    changeQuestionAttachmentPreparation(key, 1);
    const picked = await settlePromise(async () => {
      const existingCount = appAtomRegistry.get(composerDraftsAtom)[key]?.attachments.length ?? 0;
      const result =
        kind === "files"
          ? await pickComposerFiles({
              existingCount,
              maxBytes: capabilities?.fileAttachments?.maxUploadBytes,
            })
          : await pickComposerMedia({
              existingCount,
              maxVideoBytes: capabilities?.fileAttachments?.maxUploadBytes,
            });
      const picked = "files" in result ? result.files : result.attachments;
      // Resolution on another client clears the reservation while the picker is open.
      if (
        !scope.active ||
        (appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) === 0
      ) {
        await releaseUnusedComposerAttachmentFiles(picked);
        return;
      }
      const rejected = append(key, picked);
      if (result.error || rejected > 0)
        Dialog.alert("Could not attach file", result.error ?? "Too many attachments.");
    });
    changeQuestionAttachmentPreparation(key, -1);
    if (AsyncResult.isFailure(picked)) {
      const error = squashAtomCommandFailure(picked);
      Dialog.alert("Could not attach file", error instanceof Error ? error.message : "Try again.");
    }
  };
  return (
    <View className="gap-2">
      {canAttach ? (
        <ComposerAttachmentButton
          disabled={props.disabled}
          supportsFiles
          onPickMedia={() => pick("media")}
          onPickFiles={() => pick("files")}
        />
      ) : null}
      <ComposerAttachmentStrip
        environmentId={environmentId}
        attachments={attachments}
        onRemove={(id) => {
          if (!props.disabled) removeComposerDraftAttachment(key, id);
        }}
        onPressPreview={openPreview}
        onPressVideo={(attachment, sourceIdentifier) =>
          setPreviewVideo({ type: "local", attachment, sourceIdentifier })
        }
        onPressDocument={(attachment) =>
          navigation.navigate("ThreadAttachment", {
            environmentId: String(environmentId),
            threadId: String(threadId),
            attachmentId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: String(attachment.sizeBytes),
            draftKey: key,
          })
        }
      />
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
      <VideoPreviewModal source={previewVideo} onRequestClose={() => setPreviewVideo(null)} />
      <TextInputWrapper onPaste={paste}>
        <QuestionAnswerInput
          origin={origin}
          requestId={props.requestId}
          questionId={props.question.id}
          label={props.question.header}
          value={props.value}
          multiline={props.question.initialAnswer !== undefined}
          disabled={props.disabled}
          dictationDisabled={props.dictationDisabled}
          onChangeText={props.onChangeText}
          onFocus={() => {
            focusedRef.current = true;
            onInputFocusChange?.(true);
          }}
          onBlur={() => {
            focusedRef.current = false;
            onInputFocusChange?.(false);
          }}
        />
      </TextInputWrapper>
    </View>
  );
}
