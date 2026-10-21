import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/button";

export interface BrowserFileHandle {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
}
export interface BrowserDirectoryHandle {
  kind: "directory";
  name: string;
  values: () => AsyncIterable<BrowserDirectoryHandle | BrowserFileHandle>;
}

async function readBrowserDirectory(directory: BrowserDirectoryHandle) {
  const entries = [];
  for await (const entry of directory.values()) entries.push(entry);
  return entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : a.kind === "directory"
        ? -1
        : 1,
  );
}
export function browserAttachmentDirectory(files: File[]): BrowserDirectoryHandle | null {
  if (!files.length) return null;
  type Directory = BrowserDirectoryHandle & {
    children: Map<string, Directory | BrowserFileHandle>;
  };
  const makeDirectory = (name: string): Directory => {
    const children = new Map<string, Directory | BrowserFileHandle>();
    return {
      name,
      kind: "directory",
      children,
      async *values() {
        yield* children.values();
      },
    };
  };
  const root = makeDirectory(files[0]!.webkitRelativePath.split("/")[0] || "Selected folder");
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split("/");
    if (parts.length > 1) parts.shift();
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      const existing = parent.children.get(part);
      if (existing?.kind === "directory") parent = existing;
      else {
        const created = makeDirectory(part);
        parent.children.set(part, created);
        parent = created;
      }
    }
    parent.children.set(file.name, { kind: "file", name: file.name, getFile: async () => file });
  }
  return root;
}

