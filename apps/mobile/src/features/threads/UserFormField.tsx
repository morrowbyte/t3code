import {
  userFormDefault,
  userFormFieldError,
  type UserFormField as Field,
} from "@t3tools/contracts";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

export function UserFormField({
  field,
  draft,
  disabled,
  onChange,
  onToggle,
  onInputFocusChange,
}: {
  readonly field: Field;
  readonly draft: PendingUserInputDraftAnswer | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onToggle: (value: string) => void;
  readonly onInputFocusChange?: ((focused: boolean) => void) | undefined;
}) {
  const [touched, setTouched] = useState(false);
  const value =
    field.type === "multiselect"
      ? (draft?.selectedOptionValues ??
        (draft?.customAnswer === undefined ? userFormDefault(field) : []))
      : (draft?.customAnswer ?? draft?.selectedOptionValues?.[0] ?? userFormDefault(field));
  const text = typeof value === "string" ? value : "";
  const error = touched ? userFormFieldError(field, value) : null;
  return (
    <View className="gap-2 py-1">
      <Text className="font-t3-bold text-sm text-foreground">
        {field.label}
        {field.required === false ? " · Optional" : ""}
      </Text>
      {field.description ? (
        <Text className="font-sans text-sm text-foreground-muted">{field.description}</Text>
      ) : null}
      {field.type === "boolean" ? (
        <View className="flex-row items-center justify-between gap-3">
          <Text className="font-sans text-sm text-foreground-secondary">
            {text === "true" ? "Yes" : "No"}
          </Text>
          <ThemedSwitch
            accessibilityLabel={field.label}
            value={text === "true"}
            disabled={disabled}
            onValueChange={(next) => {
              setTouched(true);
              onChange(String(next));
            }}
          />
        </View>
      ) : field.type === "select" || field.type === "multiselect" ? (
        <View className="gap-2">
          {field.options.map((option) => {
            const selected = Array.isArray(value)
              ? value.includes(option.value)
              : text === option.value;
            return (
              <Pressable
                key={option.value}
                disabled={disabled}
                accessibilityRole={field.type === "multiselect" ? "checkbox" : "radio"}
                accessibilityLabel={option.label}
                accessibilityState={{ checked: selected, disabled }}
                onPress={() => {
                  setTouched(true);
                  if (field.type === "multiselect") onToggle(option.value);
                  else onChange(selected && field.required === false ? "" : option.value);
                }}
                className={cn(
                  "min-h-12 flex-row items-center gap-3 rounded-2xl border px-3.5 py-3",
                  selected ? "border-primary bg-primary/10" : "border-border bg-input",
                )}
              >
                <SymbolView
                  name={selected ? "checkmark.circle.fill" : "circle"}
                  size={20}
                  tintColorClassName={selected ? "accent-primary" : "accent-icon-subtle"}
                />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="font-sans text-sm text-foreground">{option.label}</Text>
                  {option.description ? (
                    <Text className="font-sans text-sm text-foreground-muted">
                      {option.description}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <TextInput
          accessibilityLabel={field.label}
          accessibilityHint={error ?? field.description}
          value={text}
          editable={!disabled}
          multiline={field.type === "multiline"}
          keyboardType={field.type === "number" ? "numbers-and-punctuation" : "default"}
          inputMode={field.type === "number" ? "decimal" : "text"}
          placeholder={field.type === "number" ? undefined : field.placeholder}
          maxLength={field.type === "number" ? undefined : field.maxLength}
          onChangeText={onChange}
          onFocus={() => onInputFocusChange?.(true)}
          onBlur={() => {
            setTouched(true);
            onInputFocusChange?.(false);
          }}
          className={cn(
            "min-h-[48px] rounded-2xl border bg-input px-3.5 py-3 font-sans text-base text-foreground",
            error ? "border-danger" : "border-input-border",
            field.type === "multiline" && "min-h-[100px]",
          )}
        />
      )}
      {error ? (
        <Text accessibilityRole="alert" className="font-sans text-xs text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
