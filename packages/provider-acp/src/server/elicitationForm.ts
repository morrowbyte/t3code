import {
  UserFormField,
  userFormDefinitionError,
  type OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeField = Schema.decodeUnknownOption(UserFormField);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function elicitationFormQuestions(
  schema: unknown,
  message: string,
): ReadonlyArray<OrchestrationV2UserInputQuestion> | undefined {
  const form = record(schema);
  const properties = record(form?.properties);
  if (!properties || Object.keys(properties).length === 0 || Object.keys(properties).length > 20)
    return undefined;
  if (
    !Object.values(properties).some((value) => {
      const field = record(value);
      return (
        field?.type !== "string" ||
        field.multiline === true ||
        field.minLength !== undefined ||
        field.maxLength !== undefined
      );
    })
  )
    return undefined;
  const title = typeof form?.title === "string" ? form.title : message;
  const required = Array.isArray(form?.required) ? form.required : [];
  const fields: Array<typeof UserFormField.Type> = [];
  for (const [id, value] of Object.entries(properties)) {
    const property = record(value);
    if (
      !property ||
      property.format !== undefined ||
      property.oneOf !== undefined ||
      property.anyOf !== undefined
    )
      return undefined;
    const type = property.type;
    const items = record(property.items);
    const enumValues = type === "array" ? items?.enum : property.enum;
    const labels = type === "array" ? items?.enumNames : property.enumNames;
    const options =
      Array.isArray(enumValues) && enumValues.every((option) => typeof option === "string")
        ? enumValues.map((option, index) => ({
            value: option,
            label:
              Array.isArray(labels) && typeof labels[index] === "string" ? labels[index] : option,
          }))
        : undefined;
    const base = {
      id,
      label: typeof property.title === "string" ? property.title : id,
      required: required.includes(id),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      ...(property.default === undefined ? {} : { default: property.default }),
    };
    const candidate =
      type === "string"
        ? options
          ? { ...base, type: "select", options }
          : {
              ...base,
              type: property.multiline === true ? "multiline" : "text",
              minLength: property.minLength,
              maxLength: property.maxLength,
            }
        : type === "number"
          ? { ...base, type, min: property.minimum, max: property.maximum }
          : type === "boolean"
            ? { ...base, type }
            : type === "array" && items?.type === "string" && options
              ? {
                  ...base,
                  type: "multiselect",
                  options,
                  min: property.minItems,
                  max: property.maxItems,
                }
              : undefined;
    const decoded = decodeField(candidate);
    if (Option.isNone(decoded)) return undefined;
    fields.push(decoded.value);
  }
  if (userFormDefinitionError(fields)) return undefined;
  return fields.map((field) => ({
    id: field.id,
    header: title || "Form",
    question: field.label,
    field,
    required: field.required !== false,
    allowCustomAnswer: false,
    multiSelect: field.type === "multiselect",
    options:
      field.type === "select" || field.type === "multiselect"
        ? field.options.map((option) => ({
            ...option,
            description: option.description ?? option.label,
          }))
        : [],
  }));
}
