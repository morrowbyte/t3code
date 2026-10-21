import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandDialog, CommandDialogPopup, CommandItem, CommandList } from "../ui/command";

export type ComposerChoice = {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
};

export function ComposerChoiceDialog(props: {
  readonly title: string;
  readonly choices: ReadonlyArray<ComposerChoice>;
  readonly emptyMessage: string;
  readonly onClose: () => void;
  readonly restoreFocus: () => HTMLElement | false;
}) {
  const [query, setQuery] = useState("");
  const choices = props.choices.filter((choice) =>
    `${choice.label} ${choice.description ?? ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const select = (choice: ComposerChoice) => {
    choice.onSelect();
    props.onClose();
  };
  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <CommandDialogPopup aria-label={props.title} finalFocus={props.restoreFocus}>
        <CommandPaletteContent
          mode="none"
          items={choices.map((choice) => choice.id)}
          filter={null}
          value={query}
          onValueChange={setQuery}
          footerActionLabel="Select"
          inputProps={{
            placeholder: props.title,
            "aria-label": props.title,
            onKeyDown: (event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (
                event.ctrlKey &&
                !event.altKey &&
                !event.metaKey &&
                ["n", "p"].includes(event.key)
              ) {
                event.preventDefault();
                event.currentTarget.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: event.key === "n" ? "ArrowDown" : "ArrowUp",
                    bubbles: true,
                  }),
                );
              }
            },
          }}
        >
          <CommandList>
            {choices.map((choice) => (
              <CommandItem key={choice.id} value={choice.id} onClick={() => select(choice)}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{choice.label}</span>
                  {choice.description ? (
                    <span className="text-xs text-muted-foreground">{choice.description}</span>
                  ) : null}
                </span>
                {choice.selected ? (
                  <CheckIcon className="size-4" aria-label="Current selection" />
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
          {choices.length === 0 ? (
            <div role="status" className="px-4 py-6 text-sm text-muted-foreground">
              {query ? "No matching options." : props.emptyMessage}
            </div>
          ) : null}
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