export function BrowserAttachmentExplorer({
  root,
  onFiles,
  onClose,
}: {
  root: BrowserDirectoryHandle;
  onFiles: (files: File[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const [folders, setFolders] = useState([root]);
  const directory = folders.at(-1)!;
  const [entries, setEntries] = useState<Array<BrowserDirectoryHandle | BrowserFileHandle>>([]);
  const [selected, setSelected] = useState(new Map<string, BrowserFileHandle>());
  const [filter, setFilter] = useState("");
  const [hidden, setHidden] = useState(false);
  const [active, setActive] = useState(0);
  const activeIndex = useRef(0);
  const selection = useRef(selected);
  const submitting = useRef(false);
  useLayoutEffect(() => {
    selection.current = selected;
  }, [selected]);
  const moveTo = (index: number) => {
    activeIndex.current = Math.max(0, index);
    setActive(activeIndex.current);
  };
  const selectFiles = (files: Map<string, BrowserFileHandle>) => {
    selection.current = files;
    setSelected(files);
  };
  const [preview, setPreview] = useState<{ name: string; text: string; url?: string } | null>(null);
  const previewUrl = preview?.url;
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const attachGeneration = useRef(0);
  useEffect(
    () => () => {
      attachGeneration.current++;
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    void readBrowserDirectory(directory)
      .then((found) => {
        if (!cancelled) {
          setEntries(found);
          setLoading(false);
          list.current?.focus();
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("This folder could not be read. Choose it again to grant access.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [directory]);
  const visible = entries.filter(
    (entry) =>
      (hidden || !entry.name.startsWith(".")) &&
      entry.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const index = Math.max(0, Math.min(active, visible.length - 1));
  useLayoutEffect(() => {
    activeIndex.current = index;
  });
  const current = visible[index];
  const path = (name: string) => [...folders.map((folder) => folder.name), name].join("/");
  const enter = (folder: BrowserDirectoryHandle) => {
    moveTo(0);
    setLoading(true);
    setError(null);
    setFolders([...folders, folder]);
    setFilter("");
    setPreview(null);
  };
  const up = () => {
    if (folders.length > 1) {
      moveTo(0);
      setLoading(true);
      setError(null);
      setFolders(folders.slice(0, -1));
      setFilter("");
      setPreview(null);
    }
  };
  const toggle = () => {
    const entry = visible[activeIndex.current];
    if (!entry || entry.kind !== "file") return;
    const key = path(entry.name);
    const next = new Map(selection.current);
    if (next.has(key)) next.delete(key);
    else next.set(key, entry);
    selectFiles(next);
    moveTo(Math.min(activeIndex.current + 1, visible.length - 1));
  };
  const attach = async () => {
    if (submitting.current) return;
    const entry = visible[activeIndex.current];
    const files = new Map(selection.current);
    if (!files.size && entry?.kind === "file") files.set(path(entry.name), entry);
    if (!files.size) return;
    selectFiles(files);
    submitting.current = true;
    setBusy(true);
    setError(null);
    const generation = ++attachGeneration.current;
    await (async () => {
      for (const [key, handle] of files) {
        const opened = await handle.getFile();
        if (generation !== attachGeneration.current) return;
        const attached = await onFiles([opened]);
        if (generation !== attachGeneration.current) return;
        if (!attached) {
          setError("A selected file could not be attached. Your remaining selection is preserved.");
          return;
        }
        const remaining = new Map(selection.current);
        if (remaining.get(key) === handle) remaining.delete(key);
        selectFiles(remaining);
      }
      if (!selection.current.size) onClose();
    })()
      .catch(() => {
        if (generation === attachGeneration.current)
          setError(
            "A selected file could not be read or attached. Your remaining selection is preserved.",
          );
      })
      .finally(() => {
        if (generation === attachGeneration.current) {
          submitting.current = false;
          setBusy(false);
        }
      });
  };
  const showPreview = async () => {
    const entry = visible[activeIndex.current];
    if (entry?.kind !== "file") return;
    try {
      const file = await entry.getFile();
      setPreview(
        file.type.startsWith("image/")
          ? { name: file.name, text: "", url: URL.createObjectURL(file) }
          : { name: file.name, text: await file.slice(0, 64 * 1024).text() },
      );
    } catch {
      setError("This file could not be previewed.");
    }
  };
  return (
    <section
      className="flex min-h-0 flex-col gap-3 px-4 pb-4"
      aria-label="Granted local folder"
      data-keyboard-object="Local files"
      data-keyboard-local
      data-keyboard-help="J/K or arrows move · H/Left goes up · L/Right enters · / filters · Space selects · P previews · Enter attaches · . shows hidden files"
      onKeyDownCapture={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.altKey ||
          event.metaKey ||
          (event.ctrlKey && !["n", "p", "Enter"].includes(event.key))
        )
          return;
        const input = event.target instanceof HTMLInputElement;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (preview) setPreview(null);
          else if (filter) {
            setFilter("");
            list.current?.focus();
          } else onClose();
          return;
        }
        if (input && event.key !== "ArrowDown") return;
        if (!(event.target instanceof Element) || (!input && !list.current?.contains(event.target)))
          return;
        const key = event.key.toLowerCase();
        const entry = visible[activeIndex.current];
        if (key === "arrowdown" || key === "j" || (event.ctrlKey && key === "n"))
          moveTo(Math.min(activeIndex.current + 1, visible.length - 1));
        else if (key === "arrowup" || key === "k" || (event.ctrlKey && key === "p"))
          moveTo(Math.max(0, activeIndex.current - 1));
        else if (key === "h" || key === "arrowleft") up();
        else if ((key === "l" || key === "arrowright") && entry?.kind === "directory") enter(entry);
        else if (key === "/") {
          search.current?.focus();
          event.preventDefault();
          event.stopPropagation();
          return;
        } else if (key === ".") setHidden(!hidden);
        else if (key === " ") toggle();
        else if (key === "p") void showPreview();
        else if (key === "enter") {
          if (entry?.kind === "directory" && !event.ctrlKey) enter(entry);
          else void attach();
        } else return;
        event.preventDefault();
        event.stopPropagation();
        list.current?.focus();
        requestAnimationFrame(() =>
          list.current
            ?.querySelector('[aria-current="true"]')
            ?.scrollIntoView({ block: "nearest" }),
        );
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={folders.length === 1} onClick={up}>
          Parent folder
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={folders.length === 1}
          onClick={() => {
            moveTo(0);
            setLoading(true);
            setError(null);
            setFolders([root]);
            setFilter("");
          }}
        >
          Granted folder
        </Button>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {folders.map((folder) => folder.name).join(" / ")}
        </span>
      </div>
      <input
        ref={search}
        aria-label="Filter local files"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
          moveTo(0);
        }}
        className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
      />
      <div className="grid min-h-0 gap-3 sm:grid-cols-2">
        <div
          ref={list}
          tabIndex={0}
          role="listbox"
          aria-label="Local files"
          aria-multiselectable="true"
          aria-activedescendant={current ? `local-file-${index}` : undefined}
          className="max-h-72 min-h-32 overflow-y-auto rounded-md border p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {visible.map((entry, entryIndex) => (
            <div
              key={path(entry.name)}
              className="grid grid-cols-[auto_1fr] items-center gap-2"
              aria-current={entryIndex === index ? "true" : undefined}
            >
              <span aria-hidden>
                {entry.kind === "directory" ? "▸" : selected.has(path(entry.name)) ? "✓" : "·"}
              </span>
              <Button
                id={`local-file-${entryIndex}`}
                role="option"
                aria-selected={selected.has(path(entry.name))}
                variant={entryIndex === index ? "secondary" : "ghost"}
                onClick={() => {
                  moveTo(entryIndex);
                  if (entry.kind === "directory") enter(entry);
                }}
              >
                <span className="truncate">{entry.name}</span>
              </Button>
            </div>
          ))}
          {loading ? (
            <p role="status">Reading folder…</p>
          ) : !visible.length ? (
            <p>No matching files</p>
          ) : null}
        </div>
        {preview ? (
          <div className="min-w-0">
            <div className="flex items-center justify-between">
              <span className="truncate text-sm">{preview.name}</span>
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                Close preview
              </Button>
            </div>
            {preview.url ? (
              <img
                src={preview.url}
                alt={preview.name}
                className="max-h-64 max-w-full object-contain"
              />
            ) : (
              <pre
                tabIndex={0}
                aria-label="File preview"
                className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs"
              >
                {preview.text}
              </pre>
            )}
          </div>
        ) : null}
      </div>
      {selected.size ? (
        <ul aria-label="Selected local files" className="max-h-24 overflow-y-auto">
          {[...selected.keys()].map((key) => (
            <li key={key} className="flex items-center justify-between gap-2">
              <span className="truncate text-xs">{key}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${key} from selection`}
                onClick={() => {
                  const next = new Map(selection.current);
                  next.delete(key);
                  selectFiles(next);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between">
        <span role="status" className="text-xs text-muted-foreground">
          {selected.size} selected
        </span>
        <Button
          disabled={busy || (!selected.size && current?.kind !== "file")}
          onClick={() => void attach()}
        >
          {busy ? "Attaching…" : "Attach files"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
