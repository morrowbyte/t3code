import { EnvironmentId, ThreadId, type PreviewAnnotationPayload } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { usePreviewSelectionStore } from "./previewSelectionStore";

const ref = {
  environmentId: EnvironmentId.make("env-a"),
  threadId: ThreadId.make("thread-a"),
};
const annotation = (id: string): PreviewAnnotationPayload => ({
  id,
  pageUrl: "http://localhost:7191",
  pageTitle: "Demo",
  comment: "",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "2026-10-28T18:00:00.000Z",
});
beforeEach(() => usePreviewSelectionStore.setState({ byThreadKey: {} }));
describe("pending preview selection", () => {
  it("retains comment-free context and replaces it rather than accumulating targets", () => {
    const store = usePreviewSelectionStore.getState();
    store.replaceSelection(ref, annotation("first"));
    expect(usePreviewSelectionStore.getState().byThreadKey[scopedThreadKey(ref)]?.comment).toBe("");
    store.replaceSelection(ref, annotation("second"));
    expect(
      Object.values(usePreviewSelectionStore.getState().byThreadKey).map((value) => value.id),
    ).toEqual(["second"]);
  });
  it("isolates the same thread id on different environments and other threads", () => {
    const otherEnvironment = { ...ref, environmentId: EnvironmentId.make("env-b") };
    const otherThread = { ...ref, threadId: ThreadId.make("thread-b") };
    const store = usePreviewSelectionStore.getState();
    for (const target of [ref, otherEnvironment, otherThread])
      store.replaceSelection(target, annotation(scopedThreadKey(target)));
    store.clearSelection(ref);
    expect(usePreviewSelectionStore.getState().byThreadKey[scopedThreadKey(ref)]).toBeUndefined();
    expect(Object.keys(usePreviewSelectionStore.getState().byThreadKey)).toHaveLength(2);
  });
  it("does not let a delayed consumer clear a newer selection", () => {
    const store = usePreviewSelectionStore.getState();
    store.replaceSelection(ref, annotation("new"));
    store.clearSelection(ref, "old");
    expect(usePreviewSelectionStore.getState().byThreadKey[scopedThreadKey(ref)]?.id).toBe("new");
    store.clearSelection(ref, "new");
    expect(usePreviewSelectionStore.getState().byThreadKey).toEqual({});
  });
});
