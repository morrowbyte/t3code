import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  addCoordinationMember,
  coordinationActionBlock,
  isCoordinationThread,
  removeCoordinationMember,
  resolveCoordinationMember,
} from "@t3tools/client-runtime/state/thread-coordination";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { newMessageId } from "../../lib/utils";
import { useThreadShell, useThreadShells } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentShellStatus } from "../../state/shell";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { isThreadCoordinationAvailable } from "./availability";

const MembersSchema = Schema.Array(Schema.String);
const EMPTY_MEMBERS: readonly string[] = [];

export function ThreadCoordination({ threadRef }: { threadRef: ScopedThreadRef }) {
  return isThreadCoordinationAvailable() ? <LocalThreadCoordination threadRef={threadRef} /> : null;
}

function LocalThreadCoordination({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = threadRef;
  const coordinator = useThreadShell(threadRef);
  const threads = useThreadShells();
  const environmentLive = useEnvironmentShellStatus(environmentId) === "live";
  const [members, setMembers] = useLocalStorage(
    `t3code:thread-coordination:v1:${JSON.stringify([environmentId, threadId])}`,
    EMPTY_MEMBERS,
    MembersSchema,
  );
  const [selectedId, setSelectedId] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState("");
  const inFlight = useRef(false);
  const navigate = useNavigate();
  const allowed = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId),
  );
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const target =
    coordinator === null
      ? null
      : resolveCoordinationMember({
          coordinator,
          members,
          selectedId,
          threads,
        });
  const detail = useEnvironmentThread(target?.environmentId ?? null, target?.id ?? null);
  const projection = Option.getOrNull(detail.data);
  const queueHeld =
    projection?.runs.some((run) => run.status === "queued" && run.queueHeld === true) ?? false;
  const activeRun = projection?.runs.findLast(
    (run) =>
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting",
  );

  if (coordinator === null || !isCoordinationThread(coordinator, environmentId)) return null;
  const candidates = threads.filter(
    (thread) =>
      isCoordinationThread(thread, environmentId) &&
      thread.id !== threadId &&
      !members.includes(thread.id),
  );
  const block = coordinationActionBlock({
    coordinator,
    target,
    allowed,
    detailLive:
      environmentLive &&
      detail.status === "live" &&
      Option.isNone(detail.error) &&
      projection?.thread.id === target?.id,
    queueHeld,
  });

  const act = async (action: "message" | "steer" | "cancel") => {
    if (inFlight.current || block !== null || target === null) return;
    if (action !== "cancel" && text.trim().length === 0) return;
    if (action !== "message" && activeRun === undefined) return;
    inFlight.current = true;
    setPending(true);
    setReceipt("");
    try {
      const result =
        action === "cancel"
          ? await interruptTurn({
              environmentId,
              input: { threadId: target.id, runId: activeRun!.id },
            })
          : await startTurn({
              environmentId,
              input: {
                threadId: target.id,
                message: {
                  messageId: newMessageId(),
                  role: "user",
                  text: text.trim(),
                  attachments: [],
                },
                runtimeMode: target.runtimeMode,
                interactionMode: target.interactionMode,
                dispatchMode: action === "steer" ? "steer" : "queue",
              },
            });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setReceipt(error instanceof Error ? error.message : "The request failed.");
      } else {
        if (action !== "cancel") setText("");
        setReceipt(`Request accepted for ${target.title}. Completion is not confirmed.`);
      }
    } catch (error) {
      setReceipt(
        error instanceof Error
          ? error.message
          : "The request failed. Check the original thread before retrying.",
      );
    }
    inFlight.current = false;
    setPending(false);
  };

  return (
    <details className="shrink-0 border-b text-sm">
      <summary className="min-h-13 cursor-pointer py-4 pr-28 pl-12 text-xs sm:pl-3">
        Thread group · {members.length} members · local
      </summary>
      <section
        aria-label="Thread coordination"
        className="max-h-[45vh] space-y-3 overflow-y-auto px-3 pb-3"
      >
        <p className="text-xs text-muted-foreground">
          Local to this browser. Existing threads retain their context and permissions.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="min-w-0 flex-1">
            Add existing thread
            <select
              aria-label="Add existing thread"
              className="mt-1 block w-full rounded border bg-background p-2"
              value={candidateId}
              disabled={pending}
              onChange={(event) => setCandidateId(event.target.value)}
            >
              <option value="">Choose a thread</option>
              {candidates.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title} · {thread.id}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !environmentLive || !candidateId}
            onClick={() => {
              const candidate = candidates.find((thread) => thread.id === candidateId);
              if (!candidate) return;
              setMembers((current) => addCoordinationMember(current, coordinator, candidate));
              setCandidateId("");
            }}
          >
            Add member
          </Button>
        </div>
        <ul className="space-y-2">
          {members.map((id) => {
            const member = resolveCoordinationMember({
              coordinator,
              members,
              selectedId: id,
              threads,
            });
            return (
              <li key={id} className="flex items-center gap-2">
                <label className="min-w-0 flex-1 break-words">
                  <input
                    type="radio"
                    name={`coordination-${threadId}`}
                    checked={selectedId === id}
                    disabled={pending || member === null}
                    onChange={() => {
                      setSelectedId(id);
                      setText("");
                      setReceipt("");
                    }}
                  />{" "}
                  {member?.title ?? "Unavailable thread"}{" "}
                  <span className="text-xs text-muted-foreground">{id}</span>
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setMembers((current) => removeCoordinationMember(current, id));
                    if (selectedId === id) {
                      setSelectedId("");
                      setText("");
                      setReceipt("");
                    }
                  }}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
        {members.length > 0 && (
          <>
            <p className="break-words">Target: {target?.title ?? "Select one member"}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={target === null || pending}
                onClick={() => {
                  if (target)
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: target.id },
                    });
                }}
              >
                Open original
              </Button>
            </div>
            <Textarea
              aria-label="Message to selected member"
              placeholder="Message only this member"
              value={text}
              disabled={pending || block !== null}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={pending || block !== null || !text.trim()}
                onClick={() => void act("message")}
              >
                Send message
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || block !== null || !text.trim() || !activeRun}
                onClick={() => void act("steer")}
              >
                Steer active turn
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={pending || block !== null || !activeRun}
                onClick={() => void act("cancel")}
              >
                Cancel active turn
              </Button>
            </div>
            {block && <p className="text-xs text-muted-foreground">{block}</p>}
            <p aria-live="polite" className="break-words text-xs">
              {receipt}
            </p>
          </>
        )}
      </section>
    </details>
  );
}
