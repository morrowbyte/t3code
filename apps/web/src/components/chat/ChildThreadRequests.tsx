import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
  type UserInputAttachments,
} from "@t3tools/contracts";
import {
  createDescendantThreadRequestsAtom,
  type DescendantThreadRequests,
} from "@t3tools/client-runtime/state/descendant-thread-requests";
import {
  seedUserInputDraftAnswers,
  type ThreadPendingApproval,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChevronDownIcon,
  MessageCircleQuestionIcon,
  PaperclipIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { videoMimeType } from "@t3tools/shared/video";
import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  changeQuestionAttachmentPreparation,
  clearQuestionAttachmentDraft,
  countQuestionAttachments,
  questionAttachmentDraftId,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import {
  getUploadedAttachments,
  releaseDraftAttachment,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  attachmentUploadBlockReason,
  formatAttachmentUploadProgress,
} from "../../lib/attachmentUploadState";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { useEnvironment } from "../../state/environments";
import { randomUUID } from "../../lib/utils";
import { useProject, useThreadShell } from "../../state/entities";
import ChatMarkdown from "../ChatMarkdown";
import {
  classifyComposerAttachmentFile,
  fileAttachmentStagingLimit,
  normalizeComposerImageFileMimeType,
} from "./composerAttachmentFiles";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  derivePendingUserInputProgress,
  projectPendingUserInputAnswer,
} from "../../pendingUserInput";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Textarea } from "../ui/textarea";
import { ApprovalActionSummary } from "./ApprovalActionSummary";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

const requestsAtom = createDescendantThreadRequestsAtom({
  threadsAtom: environmentThreadShells.environmentThreadsAtom,
  pendingRequestsAtom: environmentThreadDetails.pendingRequestsAtom,
  statusAtom: environmentThreadDetails.statusAtom,
});

type Reply = {
  readonly origin: ScopedThreadRef;
  readonly requestId: RuntimeRequestId;
} & (
  | {
      readonly type: "approval";
      readonly decision: ProviderApprovalDecision;
      readonly packageHash?: string;
    }
  | {
      readonly type: "question";
      readonly answers: Record<string, unknown>;
      readonly attachmentsByQuestionId?: UserInputAttachments;
    }
  | { readonly type: "dismiss" }
);

type ReplyHandler = (reply: Reply) => Promise<string | null>;

interface QuestionDraft {
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly index: number;
}

type AttachmentCapabilities = Parameters<typeof fileAttachmentStagingLimit>[0] & {
  readonly supportsQuestionAttachments: boolean;
};
const NO_ATTACHMENTS: AttachmentCapabilities = {
  attachmentUploadsCapabilityKnown: false,
  supportsAttachmentUploads: false,
  supportsQuestionAttachments: false,
  maxFileAttachmentBytes: null,
};

