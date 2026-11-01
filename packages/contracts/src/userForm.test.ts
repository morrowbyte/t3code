import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  RequestFormInput,
  userFormDefinitionError,
  userFormFieldError,
  validateUserFormAnswers,
} from "./userForm.ts";

const decodeForm = Schema.decodeSync(RequestFormInput);
const decodeUnknownForm = Schema.decodeUnknownSync(RequestFormInput);

describe("mixed user forms", () => {
  it("decodes a bounded declarative form and returns typed values without coercing invalid input", () => {
    const form = decodeForm({
      title: "Plan a visit",
      fields: [
        { id: "name", type: "text", label: "Name", minLength: 2, maxLength: 40 },
        { id: "guests", type: "number", label: "Guests", min: 1, max: 12 },
        {
          id: "time",
          type: "select",
          label: "Time",
          options: [
            { value: "am", label: "Morning" },
            { value: "pm", label: "Afternoon" },
          ],
        },
        {
          id: "extras",
          type: "multiselect",
          label: "Extras",
          max: 2,
          required: false,
          options: [{ value: "parking", label: "Parking" }],
        },
        { id: "notify", type: "boolean", label: "Notify me", default: false },
        { id: "notes", type: "multiline", label: "Notes", required: false },
      ],
    });
    const questions = form.fields.map((field) => ({ id: field.id, field }));
    const result = validateUserFormAnswers(questions, {
      name: "Jo",
      guests: "2",
      time: "pm",
      extras: [],
      notify: "false",
      notes: "",
    });
    expect(result).toEqual({
      errors: {},
      answers: { name: "Jo", guests: 2, time: "pm", extras: [], notify: false },
    });
    expect(
      validateUserFormAnswers(questions, {
        name: " ",
        guests: "0x10",
        time: "night",
        extras: ["parking", "parking"],
        notify: "yes",
        script: "alert(1)",
      }).errors,
    ).toEqual({
      script: "Unknown field.",
      name: "Required.",
      guests: "Enter a number.",
      time: "Choose from the available options.",
      extras: "Choose each option once.",
      notify: "Choose yes or no.",
    });
    const optionalQuestions = questions.map(({ id, field }) => ({
      id,
      field: { ...field, required: false },
    }));
    expect(
      validateUserFormAnswers(optionalQuestions, {
        name: [],
        guests: [],
        time: [],
        extras: [],
        notify: [],
        notes: [],
      }),
    ).toEqual({
      errors: {
        name: "Enter a valid value.",
        guests: "Enter a valid value.",
        time: "Enter a valid value.",
        notify: "Enter a valid value.",
        notes: "Enter a valid value.",
      },
      answers: { extras: [] },
    });
  });

  it("rejects unsafe schemas, duplicate ids, invalid defaults and impossible bounds", () => {
    expect(() =>
      decodeUnknownForm({
        title: "Unsafe",
        fields: [{ id: "secret", label: "Password", type: "password" }],
      }),
    ).toThrow();
    const text = { id: "name", label: "Name", type: "text" as const };
    expect(userFormDefinitionError([text, text])).toBe("Field ids must be unique.");
    expect(userFormDefinitionError([{ ...text, minLength: 5, maxLength: 2 }])).toContain(
      "minimum length",
    );
    expect(
      userFormDefinitionError([
        { id: "count", label: "Count", type: "number", min: 5, default: 2 },
      ]),
    ).toContain("invalid default");
    expect(userFormFieldError({ ...text, required: false, maxLength: 2 }, "three")).toBe(
      "Use at most 2 characters.",
    );
  });
});
