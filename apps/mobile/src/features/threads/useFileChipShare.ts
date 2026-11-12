import * as Dialog from "../../components/ui/Dialog";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import {
  downloadAndSaveAttachment,
  downloadAndShareAttachment,
} from "../../lib/attachmentDownload";
import { refreshAssetUrl } from "../../state/assets";
import { fileChipShareSource, type FileChipTarget } from "./fileChipMenu";

export function useFileChipShare(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sourceIdentifier: string,
) {
  const requestRef = useRef<Partial<Record<"save" | "share", AbortController>>>({});
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts in-flight file downloads when the component unmounts
  useEffect(
    () => () => {
      for (const request of Object.values(requestRef.current)) request.abort();
    },
    [],
  );

  return (target: FileChipTarget, operation: "save" | "share" = "share") => {
    const source = fileChipShareSource(target, threadId);
    if (!source || requestRef.current[operation]) return;
    const request = new AbortController();
    requestRef.current[operation] = request;
    void (async () => {
      const url = await refreshAssetUrl(environmentId, source.resource, request.signal);
      if (request.signal.aborted) return;
      if (url === null) throw new Error("The file could not be loaded. Reconnect and try again.");
      const input = { url, attachment: source, signal: request.signal };
      if (operation === "save") {
        if ((await downloadAndSaveAttachment(input)) && !request.signal.aborted) {
          Dialog.alert("File saved", source.name);
        }
      } else {
        await downloadAndShareAttachment({ ...input, sourceIdentifier });
      }
    })()
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          Dialog.alert(
            operation === "save" ? "Could not save file" : "Could not share file",
            error instanceof Error ? error.message : "Try again.",
          );
        }
      })
      .finally(() => {
        if (requestRef.current[operation] === request) {
          delete requestRef.current[operation];
        }
      });
  };
}
