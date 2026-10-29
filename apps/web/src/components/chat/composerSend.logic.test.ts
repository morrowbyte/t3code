import {
  EnvironmentId,
  ThreadId,
  type PreviewAnnotationPayload,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  retainUnavailablePreviewAnnotation,
  approvalRedirectNotice,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
} from "./composerSend.logic";

import { useComposerDraftStore, type ComposerImageAttachment } from "../../composerDraftStore";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import { previewAnnotationContextReference } from "../../lib/composerContextRecords";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");
const remoteThread = threadContextRecord(scopeThreadRef(remote, ThreadId.make("b")), "Remote");

describe("referencedThreadContexts", () => {
  it("keeps only the attached threads the prompt still links", () => {
    const prompt = `see ${formatInlineContextReference(threadContextReference(remoteThread))}`;
    expect(
      referencedThreadContexts({ prompt, threadContexts: [localThread, remoteThread] }),
    ).toEqual([remoteThread]);
  });
});

describe("loadBalancingSendWarning", () => {
  it("asks the user to wait while resource checks run", () => {
    expect(
      loadBalancingSendWarning({
        pending: true,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [],
      }).title,
    ).toBe("Checking machine resources");
  });

  it("blames the attached threads when no machine can read all of them", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [local, remote],
      }).description,
    ).toMatch(/No machine can read every attached thread/);
  });

  it("blames resources when one machine can read every attached thread", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread],
        candidateEnvironmentIds: [remote, local],
      }).description,
    ).toMatch(/No eligible machine has available resources/);
  });
});

describe("multipleModelSendBlock", () => {
  const ready = {
    selectionCount: 2,
    serverSupportsWorktreeBootstrap: true,
    isLocalDraftThread: true,
    isGitRepo: true,
    branch: "main",
  };

  it("lets a new Git draft with a branch and models start", () => {
    expect(multipleModelSendBlock(ready)).toBeNull();
  });

  it("asks for a server update before checking the draft", () => {
    expect(
      multipleModelSendBlock({
        ...ready,
        serverSupportsWorktreeBootstrap: false,
        isGitRepo: false,
      }),
    ).toBe("server-outdated");
  });

  it.each([
    { isLocalDraftThread: false },
    { isGitRepo: false },
    { branch: null },
    { selectionCount: 0 },
  ])("needs a new Git thread with a branch and models (%o)", (override) => {
    expect(multipleModelSendBlock({ ...ready, ...override })).toBe("needs-new-git-thread");
  });
});

describe("approvalRedirectNotice", () => {
  const settled = {
    draftChanged: false,
    declined: true,
    approvalResponding: false,
    approvalArrived: false,
  };

  it("says the decline went through when the draft changed after it", () => {
    expect(approvalRedirectNotice({ ...settled, draftChanged: true })).toBe(
      "Approval declined. Your message changed, so it wasn't sent.",
    );
    expect(approvalRedirectNotice({ ...settled, draftChanged: true, declined: false })).toBe(
      "Your message changed, so it wasn't sent.",
    );
  });

  it("explains an approval already being answered", () => {
    expect(
      approvalRedirectNotice({ ...settled, declined: false, approvalResponding: true }),
    ).toMatch(/already being answered/);
  });

  it("explains an approval that arrived during the decline", () => {
    expect(approvalRedirectNotice({ ...settled, approvalArrived: true })).toMatch(
      /Another approval arrived/,
    );
  });

  it("stays quiet when the decline failed or the user left the thread", () => {
    expect(approvalRedirectNotice({ ...settled, declined: false })).toBeNull();
    expect(approvalRedirectNotice(settled)).toBeNull();
  });
});

afterEach(() => useComposerDraftStore.setState({ draftsByThreadKey: {} }));

describe("unavailable direct preview send", () => {
  const target = scopeThreadRef(local, ThreadId.make("preview-draft"));
  const annotation: PreviewAnnotationPayload = {
    id: "picked",
    pageUrl: "http://app.test",
    pageTitle: "Form",
    comment: "Check this",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: {
      dataUrl: "data:image/png;base64,AA==",
      width: 1,
      height: 1,
      cropRect: { x: 0, y: 0, width: 1, height: 1 },
    },
    createdAt: "2026-10-28T00:00:00.000Z",
  };
  const image: ComposerImageAttachment = {
    type: "image",
    id: "picked",
    name: "crop.png",
    mimeType: "image/png",
    sizeBytes: 1,
    file: new File(["x"], "crop.png", { type: "image/png" }),
    previewUrl: "data:image/png;base64,AA==",
  };
  it("retains context, optional crop and a sendable reference while preserving the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "Existing request");
    expect(retainUnavailablePreviewAnnotation(target, { annotation, image })).toBe(true);
    expect(retainUnavailablePreviewAnnotation(target, { annotation, image })).toBe(true);
    const draft = store.getComposerDraft(target);
    expect(draft?.previewAnnotations).toEqual([
      { ...annotation, screenshot: { ...annotation.screenshot, dataUrl: "" } },
    ]);
    expect(draft?.images).toEqual([image]);
    expect(draft?.prompt).toBe(
      ensureInlineContextReferences("Existing request", [
        previewAnnotationContextReference(annotation),
      ]),
    );
  });
  it("keeps structured context without claiming a crop rejected by the attachment cap", () => {
    const store = useComposerDraftStore.getState();
    store.addImages(
      target,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
        ...image,
        id: `full-${index}`,
        name: `full-${index}.png`,
      })),
      { allowDuplicates: true },
    );
    retainUnavailablePreviewAnnotation(target, { annotation, image });
    expect(store.getComposerDraft(target)?.previewAnnotations).toEqual([
      { ...annotation, screenshot: null },
    ]);
    expect(store.getComposerDraft(target)?.images).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
  });
  it("keeps comment-free context without an optional image and leaves ordinary sends alone", () => {
    expect(retainUnavailablePreviewAnnotation(target, undefined)).toBe(false);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
    retainUnavailablePreviewAnnotation(target, {
      annotation: { ...annotation, comment: "", screenshot: null },
      image: null,
    });
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.previewAnnotations).toEqual([
      { ...annotation, comment: "", screenshot: null },
    ]);
  });
});
