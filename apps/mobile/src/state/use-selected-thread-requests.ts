import * as Dialog from "../components/ui/Dialog";
import { useServerConfigs } from "./entities";
import {
  questionAttachmentDraftKey,
  questionAttachmentDraftPrefix,
  questionAttachmentPreparationAtom,
} from "./question-attachments";
import {
  clearComposerDraft,
  composerDraftsAtom,
  questionAttachmentDraftsAtom,
} from "./use-composer-drafts";
import {
  composerAttachmentUploadsAtom,
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
} from "./composer-attachment-uploads";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useRef, useState } from "react";

import {
  type EnvironmentId,
  type ThreadId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  canRespondToThreadApproval,
  type PendingThreadRequests,
  type ThreadUserInputQuestion,
  onThreadRequestsResolved,
  pruneResolvedUserInputDrafts,
  resolvedQuestionDraftKeys,
  seedUserInputDraftAnswers,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { appAtomRegistry } from "./atom-registry";
import { useSelectedThreadPendingRequests } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";
import { readEnvironmentScope } from "./session";

const EMPTY_PENDING_REQUESTS: PendingThreadRequests = { approvals: [], userInputs: [] };

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

// Writes start from the suggested answer the user was looking at.
function seededDraft(
  drafts: Record<string, PendingUserInputDraftAnswer> | undefined,
  question: ThreadUserInputQuestion,
): PendingUserInputDraftAnswer | undefined {
  return seedUserInputDraftAnswers([question], drafts ?? {})[question.id];
}

function setUserInputDraftOption(
  requestKey: string,
  question: ThreadUserInputQuestion,
  value: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        seededDraft(current[requestKey], question),
        value,
      ),
    },
  });
}

function setUserInputDraftCustomAnswer(
  requestKey: string,
  question: ThreadUserInputQuestion,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: setPendingUserInputCustomAnswer(
        question,
        seededDraft(current[requestKey], question),
        customAnswer,
      ),
    },
  });
}

/** Drops a thread's answer and attachment drafts for every request outside `pendingRequestIds`. */
function pruneResolvedRequestDrafts(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  pendingRequestIds: ReadonlyArray<RuntimeRequestId>,
): void {
  const drafts = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  const prunedDrafts = pruneResolvedUserInputDrafts(
    drafts,
    environmentId,
    threadId,
    pendingRequestIds,
  );
  if (prunedDrafts !== drafts) appAtomRegistry.set(userInputDraftsByRequestKeyAtom, prunedDrafts);

  const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
  const attachmentDrafts = appAtomRegistry.get(questionAttachmentDraftsAtom(prefix));
  const counts = { ...appAtomRegistry.get(questionAttachmentPreparationAtom) };
  let changed = false;
  for (const key of resolvedQuestionDraftKeys(
    new Set([...Object.keys(attachmentDrafts), ...Object.keys(counts)]),
    prefix,
    pendingRequestIds,
  )) {
    if (attachmentDrafts[key]) clearComposerDraft(key);
    if (key in counts) {
      delete counts[key];
      changed = true;
    }
  }
  if (changed) appAtomRegistry.set(questionAttachmentPreparationAtom, counts);
}

// Resolution can come from anywhere: another device, an interrupt, the turn
// ending, or a reload over drafts for requests that resolved meanwhile.
onThreadRequestsResolved(({ environmentId, threadId, pendingRequestIds }) =>
  pruneResolvedRequestDrafts(environmentId, threadId, pendingRequestIds),
);

/**
 * Drops `answeredRequestId`'s drafts as soon as the server accepts the
 * response, before the projection push that resolves it lands.
 */
function collectAnsweredRequestDrafts(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  answeredRequestId: RuntimeRequestId,
) {
  const current = appAtomRegistry.get(
    environmentThreadDetails.pendingRequestsAtom({ environmentId, threadId }),
  );
  // Missing detail is not resolution.
  if (current === null) return;
  pruneResolvedRequestDrafts(
    environmentId,
    threadId,
    [...current.approvals, ...current.userInputs]
      .map((request) => request.requestId)
      .filter((requestId) => requestId !== answeredRequestId),
  );
}

