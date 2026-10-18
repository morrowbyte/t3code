import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
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
import { ChevronDownIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
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
  | { readonly type: "approval"; readonly decision: ProviderApprovalDecision }
  | { readonly type: "question"; readonly answers: Record<string, unknown> }
  | { readonly type: "dismiss" }
);

type ReplyHandler = (reply: Reply) => Promise<string | null>;

interface QuestionDraft {
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly index: number;
}

/** All actions keep the destination of the original request, never the visible parent. */
export function ChildThreadRequests({ parent }: { readonly parent: ScopedThreadRef }) {
  const groups = useAtomValue(requestsAtom(parent));
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
      return "Diese Verbindung darf keine Antworten senden.";
    if (appAtomRegistry.get(environmentThreadDetails.statusAtom(origin)) !== "live")
      return "Die Anfrage wird noch synchronisiert.";
    const pending = appAtomRegistry.get(environmentThreadDetails.pendingRequestsAtom(origin));
    const request =
      reply.type === "approval"
        ? pending?.approvals.find((entry) => entry.requestId === requestId)
        : pending?.userInputs.find((entry) => entry.requestId === requestId);
    if (!request) return "Die Anfrage ist nicht mehr offen.";
    if (reply.type === "dismiss" && !("dismissible" in request && request.dismissible))
      return "Diese Anfrage kann nicht verworfen werden.";
    if (reply.type !== "dismiss" && request.responseCapability === "not_resumable")
      return "Der ursprüngliche Agent kann diese Anfrage nicht mehr fortsetzen.";

    const target = {
      environmentId: origin.environmentId,
      input: { threadId: origin.threadId, requestId },
    };
    const result =
      reply.type === "approval"
        ? await approve({ ...target, input: { ...target.input, decision: reply.decision } })
        : reply.type === "question"
          ? await answer({ ...target, input: { ...target.input, answers: reply.answers } })
          : await dismiss(target);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
    const error = squashAtomCommandFailure(result);
    return error instanceof Error ? error.message : "Die Antwort konnte nicht gesendet werden.";
  };

  return (
    <ChildThreadRequestsView
      key={JSON.stringify(parent)}
      groups={groups}
      canOperate={canOperate}
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
}: {
  readonly groups: ReadonlyArray<DescendantThreadRequests>;
  readonly canOperate: boolean;
  readonly onReply: ReplyHandler;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
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
      aria-label="Anfragen aus Unterthreads"
      onKeyDownCapture={(event) => {
        // The parent composer's number shortcuts must not answer a different request.
        if (/^[1-9]$/.test(event.key)) event.stopPropagation();
      }}
    >
      <ComposerBanner.Root
        placement="floating"
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
                <span className="shrink-0 text-muted-foreground">Synchronisieren…</span>
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
}: {
  readonly entry: PendingEntry;
  readonly open: boolean;
  readonly canOperate: boolean;
  readonly onToggle: () => void;
  readonly onReply: ReplyHandler;
  readonly draft: QuestionDraft;
  readonly onDraftChange: (update: (draft: QuestionDraft) => QuestionDraft) => void;
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
    const result = await onReply(reply).catch(() => "Die Antwort konnte nicht gesendet werden.");
    inFlight.current = false;
    setResponding(false);
    setError(result);
  };
  const label = entry.type === "approval" ? "Freigabe" : "Frage";
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
            aria-label={`Ursprungsthread öffnen: ${group.title}`}
          >
            {group.title}
          </Link>
          <span className="shrink-0 text-muted-foreground">{label}</span>
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <CollapsibleTrigger
            render={<Button size="icon-xs" variant="ghost" />}
            aria-label={`${open ? "Zuklappen" : "Öffnen"}: ${label} von ${group.title}`}
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
                <p className="text-sm">{entry.request.appName ?? "Freigabe angefragt"}</p>
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
                  requestId={request.requestId}
                  canRespond={canOperate && entry.request.responseCapability === "live"}
                  isResponding={responding}
                  options={entry.request.options}
                  onRespondToApproval={(requestId, decision) =>
                    submit({ type: "approval", origin: group.origin, requestId, decision })
                  }
                />
              </div>
            </div>
          ) : (
            <ChildQuestionForm
              request={entry.request}
              draft={draft}
              onChange={onDraftChange}
              disabled={
                !canOperate || responding || entry.request.responseCapability === "not_resumable"
              }
              onSubmit={(answers) =>
                submit({
                  type: "question",
                  origin: group.origin,
                  requestId: request.requestId,
                  answers,
                })
              }
              onDismiss={() =>
                submit({ type: "dismiss", origin: group.origin, requestId: request.requestId })
              }
            />
          )}
          {!canOperate ? (
            <p className="mt-2 text-xs text-muted-foreground">Nur ansehen</p>
          ) : request.responseCapability === "not_resumable" ? (
            <p className="mt-2 text-xs text-muted-foreground">Agent nicht mehr verbunden</p>
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
  request,
  draft,
  onChange,
  disabled,
  onSubmit,
  onDismiss,
}: {
  readonly request: ThreadPendingUserInput;
  readonly draft: QuestionDraft;
  readonly onChange: (update: (draft: QuestionDraft) => QuestionDraft) => void;
  readonly disabled: boolean;
  readonly onSubmit: (answers: Record<string, unknown>) => Promise<void>;
  readonly onDismiss: () => Promise<void>;
}) {
  const { answers, index } = draft;
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
      if (resolved) void onSubmit(resolved);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-sm leading-relaxed" id={`${inputId}-question`}>
          {question.question}
        </p>
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
        <div className="space-y-1">
          <label htmlFor={inputId} className="text-xs text-muted-foreground">
            {question.options.length > 0 ? "Eigene Antwort" : "Antwort"}
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
                    previous.answers[question.id],
                    value,
                    question,
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
            Zurück
          </Button>
        ) : null}
        <Button size="xs" disabled={disabled || !progress.canAdvance} onClick={advance}>
          {progress.isLastQuestion ? "Antwort senden" : "Weiter"}
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
            Verwerfen
          </Button>
        ) : null}
      </div>
    </div>
  );
}
