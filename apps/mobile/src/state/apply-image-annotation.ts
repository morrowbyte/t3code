import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import {
  createComposerFileAttachment,
  removePersistedComposerAttachmentFile,
  type DraftComposerFileAttachment,
} from "../lib/composerImages";
import type { AnnotatedImage } from "../lib/imageAnnotation";
import { replaceComposerDraftAttachment } from "./use-composer-drafts";

export async function applyComposerImageAnnotation(
  input: {
    readonly image: AnnotatedImage;
    readonly text: string;
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
    readonly onComment?: (text: string) => void;
  } & (
    | { readonly draftKey: string; readonly attachmentId: string }
    | { readonly replaceAttachment: (attachment: DraftComposerFileAttachment) => boolean }
  ),
): Promise<boolean> {
  const isCurrent = () => !input.signal.aborted && input.isCurrent();
  if (!isCurrent()) return false;
  const attachment = await createComposerFileAttachment({
    uri: input.image.uri,
    name: input.image.name,
    mimeType: "image/png",
    sizeBytes: null,
    maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  });
  const applied =
    isCurrent() &&
    ("replaceAttachment" in input
      ? input.replaceAttachment(attachment)
      : replaceComposerDraftAttachment(
          input.draftKey,
          input.attachmentId,
          attachment,
          input.onComment ? "" : input.text,
        ));
  if (!applied) await removePersistedComposerAttachmentFile(attachment.fileUri);
  else if (input.text.trim()) input.onComment?.(input.text);
  return applied;
}
