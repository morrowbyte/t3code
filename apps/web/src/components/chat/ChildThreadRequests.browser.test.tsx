import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { DescendantThreadRequests } from "@t3tools/client-runtime/state/descendant-thread-requests";
import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    params,
    children,
    ...props
  }: {
    params: { environmentId: string; threadId: string };
    children: ReactNode;
  }) => (
    <a {...props} href={`/${params.environmentId}/${encodeURIComponent(params.threadId)}`}>
      {children}
    </a>
  ),
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: { environmentThreadsAtom: () => Atom.make([]) },
    environmentThreadDetails: {
      pendingRequestsAtom: () => Atom.make(null),
      statusAtom: () => Atom.make("live"),
    },
    threadEnvironment: {},
  };
});
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  readPreparedConnection: () => null,
  useEnvironmentScope: () => false,
}));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { stateAtom: vi.fn() } }));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: vi.fn() } }));
vi.mock("../../state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: vi.fn(), remove: vi.fn() },
}));
vi.mock("../../state/environments", () => ({ useEnvironment: () => null }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({ projectId: "original-child-project" }),
  useProject: (ref: { projectId: string } | null) =>
    ref?.projectId === "original-child-project"
      ? { workspaceRoot: "/original-child-project" }
      : null,
}));
vi.mock("../ChatMarkdown", () => ({
  default: ({
    text,
    cwd,
    threadRef,
  }: {
    text: string;
    cwd?: string;
    threadRef?: { threadId: string };
  }) => (
    <div data-question-cwd={cwd} data-question-thread={threadRef?.threadId}>
      {text}
    </div>
  ),
}));
vi.mock("../../lib/attachmentUploadQueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/attachmentUploadQueue")>();
  return {
    ...actual,
    startAttachmentUpload: vi.fn((input: Parameters<typeof actual.startAttachmentUpload>[0]) => {
      if (actual.useAttachmentUploadStore.getState().uploadsByImageId[input.image.id]) return;
      actual.useAttachmentUploadStore.setState((state) => ({
        uploadsByImageId: {
          ...state.uploadsByImageId,
          [input.image.id]: {
            status: "uploading",
            environmentId: input.environmentId,
            progress: 0,
          },
        },
      }));
    }),
    releaseDraftAttachment: vi.fn(),
    releaseDraftAttachments: vi.fn(),
  };
});
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: vi.fn() } }));

