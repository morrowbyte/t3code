import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { type UserFormField, validateUserFormAnswers } from "@t3tools/contracts";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { render } from "../../../test/render";
import { UserFormActions, UserFormFields } from "./UserFormFields";

it("edits mixed fields, explains invalid values and submits false and optional empty choices", async () => {
  const fields: ReadonlyArray<UserFormField> = [
    { id: "name", type: "text", label: "Name", minLength: 2 },
    { id: "guests", type: "number", label: "Guests", min: 1, max: 12, default: 2 },
    {
      id: "time",
      type: "select",
      label: "Time",
      options: [{ value: "pm", label: "Afternoon" }],
      default: "pm",
    },
    {
      id: "food",
      type: "multiselect",
      label: "Food",
      required: false,
      options: [{ value: "vegan", label: "Vegan" }],
    },
    { id: "reminder", type: "boolean", label: "Reminder", default: false },
    { id: "notes", type: "multiline", label: "Notes", required: false },
  ];
  const questions = fields.map((field) => ({
    id: field.id,
    field,
    multiSelect: field.type === "multiselect",
    options: field.type === "select" || field.type === "multiselect" ? field.options : [],
  }));
  const submit = vi.fn();
  const cancel = vi.fn();
  function Form() {
    const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
    const answers = buildPendingUserInputAnswers(questions, drafts);
    return (
      <div>
        <UserFormFields
          fields={fields}
          drafts={drafts}
          disabled={false}
          onChange={(id, value) =>
            setDrafts((previous) => ({
              ...previous,
              [id]: setPendingUserInputCustomAnswer(
                questions.find((question) => question.id === id)!,
                previous[id],
                value,
              ),
            }))
          }
          onToggle={(id, value) =>
            setDrafts((previous) => ({
              ...previous,
              [id]: togglePendingUserInputOptionSelection(
                questions.find((question) => question.id === id)!,
                previous[id],
                value,
              ),
            }))
          }
        />
        <UserFormActions
          disabled={false}
          busy={false}
          complete={answers !== null}
          onSubmit={() => submit(validateUserFormAnswers(questions, answers ?? {}).answers)}
          onCancel={cancel}
        />
      </div>
    );
  }
  await using screen = await render(<Form />);
  const name = screen.container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  const guests = screen.container.querySelector<HTMLInputElement>('input[aria-label="Guests"]')!;
  const buttons = [...screen.container.querySelectorAll<HTMLButtonElement>("button")];
  const send = buttons.find((button) => button.textContent === "Submit")!;
  expect(send.disabled).toBe(true);
  await userEvent.fill(name, "A");
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByText("Use at least 2 characters.")).toBeVisible();
  await userEvent.fill(name, "Ada");
  await userEvent.fill(guests, "13");
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByText("Enter 12 or less.")).toBeVisible();
  expect(send.disabled).toBe(true);
  await userEvent.fill(guests, "4");
  await userEvent.click(send);
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    name: "Ada",
    guests: 4,
    time: "pm",
    food: [],
    reminder: false,
  });
  await userEvent.click(buttons.find((button) => button.textContent === "Cancel")!);
  expect(cancel).toHaveBeenCalledOnce();
});