/** All actions keep the destination of the original request, never the visible parent. */
export function ChildThreadRequests({ parent }: { readonly parent: ScopedThreadRef }) {
  const groups = useAtomValue(requestsAtom(parent));
  const config = useEnvironment(parent.environmentId)?.serverConfig ?? null;
  const attachmentCapabilities: AttachmentCapabilities = {
    attachmentUploadsCapabilityKnown: config !== null,
    supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
    supportsQuestionAttachments: config?.environment.capabilities.questionAttachments === true,
    maxFileAttachmentBytes:
      config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
  };
  const canOperate = useEnvironmentScope(parent.environmentId, AuthOrchestrationOperateScope);
  const approve = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const answer = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismiss = useOrchestrationCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });

  const respond: ReplyHandler = async (reply) => {
    const { origin, requestId } = reply;
    if (!readEnvironmentScope(origin.environmentId, AuthOrchestrationOperateScope))
      return "This connection cannot send responses.";
    if (appAtomRegistry.get(environmentThreadDetails.statusAtom(origin)) !== "live")
      return "The request is synchronizing.";
    const pending = appAtomRegistry.get(environmentThreadDetails.pendingRequestsAtom(origin));
    const request =
      reply.type === "approval"
        ? pending?.approvals.find((entry) => entry.requestId === requestId)
        : pending?.userInputs.find((entry) => entry.requestId === requestId);
    if (!request) return "The request is no longer pending.";
    if (reply.type === "dismiss" && !("dismissible" in request && request.dismissible))
      return "This request cannot be dismissed.";
    if (reply.type !== "dismiss" && request.responseCapability === "not_resumable")
      return "The original agent can no longer resume this request.";

    const target = {
      environmentId: origin.environmentId,
      input: { threadId: origin.threadId, requestId },
    };
    const result =
      reply.type === "approval"
        ? await approve({
            ...target,
            input: {
              ...target.input,
              decision: reply.decision,
              ...(reply.packageHash ? { packageHash: reply.packageHash } : {}),
            },
          })
        : reply.type === "question"
          ? await answer({
              ...target,
              input: {
                ...target.input,
                answers: reply.answers,
                ...(reply.attachmentsByQuestionId
                  ? { attachmentsByQuestionId: reply.attachmentsByQuestionId }
                  : {}),
              },
            })
          : await dismiss(target);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
    const error = squashAtomCommandFailure(result);
    return error instanceof Error ? error.message : "Failed to submit the response.";
  };

  return (
    <ChildThreadRequestsView
      key={JSON.stringify(parent)}
      groups={groups}
      canOperate={canOperate}
      attachmentCapabilities={attachmentCapabilities}
      onReply={respond}
    />
  );
}

type PendingEntry = { readonly group: DescendantThreadRequests; readonly key: string } & (
  | { readonly type: "approval"; readonly request: ThreadPendingApproval }
  | { readonly type: "question"; readonly request: ThreadPendingUserInput }
);

