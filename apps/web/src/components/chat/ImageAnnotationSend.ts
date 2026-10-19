import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import {
  useComposerDraftStore,
  type ComposerImageAttachment,
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
