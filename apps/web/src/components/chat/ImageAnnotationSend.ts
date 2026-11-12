import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import {
  useComposerDraftStore,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  type DraftId,
} from "../../composerDraftStore";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { releaseDraftAttachment } from "../../lib/attachmentUploadQueue";
import { newDraftId, randomUUID } from "../../lib/utils";

export interface ImageAnnotationSubmission {
  readonly image: ComposerImageAttachment;
  readonly text: string;
  readonly draftTarget: DraftId;
  readonly isCurrent: () => boolean;
}

export async function applyImageAnnotation(input: {
  readonly file: File;
  readonly text: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly draftTarget: ComposerThreadTarget;
  readonly image: ComposerImageAttachment;
  readonly onComment?: (text: string) => void;
}): Promise<boolean> {
  const isCurrent = () => !input.signal.aborted && input.isCurrent();
  if (!isCurrent()) return false;
  const prepared = await prepareImageForAttachment(input.file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!isCurrent()) return false;
  if (!prepared.ok) throw new Error("The annotated image could not be prepared.");
  const image: ComposerImageAttachment = {
    ...input.image,
    name: prepared.file.name,
    mimeType: prepared.file.type,
    sizeBytes: prepared.file.size,
    file: prepared.file,
    previewUrl: URL.createObjectURL(prepared.file),
  };
  const store = useComposerDraftStore.getState();
  if (!store.replaceImage(input.draftTarget, input.image, image)) {
    URL.revokeObjectURL(image.previewUrl);
    return false;
  }
  releaseDraftAttachment(input.image);
  if (input.text.trim()) {
    if (input.onComment) input.onComment(input.text);
    else {
      const prompt = store.getComposerDraft(input.draftTarget)?.prompt ?? "";
      store.setPrompt(input.draftTarget, `${prompt}${prompt ? "\n\n" : ""}${input.text}`);
    }
  }
  return true;
}

export async function sendImageAnnotation(input: {
  readonly file: File;
  readonly text: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly send: (submission: ImageAnnotationSubmission) => Promise<boolean>;
}): Promise<boolean> {
  const isCurrent = () => !input.signal.aborted && input.isCurrent();
  if (!isCurrent()) return false;
  const prepared = await prepareImageForAttachment(input.file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!isCurrent()) return false;
  if (!prepared.ok) throw new Error("The annotated image could not be prepared for sending.");
  const draftTarget = newDraftId();
  const image: ComposerImageAttachment = {
    type: "image",
    id: randomUUID(),
    name: prepared.file.name,
    mimeType: prepared.file.type,
    sizeBytes: prepared.file.size,
    file: prepared.file,
    previewUrl: URL.createObjectURL(prepared.file),
  };
  const store = useComposerDraftStore.getState();
  store.setPrompt(draftTarget, input.text);
  store.addImages(draftTarget, [image]);
  try {
    return await input.send({ image, text: input.text, draftTarget, isCurrent });
  } finally {
    releaseDraftAttachment(image);
    store.clearDraftThread(draftTarget);
  }
}
