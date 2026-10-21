import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, YaziPickerFile } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { readPreparedConnection } from "../../state/session";
import { useEnvironments } from "../../state/environments";
import { openYaziPicker, yaziPickerApi } from "../../rpc/yaziPicker";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { terminalThemeFromApp } from "../ThreadTerminalDrawer";
import { readYaziAttachment } from "./yaziAttachment";
import {
  BrowserAttachmentExplorer,
  browserAttachmentDirectory,
  type BrowserDirectoryHandle,
} from "./BrowserAttachmentExplorer";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle, DialogPopup } from "../ui/dialog";

function sameOrigin(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function YaziTerminal(props: {
  environmentId: EnvironmentId;
  onFiles: (files: File[]) => Promise<boolean>;
  onClose: () => void;
  onRetry: () => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const [home, setHome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Starting Yazi…");
  const [attaching, setAttaching] = useState(false);
  const retrySelection = useRef<(() => void) | null>(null);
  const allowed = useAtomValue(openYaziPicker.permissionAtom(props.environmentId));
  useEffect(() => {
    const element = mount.current;
    if (!element || !allowed) return;
    const api = yaziPickerApi(props.environmentId);
    let disposed = false;
    let sessionId: string | null = null;
    let surface: GhosttyTerminalSurface | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    let selectedFiles: ReadonlyArray<YaziPickerFile> | null = null;
    let nextFileIndex = 0;
    let attachmentInFlight = false;
    const fail = (cause: unknown) => {
      if (!disposed)
        setError(
          cause instanceof Error
            ? cause.message
            : "The file picker could not complete. Retry or choose files from this device.",
        );
    };
    const attachRemaining = async () => {
      if (disposed || attachmentInFlight || !sessionId || !selectedFiles) return;
      const files = selectedFiles;
      const activeSessionId = sessionId;
      attachmentInFlight = true;
      setAttaching(true);
      setError(null);
      await (async () => {
        while (nextFileIndex < files.length) {
          if (disposed) return;
          const selected = files[nextFileIndex]!;
          setStatus(`Attaching ${nextFileIndex + 1}/${files.length}: ${selected.name}`);
          const file = await readYaziAttachment(
            selected,
            (offset) => api.read(activeSessionId, selected.id, offset),
            () => disposed,
          );
          if (!file || disposed) return;
          const accepted = await latest.current.onFiles([file]);
          if (disposed) return;
          if (!accepted) {
            fail(
              new Error(
                `Could not attach ${selected.name}. The remaining files have not been attached.`,
              ),
            );
            return;
          }
          nextFileIndex += 1;
        }
        if (!disposed) latest.current.onClose();
      })()
        .catch(fail)
        .finally(() => {
          attachmentInFlight = false;
          if (!disposed) setAttaching(false);
        });
    };
    const retry = () => {
      void attachRemaining();
    };
    retrySelection.current = null;
    setError(null);
    setStatus("Starting Yazi…");
    void (async () => {
      const opened = await api.open();
      sessionId = opened.sessionId;
      if (disposed) {
        await api.close(sessionId);
        return;
      }
      setHome(opened.homePath);
      surface = await GhosttyTerminalSurface.create(element, {
        theme: terminalThemeFromApp(element),
        font: { size: 13 },
        onData: (data) => {
          if (!disposed && sessionId) void api.write(sessionId, data).catch(fail);
        },
        onResize: (cols, rows) => {
          if (!disposed && sessionId) void api.resize(sessionId, cols, rows).catch(fail);
        },
        onSelectionChange: () => {},
        beforeKey: (event) => !(event.key === "Tab" && event.shiftKey),
        onLinkActivate: () => {},
      });
      if (disposed) {
        surface.dispose();
        await api.close(sessionId);
        return;
      }
      surface.focus();
      setStatus("Space selects · Enter attaches · q cancels · Shift+Tab changes source");
      for (;;) {
        if (disposed) return;
        const update = await api.poll(sessionId);
        if (disposed) return;
        if (update.output) surface.write(update.output);
        if (update.state === "failed")
          throw new Error(update.error ?? "Yazi could not select these files.");
        if (update.state === "cancelled") {
          latest.current.onClose();
          return;
        }
        if (update.state === "completed") {
          selectedFiles = update.files;
          retrySelection.current = retry;
          await attachRemaining();
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 60);
        });
      }
    })().catch(fail);
    return () => {
      disposed = true;
      if (retrySelection.current === retry) retrySelection.current = null;
      clearTimeout(timer);
      wake?.();
      surface?.dispose();
      if (sessionId) void api.close(sessionId).catch(() => {});
    };
  }, [props.environmentId, allowed]);
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 text-xs text-muted-foreground">
        <span className="truncate">{home || "Home"}</span>
        {error ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={attaching}
            onClick={() => {
              if (retrySelection.current) retrySelection.current();
              else props.onRetry();
            }}
          >
            Retry
          </Button>
        ) : null}
      </div>
      <div
        ref={mount}
        role="group"
        aria-label="Yazi file picker"
        className="relative h-[min(60vh,38rem)] min-h-56 overflow-hidden border-y"
      />
      <div className="px-4 pb-4 text-xs text-muted-foreground" role={error ? "alert" : "status"}>
        {!allowed
          ? "This connection needs terminal and file access to select attachments."
          : (error ?? status)}
      </div>
    </>
  );
}

