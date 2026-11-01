import { userFormDefault, userFormFieldError, type UserFormField } from "@t3tools/contracts";
import { useId, useState } from "react";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

export function UserFormFields({
  fields,
  drafts,
  disabled,
  onChange,
  onToggle,
}: {
  readonly fields: ReadonlyArray<UserFormField>;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly disabled: boolean;
  readonly onChange: (id: string, value: string) => void;
  readonly onToggle: (id: string, value: string) => void;
}) {
  const prefix = useId();
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="grid min-w-0 gap-4">
      {fields.map((field) => {
        const draft = drafts[field.id];
        const value =
          field.type === "multiselect"
            ? (draft?.selectedOptionValues ??
              (draft?.customAnswer === undefined ? userFormDefault(field) : []))
            : (draft?.customAnswer ?? draft?.selectedOptionValues?.[0] ?? userFormDefault(field));
        const text = typeof value === "string" ? value : "";
        const id = `${prefix}-${field.id}`;
        const error = touched.has(field.id) ? userFormFieldError(field, value) : null;
        const markTouched = () => setTouched((previous) => new Set(previous).add(field.id));
        const describedBy =
          [field.description ? `${id}-description` : null, error ? `${id}-error` : null]
            .filter(Boolean)
            .join(" ") || undefined;
        const common = {
          id,
          disabled,
          "aria-label": field.label,
          "aria-required": field.required !== false,
          "aria-invalid": Boolean(error),
          "aria-describedby": describedBy,
          style: { scrollMarginBlock: 12 },
          onBlur: markTouched,
        };
        return (
          <div
            key={field.id}
            className="min-w-0 scroll-my-3 space-y-1.5"
            onFocusCapture={(event) => {
              event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
            }}
          >
            <label htmlFor={id} className="block text-sm font-medium text-foreground">
              {field.label}
              {field.required === false ? (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">Optional</span>
              ) : null}
            </label>
            {field.description ? (
              <p id={`${id}-description`} className="text-xs leading-relaxed text-muted-foreground">
                {field.description}
              </p>
            ) : null}
            {field.type === "text" || field.type === "number" ? (
              <Input
                {...common}
                type={field.type === "number" ? "number" : "text"}
                value={text}
                placeholder={field.type === "text" ? field.placeholder : undefined}
                min={field.type === "number" ? field.min : undefined}
                max={field.type === "number" ? field.max : undefined}
                step={field.type === "number" ? "any" : undefined}
                maxLength={field.type === "text" ? field.maxLength : undefined}
                onChange={(event) => onChange(field.id, event.target.value)}
              />
            ) : field.type === "multiline" ? (
              <Textarea
                {...common}
                value={text}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                rows={3}
                onChange={(event) => onChange(field.id, event.target.value)}
              />
            ) : field.type === "boolean" ? (
              <div className="flex items-center gap-2.5 py-1">
                <Checkbox
                  {...common}
                  checked={text === "true"}
                  onCheckedChange={(checked) => {
                    markTouched();
                    onChange(field.id, String(checked));
                  }}
                />
                <label htmlFor={id} className="text-sm">
                  {text === "true" ? "Yes" : "No"}
                </label>
              </div>
            ) : field.type === "select" ? (
              <Select
                value={text || null}
                onValueChange={(next) => {
                  markTouched();
                  onChange(field.id, next ?? "");
                }}
                items={field.options}
                disabled={disabled}
              >
                <SelectTrigger {...common}>
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectPopup>
                  {field.required === false ? <SelectItem value="">None</SelectItem> : null}
                  {field.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="grid gap-0.5">
                        <span>{option.label}</span>
                        {option.description ? (
                          <span className="text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : field.type === "multiselect" ? (
              <div
                id={id}
                role="group"
                aria-label={field.label}
                aria-describedby={describedBy}
                className="grid gap-1.5"
              >
                {field.options.map((option) => (
                  <label
                    key={option.value}
                    className="flex min-h-10 cursor-pointer items-start gap-3 rounded-lg border border-input px-3 py-2 has-data-checked:border-primary has-data-checked:bg-primary/5"
                  >
                    <span className="pt-0.5">
                      <Checkbox
                        disabled={disabled}
                        checked={Array.isArray(value) && value.includes(option.value)}
                        onCheckedChange={() => {
                          markTouched();
                          onToggle(field.id, option.value);
                        }}
                        aria-label={option.label}
                      />
                    </span>
                    <span className="min-w-0 text-sm">
                      <span>{option.label}</span>
                      {option.description ? (
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            {error ? (
              <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function UserFormActions({
  disabled,
  complete,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly disabled: boolean;
  readonly complete: boolean;
  readonly busy: boolean;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || busy}
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button type="button" size="sm" disabled={disabled || busy || !complete} onClick={onSubmit}>
        {busy ? "Sending…" : "Submit"}
      </Button>
    </div>
  );
}
