import { expect, it } from "vite-plus/test";
import { elicitationFormQuestions } from "./elicitationForm.ts";
import { validateUserFormAnswers } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as AcpSchema from "effect-acp/schema";

const decodeElicitationRequest = Schema.decodeUnknownSync(AcpSchema.CreateElicitationRequest);

it("preserves required fields, exact option values, bounds and typed native answers", () => {
  const request = decodeElicitationRequest({
    sessionId: "form-session",
    mode: "form",
    message: "Visit",
    requestedSchema: {
      title: "Visit",
      properties: {
        guests: { type: "number", title: "Guests", minimum: 1, maximum: 12, default: 2 },
        extras: {
          type: "array",
          title: "Extras",
          items: { type: "string", enum: [" a ", "b"] },
          maxItems: 1,
        },
        notify: { type: "boolean", title: "Notify", default: false },
        notes: { type: "string", title: "Notes", format: "textarea", maxLength: 400 },
      },
      required: ["guests", "notify"],
    },
  });
  const questions = elicitationFormQuestions(
    "requestedSchema" in request ? request.requestedSchema : undefined,
    request.message,
  );
  expect(questions?.map((question) => question.field)).toEqual([
    { id: "guests", type: "number", label: "Guests", min: 1, max: 12, default: 2, required: true },
    {
      id: "extras",
      type: "multiselect",
      label: "Extras",
      max: 1,
      options: [
        { value: " a ", label: "a" },
        { value: "b", label: "b" },
      ],
      required: false,
    },
    { id: "notify", type: "boolean", label: "Notify", default: false, required: true },
    { id: "notes", type: "multiline", label: "Notes", maxLength: 400, required: false },
  ]);
  expect(
    validateUserFormAnswers(questions!, { guests: "3", extras: [" a "], notify: "false" }),
  ).toEqual({ errors: {}, answers: { guests: 3, extras: [" a "], notify: false } });
  expect(validateUserFormAnswers(questions!, { guests: "13", notify: "yes" }).errors).toEqual({
    guests: "Enter 12 or less.",
    notify: "Choose yes or no.",
  });
});

it("keeps legacy choice prompts and unsupported schemas on their existing path", () => {
  expect(
    elicitationFormQuestions(
      { properties: { choice: { type: "string", enum: ["A", "B"] } } },
      "Choose",
    ),
  ).toBeUndefined();
  expect(
    elicitationFormQuestions(
      { properties: { nested: { type: "object", properties: {} } } },
      "Nested",
    ),
  ).toBeUndefined();
});

import { assert, describe } from "@effect/vitest";

import { parseElicitationForm } from "./elicitationForm.ts";

describe("parseElicitationForm", () => {
  for (const type of ["string", "array"] as const) {
    it.each([
      { values: [" padded ", "", "plain"], labels: ["padded", '""', "plain"] },
      { values: [" a", "a", "b"], labels: ['" a"', '"a"', "b"] },
      { values: [" a", "a", '"a"'], labels: ['" a"', '"a"', '"\\"a\\""'] },
    ])(
      `preserves ${type} enum values with distinct readable labels: $values`,
      ({ values, labels }) => {
        const form = parseElicitationForm(
          {
            type: "object",
            properties: {
              answer:
                type === "array"
                  ? { type, items: { type: "string", enum: values } }
                  : { type, enum: values },
            },
            required: ["answer"],
          },
          "Choose",
        );
        assert(form !== undefined);
        const question = form.questions[0];
        assert(question !== undefined);
        assert.deepStrictEqual(
          question.options.map((option) => option.label),
          labels,
        );
        assert.deepStrictEqual(
          question.options.map((option) => option.value),
          values,
        );
        assert.strictEqual(question.allowCustomAnswer, false);
        assert.strictEqual(question.multiSelect, type === "array" ? true : undefined);
        for (const value of values) {
          const answer = type === "array" ? [value] : value;
          assert.deepStrictEqual(form.content({ answer }), { answer });
        }
      },
    );
  }

  it("asks each question once when a choice has a free-text companion field", () => {
    // OMP's ask dialog follows each choice `q<n>` with a free-text `q<n>__other` field.
    const ask = (question: string, header: string) => ({
      type: "string",
      title: question,
      description: header,
      oneOf: [
        { const: "Yes", title: "Yes" },
        { const: "No", title: "No" },
      ],
    });
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: ask("Use Postgres for the new service?", "Database"),
          q0__other: { type: "string", title: "Other (type your own)" },
          q1: ask("Deploy to staging first?", "Deploy"),
          q1__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Answer 2 questions",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) =>
        [question.header, question.question].some((text) => text.endsWith("?")),
      ),
      [true, true],
    );
    assert.deepStrictEqual(form.content({ q0: "Yes", q1: "Only on Fridays" }), {
      q0: "Yes",
      q1__other: "Only on Fridays",
    });

    // A multi-select answer can carry options and free text together, so both fields stay.
    const multi = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: { type: "array", title: "Databases?", items: { anyOf: [{ const: "Postgres" }] } },
          q0__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Databases?",
    );
    assert(multi !== undefined);
    assert.deepStrictEqual(multi.content({ q0: ["Postgres"], q0__other: "SQLite" }), {
      q0: ["Postgres"],
      q0__other: "SQLite",
    });
  });
});