export function AttachmentPicker(props: {
  restoreFocus?: () => HTMLElement | false;
  environmentId: EnvironmentId;
  targetKey: string;
  onFiles: (files: File[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const { environments } = useEnvironments();
  const [source, setSource] = useState<"device" | "environment">("device");
  const input = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState<BrowserDirectoryHandle | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const localBootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
  const local = environments.find(({ environmentId }) => {
    const prepared = readPreparedConnection(environmentId);
    return localBootstraps.some((bootstrap) =>
      sameOrigin(bootstrap.httpBaseUrl, prepared?.httpBaseUrl),
    );
  });
  const target = source === "environment" ? props.environmentId : (local?.environmentId ?? null);
  const label = environments.find(({ environmentId }) => environmentId === target)?.label;
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (
          !open &&
          details.reason === "escape-key" &&
          document.activeElement?.closest(
            '[aria-label="Yazi file picker"],[aria-label="Granted local folder"]',
          )
        ) {
          details.cancel();
          return;
        }
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        aria-label="Attach files with Yazi"
        finalFocus={props.restoreFocus}
        size="wide"
        bottomStickOnMobile={false}
        onKeyDown={(event) => {
          // Yazi owns Escape, including its search and selection modes.
          if (
            event.key === "Escape" &&
            event.target instanceof Element &&
            event.target.closest('[aria-label="Yazi file picker"]')
          )
            event.stopPropagation();
        }}
      >
        <div className="flex w-full flex-col gap-3">
          <DialogHeader>
            <DialogTitle>Attach files</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2 px-4">
            <Button
              size="sm"
              variant={source === "device" ? "secondary" : "ghost"}
              aria-pressed={source === "device"}
              onClick={() => {
                setDirectory(null);
                setSource("device");
              }}
            >
              This device
            </Button>
            <Button
              size="sm"
              variant={source === "environment" ? "secondary" : "ghost"}
              aria-pressed={source === "environment"}
              onClick={() => {
                setDirectory(null);
                setSource("environment");
              }}
            >
              Thread environment
            </Button>
            {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
            <Button size="sm" variant="outline" onClick={() => input.current?.click()}>
              System file picker
            </Button>
            {!window.desktopBridge && source === "device" ? (
              <Button size="sm" variant="outline" onClick={() => directoryInput.current?.click()}>
                Choose folder
              </Button>
            ) : null}
          </div>
          <input
            ref={directoryInput}
            type="file"
            multiple
            {...{ webkitdirectory: "" }}
            aria-label="Choose local attachment folder"
            className="hidden"
            onChange={(event) => {
              const root = browserAttachmentDirectory(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
              if (root) setDirectory(root);
            }}
          />
          <input
            ref={input}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (!files.length) return;
              void props
                .onFiles(files)
                .then((accepted) => {
                  if (accepted) props.onClose();
                  else setError("The selected files could not be attached.");
                })
                .catch(() => setError("The selected files could not be attached."));
            }}
          />
          {directory && source === "device" ? (
            <BrowserAttachmentExplorer
              root={directory}
              onFiles={props.onFiles}
              onClose={props.onClose}
            />
          ) : target ? (
            <YaziTerminal
              key={`${props.targetKey}:${source}:${target}:${attempt}`}
              environmentId={target}
              onRetry={() => setAttempt((value) => value + 1)}
              onFiles={props.onFiles}
              onClose={props.onClose}
            />
          ) : (
            <div role="status" className="px-4 pb-6 text-sm text-muted-foreground">
              {window.desktopBridge
                ? "Enable this device’s local environment in Connections to use Yazi here."
                : "Choose a local folder to browse its files, or use the system file picker. Yazi is available in the thread environment."}
            </div>
          )}
          {error ? (
            <p role="alert" className="px-4 pb-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
