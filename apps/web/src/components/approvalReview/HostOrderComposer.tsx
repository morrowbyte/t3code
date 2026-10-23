import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  approvalOrderDestinationChannels,
  approvalOrderSourceIsReady,
} from "@t3tools/client-runtime/state/approval-orders";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ApprovalReviewHostOrder,
  ApprovalReviewOrderCreate,
  ApprovalReviewOrderCancelResult,
  ApprovalReviewOrderReadiness,
  EnvironmentId as HostEnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import * as BrowserDpop from "../../cloud/dpop";

import { approvalOrderEnvironment } from "../../state/approvalOrders";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  EMPTY_HOST_ORDER_SESSION,
  useHostOrderComposerStore,
  type HostOrderSession,
  type SentOrder,
} from "./HostOrderComposerStore";

interface HostOrderComposerProps {
  environmentId: HostEnvironmentId;
  destination: ScopedThreadRef;
  hostLabel?: string;
  active?: boolean;
  connected?: boolean;
  onCreated?: (order: ApprovalReviewHostOrder) => void;
}

const readinessReasons = {
  ready: "Ready",
  "feature-disabled": "Protected tasks are disabled by the host operator.",
  "human-authority-unconfigured": "Human send is not configured on this host.",
  "human-authority-required": "A qualified human session is required.",
  "channel-unconfigured": "No authorized VM destination is configured.",
  "forward-unavailable": "The paired VM channel is unavailable.",
};

const orderStates = {
  forwarding: "Forwarding",
  active: "Active",
  "forward-unknown": "Forwarding outcome unknown",
  cancelled: "Cancelled",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The host request failed.";
}

export function HostOrderComposer(props: HostOrderComposerProps) {
  return (
    <HostOrderComposerSession
      key={JSON.stringify([
        props.environmentId,
        props.destination.environmentId,
        props.destination.threadId,
      ])}
      {...props}
    />
  );
}