export function useSelectedThreadRequests() {
  const { selectedThreadDetailRef } = useThreadSelection();
  const pendingRequests = useSelectedThreadPendingRequests();
  return useThreadRequests(selectedThreadDetailRef, pendingRequests);
}

export function useThreadRequests(
  origin: ScopedThreadRef | null,
  pendingRequests: PendingThreadRequests | null,
  options?: { readonly requestId?: RuntimeRequestId; readonly requireLive?: boolean },
) {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const dismissUserInput = useAtomCommand(
    threadEnvironment.dismissUserInput,
    "thread user input dismissal",
  );
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const userInputResponsesInFlight = useRef(new Set<string>());
  const [respondingApprovalId, setRespondingApprovalId] = useState<RuntimeRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<RuntimeRequestId | null>(null);

  const activePendingApprovals = pendingRequests?.approvals ?? EMPTY_PENDING_REQUESTS.approvals;
  const activePendingApproval =
    (options?.requestId
      ? activePendingApprovals.find((entry) => entry.requestId === options.requestId)
      : activePendingApprovals[0]) ?? null;
  const activePendingUserInputs = pendingRequests?.userInputs ?? EMPTY_PENDING_REQUESTS.userInputs;
  const activePendingUserInput =
    (options?.requestId
      ? activePendingUserInputs.find((entry) => entry.requestId === options.requestId)
      : activePendingUserInputs[0]) ?? null;
  const currentRequests = useCallback(() => {
    if (!origin) return null;
    if (!options?.requireLive) return pendingRequests;
    if (appAtomRegistry.get(environmentThreadDetails.statusAtom(origin)) !== "live") return null;
    return appAtomRegistry.get(environmentThreadDetails.pendingRequestsAtom(origin));
  }, [origin, pendingRequests, options?.requireLive]);
  const questionServerConfigs = useServerConfigs();
  const attachmentDrafts = useAtomValue(
    questionAttachmentDraftsAtom(
      origin ? questionAttachmentDraftPrefix(origin.environmentId, origin.threadId) : "",
    ),
  );
  const preparationCounts = useAtomValue(questionAttachmentPreparationAtom);
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  // Suggested answers are shown until the user edits them; only edits are stored.
  const activePendingUserInputAnswerDrafts =
    activePendingUserInput && origin
      ? seedUserInputDraftAnswers(
          activePendingUserInput.questions,
          userInputDraftsByRequestKey[
            userInputDraftKey(
              origin.environmentId,
              origin.threadId,
              activePendingUserInput.requestId,
            )
          ] ?? {},
        )
      : {};
  const activePendingUserInputDrafts =
    activePendingUserInput && origin
      ? Object.fromEntries(
          activePendingUserInput.questions.map((question) => {
            const key = questionAttachmentDraftKey(
              origin.environmentId,
              origin.threadId,
              activePendingUserInput.requestId,
              question.id,
            );
            const attachments = attachmentDrafts[key]?.attachments ?? [];
            const uploadInput = {
              environmentId: origin.environmentId,
              attachments,
              serverConfig: questionServerConfigs.get(origin.environmentId) ?? null,
              states: uploadStates,
            };
            return [
              question.id,
              {
                ...activePendingUserInputAnswerDrafts[question.id],
                attachmentCount: attachments.length,
                attachmentsBlocked:
                  (attachments.length > 0 &&
                    questionServerConfigs.get(origin.environmentId) === undefined) ||
                  (preparationCounts[key] ?? 0) > 0 ||
                  composerAttachmentsStillUploading(uploadInput) ||
                  composerAttachmentUploadBlockReason({
                    ...uploadInput,
                    connected: true,
                  }) !== null,
              },
            ];
          }),
        )
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const onSelectUserInputOption = useCallback(
    (requestId: RuntimeRequestId, question: ThreadUserInputQuestion, value: string) => {
      if (!origin) {
        return;
      }

      const requestKey = userInputDraftKey(origin.environmentId, origin.threadId, requestId);
      setUserInputDraftOption(requestKey, question, value);
    },
    [origin],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: RuntimeRequestId, questionId: string, customAnswer: string) => {
      const question = activePendingUserInputs
        .find((request) => request.requestId === requestId)
        ?.questions.find((entry) => entry.id === questionId);
      if (!origin || !question) {
        return;
      }

      const requestKey = userInputDraftKey(origin.environmentId, origin.threadId, requestId);
      setUserInputDraftCustomAnswer(requestKey, question, customAnswer);
    },
    [activePendingUserInputs, origin],
  );

  const onRespondToApproval = useCallback(
    async (
      requestId: RuntimeRequestId,
      decision: ProviderApprovalDecision,
      packageHash?: string,
      feedback?: string,
    ) => {
      if (!origin || !readEnvironmentScope(origin.environmentId, AuthOrchestrationOperateScope)) {
        return;
      }
      if (
        !canRespondToThreadApproval(
          currentRequests()?.approvals.find((approval) => approval.requestId === requestId),
          decision,
          packageHash,
        )
      ) {
        return;
      }

      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: origin.environmentId,
        input: {
          threadId: origin.threadId,
          requestId,
          decision,
          ...(packageHash === undefined ? {} : { packageHash }),
          ...(feedback === undefined ? {} : { feedback }),
        },
      });
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [currentRequests, respondToApproval, origin],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (
      !origin ||
      !activePendingUserInput ||
      !currentRequests()?.userInputs.some(
        (entry) => entry.requestId === activePendingUserInput.requestId,
      ) ||
      activePendingUserInput.responseCapability === "not_resumable" ||
      !activePendingUserInputAnswers ||
      !readEnvironmentScope(origin.environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }

    const responseKey = questionAttachmentDraftKey(
      origin.environmentId,
      origin.threadId,
      activePendingUserInput.requestId,
      "",
    );
    if (userInputResponsesInFlight.current.has(responseKey)) return;
    const attachmentsByQuestionId = new Map<
      string,
      import("@t3tools/contracts").UserInputAttachments[string]
    >();
    for (const question of activePendingUserInput.questions) {
      const key = questionAttachmentDraftKey(
        origin.environmentId,
        origin.threadId,
        activePendingUserInput.requestId,
        question.id,
      );
      if ((appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0) return;
      const attachments = appAtomRegistry.get(composerDraftsAtom)[key]?.attachments ?? [];
      if (attachments.length === 0) continue;
      if (
        attachments.some(
          (attachment) =>
            !attachment.uploadedAttachmentId ||
            attachment.uploadEnvironmentId !== origin.environmentId,
        )
      ) {
        Dialog.alert(
          "Attachments are not ready",
          "Wait for uploads to finish, or retry failed uploads.",
        );
        return;
      }
      attachmentsByQuestionId.set(
        question.id,
        attachments.map((attachment) => ({
          type: attachment.type,
          id: attachment.uploadedAttachmentId!,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      );
    }
    userInputResponsesInFlight.current.add(responseKey);
    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await respondToUserInput({
      environmentId: origin.environmentId,
      input: {
        threadId: origin.threadId,
        requestId: activePendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
        ...(attachmentsByQuestionId.size > 0
          ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
          : {}),
      },
    });
    userInputResponsesInFlight.current.delete(responseKey);
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    if (result._tag === "Success") {
      collectAnsweredRequestDrafts(
        origin.environmentId,
        origin.threadId,
        activePendingUserInput.requestId,
      );
    }
    return result;
  }, [
    activePendingUserInput,
    activePendingUserInputAnswers,
    currentRequests,
    respondToUserInput,
    origin,
  ]);

  const onDismissUserInput = useCallback(async () => {
    if (
      !origin ||
      !activePendingUserInput ||
      !activePendingUserInput.dismissible ||
      !currentRequests()?.userInputs.some(
        (entry) => entry.requestId === activePendingUserInput.requestId && entry.dismissible,
      ) ||
      !readEnvironmentScope(origin.environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }

    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await dismissUserInput({
      environmentId: origin.environmentId,
      input: {
        threadId: origin.threadId,
        requestId: activePendingUserInput.requestId,
      },
    });
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    if (result._tag === "Success") {
      collectAnsweredRequestDrafts(
        origin.environmentId,
        origin.threadId,
        activePendingUserInput.requestId,
      );
    }
    return result;
  }, [activePendingUserInput, currentRequests, dismissUserInput, origin]);

  return {
    activePendingApproval,
    activePendingApprovals,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingApprovalId,
    respondingUserInputId,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
    onDismissUserInput,
  };
}
