import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

import type { FileBackedComposerAttachment } from "../lib/composerImages";
import type { MediaActionsSource } from "../lib/mediaActionsSource";
import type { SendImageAnnotation } from "../lib/imageAnnotation";

interface FilePreviewMetadata {
  readonly kind: "image" | "pdf" | "document";
  readonly mimeType?: string;
  readonly name?: string;
  readonly sourceIdentifier?: string;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
  readonly onApplyAnnotation?: SendImageAnnotation;
}

export type FilePreviewItem = FilePreviewMetadata &
  (
    | { readonly uri: string }
    | { readonly attachment: FileBackedComposerAttachment }
    | { readonly environmentId: EnvironmentId; readonly resource: AssetResource }
  );

export type FilePreviewSource = FilePreviewItem & {
  readonly gallery?: readonly FilePreviewItem[];
};

export interface ResolvedFilePreviewSource extends FilePreviewMetadata {
  readonly uri: string;
  readonly gallery?: readonly (FilePreviewMetadata & { readonly uri: string })[];
}
