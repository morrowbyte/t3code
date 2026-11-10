import { useAtomValue } from "@effect/atom-react";
import type { AppRestoreCandidate, AppRestoreState } from "@t3tools/contracts";
import { useState } from "react";

import { appRestoreDialogAtom, closeAppRestore, openAppRestore } from "./appRestoreState";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const sizeLabel = (bytes: number) =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1_048_576)} MiB`;

function RestoreVersions({ state }: { state: AppRestoreState }) {
  const [selected, setSelected] = useState<AppRestoreCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const restore = async () => {
    const api = window.desktopBridge?.appRestore;
    if (!selected || !api || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.restore({
        version: selected.version,
        expectedCurrentVersion: state.currentVersion,
        expectedHash: selected.sha256,
      });
      setFailed(result.status === "failed");
      setMessage(
        result.reason ??
          (result.status === "restored"
            ? `Crew ${result.version} is running. Automatic updates are on hold.`
            : "Restore started. Crew will restart; the controller checks the version and returns to the previous version if startup fails."),
      );
    } catch {
      setFailed(true);
      setMessage("Restore could not start. Refresh the version list before trying again.");
    } finally {
      setBusy(false);
    }
  };

  const resumeUpdates = async () => {
    const api = window.desktopBridge?.appRestore;
    if (!api || busy) return;
    setBusy(true);
    try {
      await api.resumeUpdates();
      await openAppRestore();
    } catch {
      setFailed(true);
      setMessage("Automatic updates could not be resumed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogPanel>
        <div className="space-y-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Current version</dt>
            <dd className="break-all font-mono">{state.currentVersion || "Unknown"}</dd>
            <dt className="text-muted-foreground">Retained</dt>
            <dd>
              {sizeLabel(state.totalBytes)} / {sizeLabel(state.maxBytes)} · up to{" "}
              {state.maxVersions} versions
            </dd>
            <dt className="text-muted-foreground">Automatic updates</dt>
            <dd>{state.updateHold ? "On hold" : "Enabled"}</dd>
          </dl>
          {state.unavailableReason ? (
            <p role="status" className="text-sm">
              {state.unavailableReason}
            </p>
          ) : null}
          {selected ? (
            <div className="space-y-3">
              <h3 className="font-medium">Restore {selected.version}?</h3>
              <p className="text-sm">
                Crew will restart from {state.currentVersion} to {selected.version}. Chats, login
                and profile stay in place. Automatic updates will be held until you resume them.
              </p>
              <details className="text-sm">
                <summary className="cursor-pointer">Verified artifact</summary>
                <dl className="mt-2 space-y-1 break-all font-mono text-xs">
                  <dt>SHA-256</dt>
                  <dd>{selected.sha256}</dd>
                  <dt>Source</dt>
                  <dd>{selected.sourceSha ?? "Unknown"}</dd>
                  <dt>Installation</dt>
                  <dd>{state.installationId}</dd>
                </dl>
              </details>
            </div>
          ) : state.candidates.length > 0 ? (
            <ul aria-label="Retained Crew versions" className="divide-y">
              {state.candidates.map((candidate) => (
                <li
                  key={candidate.version}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0 text-sm">
                    <p className="break-all font-mono">{candidate.version}</p>
                    <p className="text-muted-foreground">{sizeLabel(candidate.sizeBytes)}</p>
                    {candidate.blockedReason ? <p>{candidate.blockedReason}</p> : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      busy || candidate.blockedReason !== null || state.unavailableReason !== null
                    }
                    onClick={() => {
                      setSelected(candidate);
                      setMessage(null);
                    }}
                  >
                    Restore {candidate.version}
                  </Button>
                </li>
              ))}
            </ul>
          ) : !state.unavailableReason ? (
            <p role="status" className="text-sm">
              No verified previous version is retained yet. A successful update preserves a
              compatible previous version.
            </p>
          ) : null}
          {message ? (
            <p role={failed ? "alert" : "status"} className="text-sm">
              {message}
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button
          variant="outline"
          disabled={busy}
          onClick={
            selected
              ? () => {
                  setSelected(null);
                  setMessage(null);
                }
              : closeAppRestore
          }
        >
          {selected ? "Back" : "Close"}
        </Button>
        {selected ? (
          <Button
            disabled={busy || (!failed && message !== null)}
            onClick={() => {
              void restore();
            }}
          >
            {busy ? "Starting restore…" : "Restore and restart"}
          </Button>
        ) : state.updateHold ? (
          <Button
            disabled={busy}
            onClick={() => {
              void resumeUpdates();
            }}
          >
            Resume automatic updates
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void openAppRestore();
            }}
          >
            Refresh
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

export function AppRestoreDialog() {
  const value = useAtomValue(appRestoreDialogAtom);
  return (
    <Dialog
      open={value.open}
      onOpenChange={(open) => {
        if (!open) closeAppRestore();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Restore Crew</DialogTitle>
          <DialogDescription>This desktop installation</DialogDescription>
        </DialogHeader>
        {value.state ? (
          <RestoreVersions key={value.request} state={value.state} />
        ) : (
          <>
            <DialogPanel>
              <p role={value.error ? "alert" : "status"} className="text-sm">
                {value.error ??
                  (window.desktopBridge?.appRestore
                    ? "Reading retained versions…"
                    : "Open the installed Crew desktop app, or run t3 restore on its machine. For a separate server, use t3 restore --component server.")}
              </p>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={closeAppRestore}>
                Close
              </Button>
              {value.error ? (
                <Button
                  onClick={() => {
                    void openAppRestore();
                  }}
                >
                  Retry
                </Button>
              ) : null}
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
