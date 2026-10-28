import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";

export function PreviewSelectionFeedback(props: {
  annotation: PreviewAnnotationPayload;
  canSend: boolean;
  onSend: (annotation: PreviewAnnotationPayload) => void;
  onAttach: (annotation: PreviewAnnotationPayload) => void;
  onClear: () => void;
  onScreenshot?: (() => void) | undefined;
}) {
  const [comment, setComment] = useState(props.annotation.comment);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const annotation = () => ({
    ...props.annotation,
    comment: comment.trim(),
    screenshot: includeScreenshot ? props.annotation.screenshot : null,
  });
  const label =
    props.annotation.elements[0]?.element.selector ??
    props.annotation.elements[0]?.element.tagName ??
    "Selected region";
  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-b border-border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.canSend) props.onSend(annotation());
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</span>
        <Button type="button" variant="ghost" size="xs" onClick={props.onClear}>
          Clear selection
        </Button>
      </div>
      <Input
        size="sm"
        aria-label="Selection feedback"
        placeholder="Describe the change…"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="flex items-center justify-end gap-2">
        {props.annotation.screenshot ? (
          <label className="mr-auto flex items-center gap-2 text-xs">
            <Checkbox
              checked={includeScreenshot}
              onCheckedChange={(checked) => setIncludeScreenshot(checked === true)}
            />
            Screenshot
          </label>
        ) : null}
        {!props.annotation.screenshot && props.onScreenshot ? (
          <Button type="button" variant="ghost" size="xs" onClick={props.onScreenshot}>
            Screenshot
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => props.onAttach(annotation())}
        >
          Add to draft
        </Button>
        <Button type="submit" size="xs" disabled={!props.canSend}>
          Send
        </Button>
      </div>
    </form>
  );
}