import { ChildThreadRequestsView } from "./ChildThreadRequests";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  questionAttachmentDraftId,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import { startAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";

const environmentId = EnvironmentId.make("environment:test-child-requests");
const requestId = RuntimeRequestId.make("request:test-original");
const origin = { environmentId, threadId: ThreadId.make("grandchild:test-origin") };
const question: ThreadPendingUserInput = {
  requestId,
  createdAt: "2026-10-19T00:00:00.000Z",
  responseCapability: "live",
  dismissible: false,
  questions: [
    {
      id: "scope",
      header: "Umfang",
      question: "Welcher Testumfang soll verwendet werden?",
      required: true,
      allowCustomAnswer: true,
      multiSelect: false,
      options: [
        { label: "Nur lokal", value: "  local  ", description: "Ohne externe Verbindung" },
        { label: "Mit Netzwerk", value: "network", description: "Externe Verbindung zulassen" },
      ],
    },
  ],
};
const group: DescendantThreadRequests = {
  origin,
  title: "Android · Aufnahme prüfen",
  runtimeMode: "approval-required",
  worktreePath: null,
  status: "live",
  requests: { approvals: [], userInputs: [question] },
};
const approval: DescendantThreadRequests = {
  ...group,
  requests: {
    userInputs: [],
    approvals: [
      {
        requestId,
        createdAt: question.createdAt,
        requestKind: "command",
        detail: "printf test-only",
        responseCapability: "live",
        options: [
          { label: "Ablehnen", decision: "decline" },
          { label: "Einmal erlauben", decision: "accept" },
        ],
      },
    ],
  },
};

let root: Root;
let container: HTMLDivElement;
const onReply = vi.fn(async () => null as string | null);

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useQuestionAttachmentPreparation.setState({ counts: {} });
  useAttachmentUploadStore.setState({ uploadsByImageId: {} });
  vi.mocked(startAttachmentUpload).mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onReply.mockReset();
  onReply.mockResolvedValue(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  groups: ReadonlyArray<DescendantThreadRequests> = [group],
  canOperate = true,
) {
  await act(async () =>
    root.render(
      <ChildThreadRequestsView groups={groups} canOperate={canOperate} onReply={onReply} />,
    ),
  );
}
function button(label: string, scope: ParentNode = container) {
  const result = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string, scope: ParentNode = container) {
  await act(async () => button(label, scope).click());
}
async function type(text: string) {
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("requests answered from an ancestor", () => {
  it("sends an attachment-only answer from the original child's question draft after its own environment upload is ready", async () => {
    const parent = { environmentId, threadId: ThreadId.make("visible-parent") };
    const parentFile = {
      type: "file" as const,
      id: "parent-file",
      name: "parent.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      file: new File(["parent"], "parent.txt", { type: "text/plain" }),
    };
    useComposerDraftStore.getState().addFiles(parent, [parentFile]);
    const attachmentQuestion = {
      ...question,
      questions: [
        {
          ...question.questions[0]!,
          options: [],
          question: "Attach the log from ./logs/upload.txt",
        },
      ],
    };
    const childGroup = {
      ...group,
      worktreePath: null,
      requests: { approvals: [], userInputs: [attachmentQuestion] },
    };
    await act(async () =>
      root.render(
        <ChildThreadRequestsView
          groups={[childGroup]}
          canOperate
          onReply={onReply}
          attachmentCapabilities={{
            attachmentUploadsCapabilityKnown: true,
            supportsAttachmentUploads: true,
            supportsQuestionAttachments: true,
            maxFileAttachmentBytes: 1024,
          }}
        />,
      ),
    );
    expect(container.querySelector("[data-question-cwd]")?.getAttribute("data-question-cwd")).toBe(
      "/original-child-project",
    );
    expect(
      container.querySelector("[data-question-thread]")?.getAttribute("data-question-thread"),
    ).toBe(origin.threadId);
    expect(button("Send answer").disabled).toBe(true);
    const picker = container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(picker.getAttribute("aria-label")).toBe("Question attachments");
    const files = new DataTransfer();
    files.items.add(new File(["upload failed:403"], "upload.txt", { type: "text/plain" }));
    await act(async () => {
      picker.files = files.files;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const key = questionAttachmentDraftId(environmentId, origin.threadId, requestId, "scope");
    const staged = useComposerDraftStore.getState().getComposerDraft(key)!.files[0]!;
    expect(startAttachmentUpload).toHaveBeenCalledWith({
      environmentId,
      image: staged,
      draftTarget: key,
    });
    expect(useComposerDraftStore.getState().getComposerDraft(parent)?.files).toEqual([parentFile]);
    expect(button("Send answer").disabled).toBe(true);
    expect(onReply).not.toHaveBeenCalled();
    await act(async () =>
      useAttachmentUploadStore.setState({
        uploadsByImageId: {
          [staged.id]: {
            status: "ready",
            environmentId: EnvironmentId.make("unrelated-environment"),
            attachmentId: "wrong-upload",
          },
        },
      }),
    );
    expect(button("Send answer").disabled).toBe(true);
    await act(async () =>
      useAttachmentUploadStore.setState({
        uploadsByImageId: {
          [staged.id]: { status: "ready", environmentId, attachmentId: "original-child-upload" },
        },
      }),
    );
    expect(button("Send answer").disabled).toBe(false);
    await click("Send answer");
    expect(onReply).toHaveBeenCalledExactlyOnceWith({
      type: "question",
      origin,
      requestId,
      answers: { scope: "" },
      attachmentsByQuestionId: {
        scope: [
          {
            type: "file",
            id: "original-child-upload",
            name: "upload.txt",
            mimeType: "text/plain",
            sizeBytes: 17,
          },
        ],
      },
    });
    await render([]);
    expect(useComposerDraftStore.getState().getComposerDraft(key)).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(parent)?.files).toEqual([parentFile]);
  });

  it("keeps number shortcuts inside child controls from answering the parent question", async () => {
    await render();
    const parentShortcut = vi.fn();
    document.addEventListener("keydown", parentShortcut);
    try {
      const option = button("Nur lokal");
      option.focus();
      option.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      expect(parentShortcut).not.toHaveBeenCalled();
      expect(onReply).not.toHaveBeenCalled();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      expect(parentShortcut).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("keydown", parentShortcut);
    }
  });

  it("shows actual origin and asks for an explicit send before forwarding an unchanged option", async () => {
    await render();
    expect(container.textContent).toContain(group.title);
    expect(container.textContent).toContain(question.questions[0]!.question);
    expect(container.querySelector("a")!.getAttribute("href")).toBe(
      `/${environmentId}/${encodeURIComponent(origin.threadId)}`,
    );
    expect(onReply).not.toHaveBeenCalled();
    await click("Nur lokal");
    expect(onReply).not.toHaveBeenCalled();
    await click("Send answer");
    expect(onReply).toHaveBeenCalledOnce();
    expect(onReply).toHaveBeenCalledWith({
      type: "question",
      origin,
      requestId,
      answers: { scope: "  local  " },
    });
  });

  it("keeps custom drafts through a manual fold and authoritative reconnect", async () => {
    await render();
    await type("Nur die harmlosen Testdaten.");
    await click(`Collapse: Question from ${group.title}`);
    await click(`Expand: Question from ${group.title}`);
    expect(container.querySelector("textarea")!.value).toBe("Nur die harmlosen Testdaten.");
    await render([{ ...group, status: "cached", requests: null }]);
    expect(container.textContent).toContain("Synchronizing");
    expect(container.querySelector("textarea")).toBeNull();
    expect(onReply).not.toHaveBeenCalled();
    await render();
    expect(container.querySelector("textarea")!.value).toBe("Nur die harmlosen Testdaten.");
  });

  it("makes a grant only after its real provider choice is clicked and keeps the child destination", async () => {
    await render([approval]);
    expect(onReply).not.toHaveBeenCalled();
    await click("Einmal erlauben");
    expect(onReply).toHaveBeenCalledWith({
      type: "approval",
      origin,
      requestId,
      decision: "accept",
    });
  });

  it("disables every response when permission is absent, including a permission change while open", async () => {
    await render([approval], true);
    await render([approval], false);
    expect(button("Einmal erlauben").disabled).toBe(true);
    await click("Einmal erlauben");
    expect(onReply).not.toHaveBeenCalled();
    await render([group], false);
    expect(button("Send answer").disabled).toBe(true);
    expect(container.querySelector("textarea")!.disabled).toBe(true);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("prevents rapid duplicate submissions while the original reply is in flight", async () => {
    let release!: (error: string | null) => void;
    onReply.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render();
    await click("Nur lokal");
    await act(async () => {
      button("Send answer").click();
      button("Send answer").click();
    });
    expect(onReply).toHaveBeenCalledOnce();
    await act(async () => release(null));
  });

  it("retains an actionable failed request, then removes it when another view resolves it", async () => {
    onReply.mockResolvedValue("Die Anfrage ist nicht mehr offen.");
    await render();
    await click("Nur lokal");
    await click("Send answer");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("nicht mehr offen");
    await render([]);
    expect(container.querySelector("section")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps requests with the same requestId distinct across original children", async () => {
    const other = {
      ...group,
      title: "Research",
      origin: { ...origin, threadId: ThreadId.make("child:research") },
    };
    await render([group, other]);
    expect(container.querySelectorAll("section[data-descendant-request]")).toHaveLength(2);
    await click(`Expand: Question from ${other.title}`);
    const section = [
      ...container.querySelectorAll<HTMLElement>("section[data-descendant-request]"),
    ].find((node) => node.textContent?.includes(other.title))!;
    await click("Nur lokal", section);
    await click("Send answer", section);
    expect(onReply).toHaveBeenCalledWith({
      type: "question",
      origin: other.origin,
      requestId,
      answers: { scope: "  local  " },
    });
  });

  it("does not resurrect old content while reconnecting or offer a response for an expired runtime", async () => {
    await render([{ ...group, status: "synchronizing", requests: null }]);
    expect(container.textContent).not.toContain(question.questions[0]!.question);
    expect(container.querySelector("textarea")).toBeNull();
    await render([
      {
        ...group,
        requests: {
          approvals: [],
          userInputs: [{ ...question, responseCapability: "not_resumable" }],
        },
      },
    ]);
    expect(button("Send answer").disabled).toBe(true);
    expect(container.textContent).toContain("Agent disconnected");
    expect(onReply).not.toHaveBeenCalled();
    await render([]);
    expect(container.textContent).toBe("");
  });

  it("keeps multi-question answers together and preserves custom initial text exactly", async () => {
    const questions = [
      { ...question.questions[0]!, allowCustomAnswer: false },
      {
        id: "reason",
        header: "Grund",
        question: "Warum?",
        options: [],
        multiSelect: false,
        initialAnswer: "  Vorgegebener Text\n\n",
      },
    ];
    await render([
      { ...group, requests: { approvals: [], userInputs: [{ ...question, questions }] } },
    ]);
    await click("Nur lokal");
    await click("Next");
    expect(container.querySelector("textarea")!.value).toBe("  Vorgegebener Text\n\n");
    await click("Send answer");
    expect(onReply).toHaveBeenCalledWith({
      type: "question",
      origin,
      requestId,
      answers: { scope: "  local  ", reason: "  Vorgegebener Text\n\n" },
    });
  });

  it("dismisses only the original asynchronous question without creating a new message", async () => {
    await render([
      {
        ...group,
        requests: {
          approvals: [],
          userInputs: [
            {
              ...question,
              dismissible: true,
              responseMode: "message",
              responseCapability: "message",
            },
          ],
        },
      },
    ]);
    await click("Dismiss");
    expect(onReply).toHaveBeenCalledWith({ type: "dismiss", origin, requestId });
  });
});
