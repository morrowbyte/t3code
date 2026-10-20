import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";

export interface WorkbenchCommand {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly run: () => void;
}

export function WorkbenchCommandPicker({
  title,
  commands,
  onClose,
}: {
  readonly title: string;
  readonly commands: readonly WorkbenchCommand[];
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const filtered = commands.filter((command) =>
    `${command.label} ${command.detail ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const active = Math.min(selected, Math.max(0, filtered.length - 1));
  const activeCommandId = filtered[active]?.id;
  useLayoutEffect(() => {
    if (activeCommandId === undefined) return;
    list.current
      ?.querySelector<HTMLElement>(`#workbench-command-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, activeCommandId]);
  const select = (command: WorkbenchCommand | undefined) => {
    if (!command) return;
    onClose();
    // Wait until the dialog releases its modal focus scope.
    requestAnimationFrame(() => command.run());
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup aria-label={title} finalFocus={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <input
            autoFocus
            aria-label={`Search ${title.toLowerCase()}`}
            role="combobox"
            aria-expanded="true"
            aria-controls="workbench-commands"
            aria-activedescendant={filtered[active] ? `workbench-command-${active}` : undefined}
            value={query}
            className="mb-2 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              const direction =
                event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")
                  ? 1
                  : event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")
                    ? -1
                    : 0;
              if (direction) {
                event.preventDefault();
                if (filtered.length)
                  setSelected((active + direction + filtered.length) % filtered.length);
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                select(filtered[active]);
              }
            }}
          />
          <div
            ref={list}
            id="workbench-commands"
            role="listbox"
            aria-label={title}
            className="max-h-80 overflow-y-auto"
          >
            {filtered.map((command, index) => (
              <Button
                key={command.id}
                id={`workbench-command-${index}`}
                role="option"
                aria-selected={index === active}
                variant={index === active ? "secondary" : "ghost"}
                onClick={() => select(command)}
              >
                <span className="flex w-full flex-col items-start text-left">
                  <span>{command.label}</span>
                  {command.detail ? (
                    <span className="text-xs text-muted-foreground">{command.detail}</span>
                  ) : null}
                </span>
              </Button>
            ))}
            {filtered.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No matching actions</p>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