function HostOrderComposerSession({
  environmentId,
  destination,
  hostLabel = "Protecting host",
  active = true,
  connected = true,
  onCreated,
}: HostOrderComposerProps) {
  const create = useAtomCommand(approvalOrderEnvironment.create, { reportFailure: false });
  const read = useAtomCommand(approvalOrderEnvironment.read, { reportFailure: false });
  const cancel = useAtomCommand(approvalOrderEnvironment.cancel, { reportFailure: false });
  const checkReadiness = useAtomCommand(approvalOrderEnvironment.readiness, {
    reportFailure: false,
  });
  const canCreate = useAtomValue(approvalOrderEnvironment.create.permissionAtom(environmentId));
  const canRead = useAtomValue(approvalOrderEnvironment.read.permissionAtom(environmentId));
  const canCancel = useAtomValue(approvalOrderEnvironment.cancel.permissionAtom(environmentId));
  const canCheck = useAtomValue(approvalOrderEnvironment.readiness.permissionAtom(environmentId));
  const [readiness, setReadiness] = useState<ApprovalReviewOrderReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const sessionKey = JSON.stringify([
    environmentId,
    destination.environmentId,
    destination.threadId,
  ]);
  const session = useHostOrderComposerStore(
    (state) => state.sessions[sessionKey] ?? EMPTY_HOST_ORDER_SESSION,
  );
  const { text, selectedVmId, sent, pending, draft } = session;
  const updateSession = (update: (session: HostOrderSession) => HostOrderSession) =>
    useHostOrderComposerStore.getState().update(sessionKey, update);
  const setText = (text: string) => updateSession((current) => ({ ...current, text }));
  const setSelectedVmId = (selectedVmId: string) =>
    updateSession((current) => ({ ...current, selectedVmId }));
  const setDraft = (draft: ApprovalReviewOrderCreate | null) =>
    updateSession((current) => ({ ...current, draft }));
  const setPending = (pending: boolean) => updateSession((current) => ({ ...current, pending }));
  const isPending = () =>
    useHostOrderComposerStore.getState().sessions[sessionKey]?.pending === true;
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const textareaId = useId();
  const reasonId = useId();
  const channels = approvalOrderDestinationChannels(readiness, destination);
  const channel = channels.find(
    (entry) => entry.vmId === (channels.length === 1 ? channels[0]?.vmId : selectedVmId),
  );
  const sourceReady = approvalOrderSourceIsReady(readiness);
  const pendingDraft =
    draft !== null && sent.some((entry) => entry.input.clientRequestId === draft?.clientRequestId);
  const canSend =
    active &&
    connected &&
    canCreate &&
    canCheck &&
    sourceReady &&
    channel?.ready === true &&
    typeof channel.hostThreadId === "string" &&
    channel.hostThreadId.length > 0 &&
    text.trim().length > 0 &&
    !pending &&
    !pendingDraft;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // One wake-up at the next expiry keeps idle forms from polling the host.
  useEffect(() => {
    const next = sent.reduce((earliest, entry) => {
      const expiry = entry.order?.source.expiresAt ?? entry.input.expiresAt;
      return expiry > now ? Math.min(earliest, expiry) : earliest;
    }, Infinity);
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [sent, now]);

  async function refreshReadiness() {
    if (!mounted.current || !active || !connected || !canCheck || isPending()) return;
    setPending(true);
    setReadiness(null);
    setReadinessError(null);
    try {
      const result = await checkReadiness({ environmentId, input: {} });
      if (!mounted.current) return;
      if (result._tag === "Success") setReadiness(result.value);
      else setReadinessError(errorMessage(squashAtomCommandFailure(result)));
    } catch (error) {
      if (mounted.current) setReadinessError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  const initialReadiness = useEffectEvent(refreshReadiness);
  useEffect(() => {
    if (
      active &&
      connected &&
      canCheck &&
      !pending &&
      readiness === null &&
      readinessError === null
    )
      queueMicrotask(() => void initialReadiness());
  }, [active, connected, canCheck, pending, readiness, readinessError]);

  function updateSent(
    input: ApprovalReviewOrderCreate,
    order: ApprovalReviewHostOrder | null,
    error: string | null,
    alreadyClaimedActions?: ApprovalReviewOrderCancelResult["alreadyClaimedActions"],
  ) {
    updateSession((session) => ({
      ...session,
      sent: [
        ...session.sent.filter((entry) => entry.input.clientRequestId !== input.clientRequestId),
        {
          input,
          order,
          error,
          alreadyClaimedActions:
            alreadyClaimedActions ??
            session.sent.find((entry) => entry.input.clientRequestId === input.clientRequestId)
              ?.alreadyClaimedActions ??
            [],
        },
      ],
    }));
    if (mounted.current) setNow(Date.now());
  }

  async function send(input: ApprovalReviewOrderCreate) {
    if (
      !active ||
      !connected ||
      isPending() ||
      !canCreate ||
      !canCheck ||
      !sourceReady ||
      !channels.some(
        (entry) =>
          entry.vmId === input.vmId &&
          entry.hostThreadId === input.sourceThreadId &&
          entry.hostThreadId.length > 0 &&
          entry.ready,
      )
    )
      return;
    setPending(true);
    // Persist the exact request before dispatch, so navigation cannot turn a lost response into a new send.
    updateSent(input, null, null);
    let created: ApprovalReviewHostOrder | null = null;
    try {
      const result = await create({ environmentId, input });
      if (result._tag === "Failure") {
        updateSent(input, null, errorMessage(squashAtomCommandFailure(result)));
        return;
      }
      updateSent(input, result.value, null);
      updateSession((current) =>
        current.draft?.clientRequestId === input.clientRequestId
          ? { ...current, draft: null, text: "" }
          : current,
      );
      created = result.value;
    } catch (error) {
      updateSent(input, null, errorMessage(error));
    } finally {
      setPending(false);
    }
    if (mounted.current && created !== null) onCreated?.(created);
  }

  async function updateOrder(entry: SentOrder, action: "read" | "cancel") {
    if (
      !active ||
      !connected ||
      isPending() ||
      entry.order === null ||
      !(action === "read" ? canRead : canCancel)
    )
      return;
    setPending(true);
    if (action === "cancel")
      updateSent(entry.input, entry.order, "Cancellation requested · outcome not yet confirmed");
    try {
      const command = { environmentId, input: { orderId: entry.order.source.orderId } };
      let alreadyClaimedActions:
        | ApprovalReviewOrderCancelResult["alreadyClaimedActions"]
        | undefined;
      const result =
        action === "read"
          ? await read(command)
          : await cancel(command).then((result) => {
              if (result._tag === "Success")
                alreadyClaimedActions = result.value.alreadyClaimedActions;
              return result;
            });
      if (result._tag === "Success")
        updateSent(entry.input, result.value, null, alreadyClaimedActions);
      else
        updateSent(
          entry.input,
          entry.order,
          `${action === "cancel" ? "Cancellation outcome unknown" : "Status unavailable"}: ${errorMessage(squashAtomCommandFailure(result))}`,
        );
    } catch (error) {
      updateSent(
        entry.input,
        entry.order,
        `${action === "cancel" ? "Cancellation outcome unknown" : "Status unavailable"}: ${errorMessage(error)}`,
      );
    } finally {
      setPending(false);
    }
  }

  const disabledReason = !connected
    ? "Protecting host is offline."
    : !canCheck || !canCreate
      ? "This connection does not have the required order permissions."
      : (readinessError ??
        (readiness === null
          ? pending
            ? "Checking host authorization…"
            : "Host authorization has not been confirmed."
          : !readiness.enabled || readiness.reason !== "ready"
            ? readiness.reason === "ready"
              ? "Human send is unavailable on this host."
              : readinessReasons[readiness.reason]
            : !sourceReady
              ? "The host has not confirmed a qualified human or synthetic test session."
              : channels.length === 0
                ? "This host has no authorized channel for the selected VM thread."
                : channel === undefined
                  ? "Choose an authorized VM channel."
                  : typeof channel.hostThreadId !== "string" || channel.hostThreadId.length === 0
                    ? "The host has not bound a control thread to this VM channel."
                    : !channel.ready
                      ? "The paired VM channel is unavailable."
                      : null));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <form
        className="flex min-w-0 flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSend || channel === undefined) return;
          const input = draft ?? {
            clientRequestId: Effect.runSync(
              Crypto.Crypto.pipe(
                Effect.flatMap((crypto) => crypto.randomUUIDv4()),
                Effect.provide(BrowserDpop.layer),
                Effect.orDie,
              ),
            ),
            sourceThreadId: channel.hostThreadId,
            vmId: channel.vmId,
            text,
            expiresAt: Date.now() + 15 * 60_000,
          };
          setDraft(input);
          void send(input);
        }}
      >
        <p className="break-words text-sm">Host: {hostLabel}</p>
        <details className="text-sm text-muted-foreground">
          <summary>Connection details</summary>
          <dl className="break-all">
            <dt>Host environment</dt>
            <dd>{environmentId}</dd>
            <dt>Execution environment</dt>
            <dd>{destination.environmentId}</dd>
            <dt>Execution thread</dt>
            <dd>{destination.threadId}</dd>
          </dl>
        </details>
        {readiness?.sourceKind === "synthetic" && (
          <p className="text-sm text-muted-foreground">
            Synthetic test · cannot approve or claim actions
          </p>
        )}
        {channels.length > 1 ? (
          <Select
            value={selectedVmId}
            disabled={!active || pending || !sourceReady}
            onValueChange={(value) => {
              setSelectedVmId(value ?? "");
              setDraft(null);
            }}
          >
            <SelectTrigger aria-label="VM channel">
              <SelectValue placeholder="Choose VM channel" />
            </SelectTrigger>
            <SelectPopup>
              {channels.map((entry) => (
                <SelectItem key={entry.vmId} value={entry.vmId} disabled={!entry.ready}>
                  {entry.label}
                  {!entry.ready ? " · unavailable" : ""}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : channel !== undefined ? (
          <p className="text-sm">VM: {channel.label}</p>
        ) : null}
        <label htmlFor={textareaId}>Task</label>
        <Textarea
          id={textareaId}
          aria-describedby={reasonId}
          value={text}
          maxLength={65_536}
          disabled={!active || pending}
          placeholder="Write the original task"
          onChange={(event) => {
            setText(event.target.value);
            setDraft(null);
          }}
        />
        <p id={reasonId} role="status" className="text-sm text-muted-foreground">
          {disabledReason ?? "Order validity: 15 minutes"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!canSend}>
            {pending
              ? "Working…"
              : readiness?.sourceKind === "synthetic"
                ? "Send synthetic task"
                : "Send task"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!active || !connected || pending || !canCheck}
            onClick={() => void refreshReadiness()}
          >
            Check readiness
          </Button>
        </div>
      </form>
      {sent.map((entry) => (
        <section
          key={entry.input.clientRequestId}
          aria-label={`Order ${entry.order?.source.orderId ?? entry.input.clientRequestId}`}
          className="flex min-w-0 flex-col gap-2 border-t pt-3 text-sm"
        >
          {entry.order === null ? (
            <>
              <p role="status">
                {pending && draft?.clientRequestId === entry.input.clientRequestId
                  ? "Sending task…"
                  : entry.input.expiresAt <= now
                    ? "Expired · send outcome unknown"
                    : "Send outcome unknown"}
              </p>
              <details>
                <summary>Request details</summary>
                <p className="break-all">{entry.input.clientRequestId}</p>
              </details>
              <p className="text-muted-foreground">{entry.error}</p>
              {readiness !== null &&
                !channels.some(
                  (channel) =>
                    channel.vmId === entry.input.vmId &&
                    channel.hostThreadId === entry.input.sourceThreadId &&
                    channel.ready,
                ) && (
                  <p>Original host channel binding is unavailable; this send cannot be retried.</p>
                )}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !active ||
                    !connected ||
                    pending ||
                    !canCreate ||
                    !canCheck ||
                    !sourceReady ||
                    entry.input.expiresAt <= now ||
                    !channels.some(
                      (destination) =>
                        destination.vmId === entry.input.vmId &&
                        destination.hostThreadId === entry.input.sourceThreadId &&
                        destination.hostThreadId.length > 0 &&
                        destination.ready,
                    )
                  }
                  onClick={() => void send(entry.input)}
                >
                  Retry same send
                </Button>
              </div>
            </>
          ) : (
            <>
              <p role="status">
                {entry.order.source.testOnly || entry.order.source.sourceKind === "synthetic"
                  ? "Synthetic test · "
                  : ""}
                {entry.order.source.expiresAt <= now ? "Expired · last host state: " : ""}
                {orderStates[entry.order.state]}
              </p>
              {entry.order.state === "cancelled" ? (
                <p role="status">
                  New proposals and claims are blocked. Previously claimed actions may still
                  complete.
                </p>
              ) : null}
              {entry.alreadyClaimedActions.length > 0 ? (
                <details>
                  <summary>
                    Already claimed · cannot be recalled ({entry.alreadyClaimedActions.length})
                  </summary>
                  {entry.alreadyClaimedActions.map((claimed) => (
                    <dl key={claimed.requestId} className="break-words text-sm">
                      <dt>Action / target</dt>
                      <dd>
                        {claimed.action.kind} · {claimed.action.verifiedTargetId}
                      </dd>
                      <dt>Path</dt>
                      <dd>{claimed.action.path}</dd>
                      <dt>Package / claim</dt>
                      <dd>
                        {claimed.packageHash} · {claimed.claimId}
                      </dd>
                      <dt>Last recorded state</dt>
                      <dd>{claimed.state}</dd>
                    </dl>
                  ))}
                </details>
              ) : null}
              <p className="text-muted-foreground">
                Expires {new Date(entry.order.source.expiresAt).toLocaleString()}
              </p>
              {entry.order.assignment === null ? <p>No VM receive acknowledgement.</p> : null}
              <details>
                <summary>Delivery details</summary>
                <p className="break-words text-muted-foreground">
                  Order {entry.order.source.orderId} · {entry.order.vmId} · expires{" "}
                  {new Date(entry.order.source.expiresAt).toLocaleString()}
                </p>
                {entry.order.assignment !== null ? (
                  <p className="break-words">
                    VM thread: {entry.order.assignment.threadId}
                    <br />
                    VM run: {entry.order.assignment.runId}
                  </p>
                ) : null}
              </details>
              {entry.error !== null && <p role="alert">{entry.error}</p>}
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/$environmentId/$threadId"
                  params={{
                    environmentId: entry.order.source.sourceEnvironmentId,
                    threadId: entry.order.source.threadId,
                  }}
                  className="inline-flex min-h-11 items-center underline underline-offset-4"
                >
                  Open host review thread
                </Link>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!active || !connected || pending || !canRead}
                  onClick={() => void updateOrder(entry, "read")}
                >
                  Read current order
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !active ||
                    !connected ||
                    pending ||
                    !canCancel ||
                    entry.order.state === "cancelled"
                  }
                  onClick={() => void updateOrder(entry, "cancel")}
                >
                  Cancel order
                </Button>
              </div>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