export function ChildThreadRequestsView({
  groups,
  canOperate,
  onReply,
  attachmentCapabilities = NO_ATTACHMENTS,
}: {
  readonly groups: ReadonlyArray<DescendantThreadRequests>;
  readonly canOperate: boolean;
  readonly onReply: ReplyHandler;
  readonly attachmentCapabilities?: AttachmentCapabilities;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const previousQuestions = useRef(
    new Map<string, { origin: ScopedThreadRef; request: ThreadPendingUserInput }>(),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Clears attachment drafts from the external upload store when canonical requests resolve.
  useEffect(() => {
    const waiting = new Map<string, { origin: ScopedThreadRef; request: ThreadPendingUserInput }>();
    for (const group of groups) {
      for (const request of group.requests?.userInputs ?? []) {
        waiting.set(JSON.stringify([group.origin, request.requestId]), {
          origin: group.origin,
          request,
        });
      }
    }
    for (const [key, previous] of previousQuestions.current) {
      if (waiting.has(key)) continue;
      if (
        groups.some(
          (group) =>
            group.origin.environmentId === previous.origin.environmentId &&
            group.origin.threadId === previous.origin.threadId &&
            group.requests === null,
        )
      ) {
        waiting.set(key, previous);
        continue;
      }
      for (const question of previous.request.questions) {
        clearQuestionAttachmentDraft(
          questionAttachmentDraftId(
            previous.origin.environmentId,
            previous.origin.threadId,
            previous.request.requestId,
            question.id,
          ),
        );
      }
    }
    previousQuestions.current = waiting;
  }, [groups]);
  const entries = groups.flatMap((group): PendingEntry[] => {
    const prefix = JSON.stringify([group.origin.environmentId, group.origin.threadId]);
    return [
      ...(group.requests?.approvals ?? []).map((request) => ({
        type: "approval" as const,
        group,
        request,
        key: `${prefix}:${request.requestId}`,
      })),
      ...(group.requests?.userInputs ?? []).map((request) => ({
        type: "question" as const,
        group,
        request,
        key: `${prefix}:${request.requestId}`,
      })),
    ];
  });
  const active = entries.some((entry) => entry.key === selected)
    ? selected
    : selected === ""
      ? ""
      : entries[0]?.key;
  if (groups.length === 0) return null;

  return (
    <div
      className="mb-2 max-h-[45vh] min-w-0 overflow-y-auto"
      aria-label="Requests from child threads"
      onKeyDownCapture={(event) => {
        // The parent composer's number shortcuts must not answer a different request.
        if (/^[1-9]$/.test(event.key)) event.stopPropagation();
      }}
    >
      <ComposerBanner.Root
        variant={entries.some((entry) => entry.type === "approval") ? "warning" : "info"}
      >
        {groups
          .filter((group) => group.requests === null)
          .map((group) => (
            <ComposerBanner.Row key={JSON.stringify(group.origin)}>
              <ComposerBanner.Icon>
                <MessageCircleQuestionIcon />
              </ComposerBanner.Icon>
              <ComposerBanner.Content>
                <span className="truncate">{group.title}</span>
                <span className="shrink-0 text-muted-foreground">Synchronizing…</span>
              </ComposerBanner.Content>
            </ComposerBanner.Row>
          ))}
        {entries.map((entry) => (
          <ChildRequestCard
            key={entry.key}
            entry={entry}
            open={active === entry.key}
            canOperate={canOperate && entry.group.status === "live"}
            onToggle={() => setSelected(active === entry.key ? "" : entry.key)}
            onReply={onReply}
            attachmentCapabilities={attachmentCapabilities}
            draft={
              drafts[entry.key] ?? {
                answers:
                  entry.type === "question"
                    ? seedUserInputDraftAnswers(entry.request.questions, {})
                    : {},
                index: 0,
              }
            }
            onDraftChange={(update) =>
              setDrafts((previous) => ({
                ...previous,
                [entry.key]: update(
                  previous[entry.key] ?? {
                    answers:
                      entry.type === "question"
                        ? seedUserInputDraftAnswers(entry.request.questions, {})
                        : {},
                    index: 0,
                  },
                ),
              }))
            }
          />
        ))}
      </ComposerBanner.Root>
    </div>
  );
}

function ChildRequestCard({
  entry,
  open,
  canOperate,
  onToggle,
  onReply,
  draft,
  onDraftChange,
  attachmentCapabilities,
}: {
  readonly entry: PendingEntry;
  readonly open: boolean;
  readonly canOperate: boolean;
  readonly onToggle: () => void;
  readonly onReply: ReplyHandler;
  readonly draft: QuestionDraft;
  readonly onDraftChange: (update: (draft: QuestionDraft) => QuestionDraft) => void;
  readonly attachmentCapabilities: AttachmentCapabilities;
}) {
  const panelId = useId();
  const inFlight = useRef(false);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { group, request } = entry;
  const submit = async (reply: Reply) => {
    if (inFlight.current || !canOperate) return;
    inFlight.current = true;
    setResponding(true);
    setError(null);
    const result = await onReply(reply).catch(() => "Failed to submit the response.");
    inFlight.current = false;
    setResponding(false);
    setError(result);
  };
  const label = entry.type === "approval" ? "Approval" : "Question";
  const brief =
    entry.type === "question" ? entry.request.questions[0]?.question : entry.request.detail;

  return (
    <Collapsible
      open={open}
      onOpenChange={onToggle}
      render={
        <section
          className="border-b border-border/50 py-1 last:border-b-0"
          data-descendant-request={entry.key}
        />
      }
    >
      <ComposerBanner.Row>
        <ComposerBanner.Icon>
          {entry.type === "approval" ? <ShieldQuestionIcon /> : <MessageCircleQuestionIcon />}
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: group.origin.environmentId, threadId: group.origin.threadId }}
            className="min-w-0 truncate rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`Open original thread: ${group.title}`}
          >
            {group.title}
          </Link>
          <span className="shrink-0 text-muted-foreground">{label}</span>
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <CollapsibleTrigger
            render={<Button size="icon-xs" variant="ghost" />}
            aria-label={`${open ? "Collapse" : "Expand"}: ${label} from ${group.title}`}
            aria-expanded={open}
            aria-controls={panelId}
          >
            <ChevronDownIcon className={open ? "rotate-180" : undefined} />
          </CollapsibleTrigger>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <CollapsiblePanel id={panelId} keepMounted>
        <div className="px-3 pb-2 pt-1">
          {entry.type === "approval" ? (
            <div className="space-y-3">
              {entry.request.detail ? (
                <pre className="max-h-28 overflow-auto whitespace-pre-wrap text-xs wrap-anywhere">
                  {entry.request.detail}
                </pre>
              ) : (
                <p className="text-sm">{entry.request.appName ?? "Approval requested"}</p>
              )}
              <details>
                <summary className="w-fit cursor-pointer rounded-sm text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  Details
                </summary>
                <div className="mt-2">
                  <ApprovalActionSummary
                    approval={entry.request}
                    environmentId={group.origin.environmentId}
                    runtimeMode={group.runtimeMode}
                  />
                </div>
              </details>
              <div className="flex flex-wrap gap-2">
                <ComposerPendingApprovalActions
                  approval={entry.request}
                  environmentId={group.origin.environmentId}
                  threadId={group.origin.threadId}
                  requestId={request.requestId}
                  canRespond={
                    canOperate &&
                    (entry.request.responseCapability === "live" ||
                      entry.request.responseCapability === "external")
                  }
                  isResponding={responding}
                  options={entry.request.options}
                  onRespondToApproval={(requestId, decision, packageHash) =>
                    submit({
                      type: "approval",
                      origin: group.origin,
                      requestId,
                      decision,
                      ...(packageHash ? { packageHash } : {}),
                    })
                  }
                />
              </div>
            </div>
          ) : (
            <ChildQuestionForm
              group={group}
              attachmentCapabilities={attachmentCapabilities}
              request={entry.request}
              draft={draft}
              onChange={onDraftChange}
              disabled={
                !canOperate || responding || entry.request.responseCapability === "not_resumable"
              }
              onSubmit={(answers, attachmentsByQuestionId) =>
                submit({
                  type: "question",
                  origin: group.origin,
                  requestId: request.requestId,
                  answers,
                  ...(attachmentsByQuestionId ? { attachmentsByQuestionId } : {}),
                })
              }
              onDismiss={() =>
                submit({ type: "dismiss", origin: group.origin, requestId: request.requestId })
              }
            />
          )}
          {!canOperate ? (
            <p className="mt-2 text-xs text-muted-foreground">Read only</p>
          ) : request.responseCapability === "not_resumable" ? (
            <p className="mt-2 text-xs text-muted-foreground">Agent disconnected</p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </CollapsiblePanel>
      {!open && brief ? (
        <p className="mx-3 mb-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {brief}
        </p>
      ) : null}
    </Collapsible>
  );
}

function ChildQuestionForm({
  group,
  attachmentCapabilities,
  request,
  draft,
  onChange,
  disabled,
  onSubmit,
  onDismiss,
}: {
  readonly group: DescendantThreadRequests;
  readonly attachmentCapabilities: AttachmentCapabilities;
  readonly request: ThreadPendingUserInput;
  readonly draft: QuestionDraft;
  readonly onChange: (update: (draft: QuestionDraft) => QuestionDraft) => void;
  readonly disabled: boolean;
  readonly onSubmit: (
    answers: Record<string, unknown>,
    attachments?: UserInputAttachments,
  ) => Promise<void>;
  readonly onDismiss: () => Promise<void>;
}) {
  const { index } = draft;
  const { origin } = group;
  const shell = useThreadShell(origin);
  const project = useProject(
    shell ? { environmentId: origin.environmentId, projectId: shell.projectId } : null,
  );
  const keys = request.questions.map((question) =>
    questionAttachmentDraftId(
      origin.environmentId,
      origin.threadId,
      request.requestId,
      question.id,
    ),
  );
  const composerDrafts = useComposerDraftStore(
    useShallow((state) =>
      Object.fromEntries(keys.map((key) => [key, state.draftsByThreadKey[key]])),
    ),
  );
  const uploads = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        keys.flatMap((key) =>
          [...(composerDrafts[key]?.images ?? []), ...(composerDrafts[key]?.files ?? [])].flatMap(
            (file) => {
              const upload = state.uploadsByImageId[file.id];
              return upload ? [[file.id, upload] as const] : [];
            },
          ),
        ),
      ),
    ),
  );
  const preparations = useQuestionAttachmentPreparation(
    useShallow((state) => Object.fromEntries(keys.map((key) => [key, state.counts[key] ?? 0]))),
  );
  const supportsAttachments =
    attachmentCapabilities.attachmentUploadsCapabilityKnown &&
    attachmentCapabilities.supportsAttachmentUploads &&
    attachmentCapabilities.supportsQuestionAttachments;
  const fileLimit = fileAttachmentStagingLimit(attachmentCapabilities);
  const answers = Object.fromEntries(
    request.questions.map((question, questionIndex) => {
      const target = keys[questionIndex]!;
      const files = [
        ...(composerDrafts[target]?.images ?? []),
        ...(composerDrafts[target]?.files ?? []),
      ];
      return [
        question.id,
        {
          ...draft.answers[question.id],
          attachmentCount: files.length,
          attachmentsBlocked:
            (preparations[target] ?? 0) > 0 ||
            files.some(
              (file) =>
                !supportsAttachments ||
                (file.type === "file" && (fileLimit === null || file.sizeBytes > fileLimit)) ||
                uploads[file.id]?.status !== "ready" ||
                uploads[file.id]?.environmentId !== origin.environmentId,
            ),
        },
      ];
    }),
  );
  const inputId = useId();
  const progress = derivePendingUserInputProgress(request.questions, answers, index);
  const question = progress.activeQuestion;
  if (!question) return null;
  const advance = () => {
    if (disabled || !progress.canAdvance) return;
    if (!progress.isLastQuestion)
      onChange((previous) => ({ ...previous, index: progress.questionIndex + 1 }));
    else {
      const resolved = buildPendingUserInputAnswers(request.questions, answers);
      if (!resolved) return;
      const attachments = new Map<string, UserInputAttachments[string]>();
      for (const question of request.questions) {
        const key = questionAttachmentDraftId(
          origin.environmentId,
          origin.threadId,
          request.requestId,
          question.id,
        );
        if ((useQuestionAttachmentPreparation.getState().counts[key] ?? 0) > 0) return;
        const stored = useComposerDraftStore.getState().getComposerDraft(key);
        resolved[question.id] = projectPendingUserInputAnswer(
          resolved[question.id],
          stored?.threadContexts ?? [],
        ) as string | string[];
        const files = stored ? [...stored.images, ...stored.files] : [];
        if (files.length === 0) continue;
        const uploaded = getUploadedAttachments({
          environmentId: origin.environmentId,
          images: files,
        });
        if (!uploaded || !supportsAttachments) return;
        attachments.set(question.id, uploaded as UserInputAttachments[string]);
      }
      void onSubmit(resolved, attachments.size ? Object.fromEntries(attachments) : undefined);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 text-sm leading-relaxed" id={`${inputId}-question`}>
          <ChatMarkdown
            text={question.question}
            cwd={group.worktreePath ?? project?.workspaceRoot}
            threadRef={origin}
            environmentId={origin.environmentId}
          />
        </div>
        {request.questions.length > 1 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {progress.questionIndex + 1}/{request.questions.length}
          </span>
        ) : null}
      </div>
      {question.options.length > 0 ? (
        <div
          className="flex flex-col items-stretch gap-1.5"
          role="group"
          aria-labelledby={`${inputId}-question`}
        >
          {question.options.map((option) => {
            const value = option.value ?? option.label;
            const selected =
              !progress.usingCustomAnswer && progress.selectedOptionValues.includes(value);
            return (
              <div key={value}>
                <Button
                  size="sm"
                  variant={selected ? "secondary" : "outline"}
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() =>
                    onChange((previous) => ({
                      ...previous,
                      answers: {
                        ...previous.answers,
                        [question.id]: togglePendingUserInputOptionSelection(
                          question,
                          previous.answers[question.id],
                          value,
                        ),
                      },
                    }))
                  }
                >
                  <span className="whitespace-normal text-left wrap-anywhere">{option.label}</span>
                </Button>
                {option.description && option.description !== option.label ? (
                  <p className="mt-1 text-xs text-muted-foreground">{option.description}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {question.allowCustomAnswer !== false ? (
        <QuestionAttachmentPicker
          key={keys[progress.questionIndex]}
          origin={origin}
          draftTarget={keys[progress.questionIndex]!}
          allDraftKeys={keys}
          attachments={[
            ...(composerDrafts[keys[progress.questionIndex]!]?.images ?? []),
            ...(composerDrafts[keys[progress.questionIndex]!]?.files ?? []),
          ]}
          uploads={uploads}
          disabled={disabled}
          supportsAttachments={supportsAttachments}
          fileLimit={fileLimit}
        />
      ) : null}
      {question.allowCustomAnswer !== false ? (
        <div className="space-y-1">
          <label htmlFor={inputId} className="text-xs text-muted-foreground">
            {question.options.length > 0 ? "Custom answer" : "Answer"}
          </label>
          <Textarea
            id={inputId}
            size="sm"
            aria-describedby={`${inputId}-question`}
            disabled={disabled}
            value={progress.customAnswer}
            onChange={(event) => {
              const value = event.target.value;
              onChange((previous) => ({
                ...previous,
                answers: {
                  ...previous.answers,
                  [question.id]: setPendingUserInputCustomAnswer(
                    question,
                    previous.answers[question.id],
                    value,
                  ),
                },
              }));
            }}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {progress.questionIndex > 0 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange((previous) => ({ ...previous, index: progress.questionIndex - 1 }))
            }
          >
            Back
          </Button>
        ) : null}
        <Button size="xs" disabled={disabled || !progress.canAdvance} onClick={advance}>
          {progress.isLastQuestion ? "Send answer" : "Next"}
        </Button>
        {request.dismissible ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              void onDismiss();
            }}
          >
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}

async function prepareQuestionAttachment(
  file: File,
  fileLimit: number | null,
): Promise<ComposerFileAttachment | ComposerImageAttachment> {
  const kind = classifyComposerAttachmentFile(file);
  if (kind === "unsupported-image")
    throw new Error(`'${file.name}' is not a supported image type.`);
  let attachment: ComposerFileAttachment | ComposerImageAttachment;
  if (kind === "image") {
    const prepared = await prepareImageForAttachment(
      normalizeComposerImageFileMimeType(file),
      PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    );
    if (!prepared.ok) throw new Error(`'${file.name}' could not be prepared as an image.`);
    attachment = {
      type: "image",
      id: randomUUID(),
      name: prepared.file.name || "image",
      mimeType: prepared.file.type,
      sizeBytes: prepared.file.size,
      previewUrl: URL.createObjectURL(prepared.file),
      file: prepared.file,
    };
  } else {
    if (fileLimit === null) throw new Error("This server does not support file attachments.");
    if (file.size <= 0) throw new Error(`'${file.name}' is empty or could not be read.`);
    if (file.size > fileLimit) throw new Error(fileAttachmentTooLargeMessage(file.name, fileLimit));
    const mimeType =
      videoMimeType({ name: file.name, mimeType: file.type }) ??
      (file.type || "application/octet-stream");
    const normalized =
      file.type === mimeType
        ? file
        : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
    attachment = {
      type: "file",
      id: randomUUID(),
      name: normalized.name || "file",
      mimeType,
      sizeBytes: normalized.size,
      file: normalized,
    };
  }
  return attachment;
}

function QuestionAttachmentPicker({
  origin,
  draftTarget,
  allDraftKeys,
  attachments,
  uploads,
  disabled,
  supportsAttachments,
  fileLimit,
}: {
  readonly origin: ScopedThreadRef;
  readonly draftTarget: ReturnType<typeof questionAttachmentDraftId>;
  readonly allDraftKeys: ReadonlyArray<ReturnType<typeof questionAttachmentDraftId>>;
  readonly attachments: ReadonlyArray<ComposerFileAttachment | ComposerImageAttachment>;
  readonly uploads: ReturnType<typeof useAttachmentUploadStore.getState>["uploadsByImageId"];
  readonly disabled: boolean;
  readonly supportsAttachments: boolean;
  readonly fileLimit: number | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Prevents asynchronous file preprocessing from updating an unmounted attachment control.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Starts and resumes external attachment uploads for the mounted request's environment.
  useEffect(() => {
    if (disabled || !supportsAttachments) return;
    for (const image of attachments) {
      if (image.type === "file" && (fileLimit === null || image.sizeBytes > fileLimit)) continue;
      startAttachmentUpload({ environmentId: origin.environmentId, image, draftTarget });
    }
  }, [attachments, disabled, supportsAttachments, fileLimit, origin.environmentId, draftTarget]);
  const add = async (files: File[]) => {
    if (
      disabled ||
      !supportsAttachments ||
      !readEnvironmentScope(origin.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setError(null);
    for (const file of files) {
      if (countQuestionAttachments(allDraftKeys) >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        setError(
          `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per question response.`,
        );
        break;
      }
      changeQuestionAttachmentPreparation(draftTarget, 1);
      try {
        const attachment = await prepareQuestionAttachment(file, fileLimit);
        if (
          !mounted.current ||
          !readEnvironmentScope(origin.environmentId, AuthOrchestrationOperateScope)
        ) {
          if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
          changeQuestionAttachmentPreparation(draftTarget, -1);
          return;
        }
        const store = useComposerDraftStore.getState();
        if (attachment.type === "image") store.addImages(draftTarget, [attachment]);
        else store.addFiles(draftTarget, [attachment]);
      } catch (cause) {
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : "Could not attach the file.");
      }
      changeQuestionAttachmentPreparation(draftTarget, -1);
    }
  };
  const uploadError = attachmentUploadBlockReason({
    imageIds: attachments.map((file) => file.id),
    uploadsByImageId: uploads,
    environmentId: origin.environmentId,
  });
  return (
    <div className="space-y-2">
      {supportsAttachments ? (
        <>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            aria-label="Question attachments"
            disabled={disabled}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void add(files);
            }}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            <PaperclipIcon />
            Attach files
          </Button>
        </>
      ) : null}
      {attachments.map((file) => {
        const upload =
          uploads[file.id]?.environmentId === origin.environmentId ? uploads[file.id] : undefined;
        return (
          <div key={file.id} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 wrap-anywhere">{file.name}</span>
            <span className="text-muted-foreground">
              {upload?.status === "ready"
                ? "Uploaded"
                : upload?.status === "uploading"
                  ? formatAttachmentUploadProgress(upload.progress)
                  : upload?.status === "failed"
                    ? upload.reason
                    : "Waiting for upload"}
            </span>
            {upload?.status === "failed" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled || !supportsAttachments}
                onClick={() =>
                  retryAttachmentUpload({
                    environmentId: origin.environmentId,
                    image: file,
                    draftTarget,
                  })
                }
              >
                Retry
              </Button>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={disabled}
              aria-label={`Remove ${file.name}`}
              onClick={() => {
                releaseDraftAttachment(file);
                const store = useComposerDraftStore.getState();
                if (file.type === "image") {
                  store.removeImage(draftTarget, file.id);
                  if (file.previewUrl.startsWith("blob:")) URL.revokeObjectURL(file.previewUrl);
                } else store.removeFile(draftTarget, file.id);
              }}
            >
              ×
            </Button>
          </div>
        );
      })}
      {error || uploadError ? (
        <p role="status" className="text-xs text-muted-foreground">
          {error ?? uploadError}
        </p>
      ) : null}
    </div>
  );
}
