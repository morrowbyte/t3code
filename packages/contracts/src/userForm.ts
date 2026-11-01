import * as Schema from "effect/Schema";

import {
  CommandId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/));
const Text = Schema.String.check(Schema.isMaxLength(10000));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10000));
const Finite = Schema.Number.check(Schema.isFinite());
const Common = {
  id: Id,
  label: Label,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  required: Schema.optional(Schema.Boolean),
};
const Options = Schema.Array(
  Schema.Struct({
    value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    label: Label,
    description: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(40));

export const UserFormField = Schema.Union([
  Schema.Struct({
    ...Common,
    type: Schema.Literals(["text", "multiline"]),
    default: Schema.optional(Text),
    placeholder: Schema.optional(Label),
    minLength: Schema.optional(Count),
    maxLength: Schema.optional(Count),
  }),
  Schema.Struct({
    ...Common,
    type: Schema.Literal("number"),
    default: Schema.optional(Finite),
    min: Schema.optional(Finite),
    max: Schema.optional(Finite),
  }),
  Schema.Struct({
    ...Common,
    type: Schema.Literal("select"),
    options: Options,
    default: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...Common,
    type: Schema.Literal("multiselect"),
    options: Options,
    default: Schema.optional(Schema.Array(Schema.String)),
    min: Schema.optional(Count),
    max: Schema.optional(Count),
  }),
  Schema.Struct({
    ...Common,
    type: Schema.Literal("boolean"),
    default: Schema.optional(Schema.Boolean),
  }),
]);
export type UserFormField = typeof UserFormField.Type;

export const RequestFormInput = Schema.Struct({
  title: Label,
  fields: Schema.Array(UserFormField).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  clientRequestId: Schema.optional(Label),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000), Schema.isLessThanOrEqualTo(3600000)),
  ),
});
export type RequestFormInput = typeof RequestFormInput.Type;

export const UserFormSubmitCommand = Schema.Struct({
  type: Schema.Literal("user-form.submit"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: RunId,
  rootNodeId: NodeId,
  requestId: RuntimeRequestId,
  nodeId: NodeId,
  turnItemId: TurnItemId,
  form: RequestFormInput,
});
export type UserFormSubmitCommand = typeof UserFormSubmitCommand.Type;

export const RequestFormResult = Schema.Struct({
  requestId: RuntimeRequestId,
  status: Schema.Literals(["submitted", "cancelled", "timed_out"]),
  answers: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
    ),
  ),
});
export type RequestFormResult = typeof RequestFormResult.Type;

export type UserFormValue = string | number | boolean | ReadonlyArray<string>;
export type UserFormWireValue = string | ReadonlyArray<string>;

export function userFormDefault(field: UserFormField): UserFormWireValue {
  const value = field.default;
  if (Array.isArray(value)) return value;
  if (value !== undefined) return String(value);
  return field.type === "boolean" ? "false" : field.type === "multiselect" ? [] : "";
}

export function userFormFieldError(field: UserFormField, value: unknown): string | null {
  const missing =
    value === undefined ||
    value === "" ||
    (field.type === "multiselect" && Array.isArray(value) && value.length === 0);
  if (missing) return field.required === false ? null : "Required.";
  if (field.type === "multiselect") {
    if (
      !Array.isArray(value) ||
      !value.every(
        (entry) =>
          typeof entry === "string" && field.options.some((option) => option.value === entry),
      )
    )
      return "Choose from the available options.";
    if (new Set(value).size !== value.length) return "Choose each option once.";
    if (field.min !== undefined && value.length < field.min) return `Choose at least ${field.min}.`;
    if (field.max !== undefined && value.length > field.max) return `Choose at most ${field.max}.`;
    return null;
  }
  if (typeof value !== "string") return "Enter a valid value.";
  if (field.type === "boolean")
    return value === "true" || value === "false" ? null : "Choose yes or no.";
  if (field.type === "select")
    return field.options.some((option) => option.value === value)
      ? null
      : "Choose from the available options.";
  if (field.type === "number") {
    if (
      value.trim().length === 0 ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
      !Number.isFinite(Number(value))
    )
      return "Enter a number.";
    if (field.min !== undefined && Number(value) < field.min) return `Enter ${field.min} or more.`;
    if (field.max !== undefined && Number(value) > field.max) return `Enter ${field.max} or less.`;
    return null;
  }
  if (field.required !== false && value.trim().length === 0) return "Required.";
  if (field.minLength !== undefined && value.length < field.minLength)
    return `Use at least ${field.minLength} characters.`;
  if (value.length > (field.maxLength ?? 10000))
    return `Use at most ${field.maxLength ?? 10000} characters.`;
  return null;
}

export function userFormDefinitionError(fields: ReadonlyArray<UserFormField>): string | null {
  if (new Set(fields.map((field) => field.id)).size !== fields.length)
    return "Field ids must be unique.";
  for (const field of fields) {
    if (
      (field.type === "number" || field.type === "multiselect") &&
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    )
      return `${field.label}: minimum exceeds maximum.`;
    if (
      (field.type === "text" || field.type === "multiline") &&
      field.minLength !== undefined &&
      field.maxLength !== undefined &&
      field.minLength > field.maxLength
    )
      return `${field.label}: minimum length exceeds maximum length.`;
    if (
      (field.type === "select" || field.type === "multiselect") &&
      new Set(field.options.map((option) => option.value)).size !== field.options.length
    )
      return `${field.label}: option values must be unique.`;
    if (field.type === "multiselect" && field.min !== undefined && field.min > field.options.length)
      return `${field.label}: minimum exceeds the option count.`;
    if (field.default !== undefined) {
      const error = userFormFieldError(field, userFormDefault(field));
      if (error) return `${field.label}: invalid default. ${error}`;
    }
  }
  return null;
}

export function validateUserFormAnswers(
  questions: ReadonlyArray<{ readonly id: string; readonly field?: UserFormField | undefined }>,
  answers: Readonly<Record<string, unknown>>,
): {
  readonly errors: Readonly<Record<string, string>>;
  readonly answers: Readonly<Record<string, UserFormValue>>;
} {
  const errors: Record<string, string> = {};
  const result: Record<string, UserFormValue> = {};
  for (const key of Object.keys(answers)) {
    if (!questions.some((question) => question.id === key)) errors[key] = "Unknown field.";
  }
  for (const question of questions) {
    const field = question.field;
    if (!field) continue;
    const value = answers[question.id];
    const error = userFormFieldError(field, value);
    if (error) {
      errors[question.id] = error;
      continue;
    }
    if (value === undefined || value === "") continue;
    result[question.id] =
      field.type === "number"
        ? Number(value)
        : field.type === "boolean"
          ? value === "true"
          : (value as string | ReadonlyArray<string>);
  }
  return { errors, answers: result };
}
