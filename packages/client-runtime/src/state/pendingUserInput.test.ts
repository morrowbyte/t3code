import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput.ts";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    { label: "Orchestration-first", description: "Focus on orchestration first" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

it("preserves mixed-form defaults, false, empty optional selections and edited values", () => {
  const questions = [
    {
      id: "name",
      options: [],
      allowCustomAnswer: false,
      field: { id: "name", type: "text" as const, label: "Name", default: "Ada" },
    },
    {
      id: "count",
      options: [],
      allowCustomAnswer: false,
      field: { id: "count", type: "number" as const, label: "Count", min: 0, default: 0 },
    },
    {
      id: "notify",
      options: [],
      allowCustomAnswer: false,
      field: { id: "notify", type: "boolean" as const, label: "Notify", default: false },
    },
    {
      id: "extras",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      multiSelect: true,
      allowCustomAnswer: false,
      field: {
        id: "extras",
        type: "multiselect" as const,
        label: "Extras",
        required: false,
        default: ["a"],
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
    },
  ];
  expect(buildPendingUserInputAnswers(questions, {})).toEqual({
    name: "Ada",
    count: "0",
    notify: "false",
    extras: ["a"],
  });
  const edited = setPendingUserInputCustomAnswer(questions[0]!, undefined, "Grace");
  const cleared = togglePendingUserInputOptionSelection(questions[3]!, undefined, "a");
  expect(buildPendingUserInputAnswers(questions, { name: edited, extras: cleared })).toEqual({
    name: "Grace",
    count: "0",
    notify: "false",
    extras: [],
  });
  const selectedAfterClearing = togglePendingUserInputOptionSelection(questions[3]!, cleared, "b");
  expect(resolvePendingUserInputAnswer(questions[3]!, selectedAfterClearing)).toEqual(["b"]);
  expect(buildPendingUserInputAnswers(questions, { count: { customAnswer: "-1" } })).toBeNull();
  expect(isPendingUserInputOptionSelected(questions[3]!, undefined, "a")).toBe(true);
});

const nativeChoiceQuestion = {
  id: "result",
  header: "Result",
  question: "Which result should be used?",
  options: [
    { value: " first\t", label: "Result", description: "First result" },
    { value: "second", label: "Result", description: "Second result" },
  ],
  allowCustomAnswer: false,
  multiSelect: false,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(resolvePendingUserInputAnswer(question, { customAnswer: question.initialAnswer })).toBe(
      question.initialAnswer,
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "  Edited message\n\n" })).toBe(
      "  Edited message\n\n",
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "" })).toBe("");
    expect(resolvePendingUserInputAnswer(question, { customAnswer: " \n" })).toBe(" \n");
    expect(
      setPendingUserInputCustomAnswer(
        question,
        { selectedOptionValues: ["Orchestration-first"] },
        "",
      ),
    ).toEqual({ customAnswer: "" });
  });

  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("does not replace a required choice with a custom answer", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["second"],
        customAnswer: "Use another result",
      }),
    ).toBe("second");
  });

  it("does not submit labels or unknown values when an option has a value", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["Result", "unknown"],
      }),
    ).toBeNull();
  });

  it("matches a label only for an option without a value", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, { selectedOptionValues: [" Node.js "] }),
    ).toBe("Node.js");
  });

  it("accepts ready attachment-only answers while preserving selected options", () => {
    expect(resolvePendingUserInputAnswer(singleSelectQuestion, { attachmentCount: 1 })).toBe("");
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        attachmentCount: 1,
        selectedOptionValues: ["Node.js"],
      }),
    ).toBe("Node.js");
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        attachmentCount: 1,
        attachmentsBlocked: true,
      }),
    ).toBeNull();
    expect(
      resolvePendingUserInputAnswer(
        { ...singleSelectQuestion, allowCustomAnswer: false },
        { attachmentCount: 1 },
      ),
    ).toBeNull();
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("selects and removes options with the same label independently", () => {
    const question = { ...nativeChoiceQuestion, multiSelect: true };
    const firstSelected = togglePendingUserInputOptionSelection(question, undefined, " first\t");
    const bothSelected = togglePendingUserInputOptionSelection(question, firstSelected, "second");

    expect(buildPendingUserInputAnswers([question], { result: bothSelected })).toEqual({
      result: [" first\t", "second"],
    });

    const secondSelected = togglePendingUserInputOptionSelection(
      question,
      bothSelected,
      " first\t",
    );
    expect(buildPendingUserInputAnswers([question], { result: secondSelected })).toEqual({
      result: ["second"],
    });
  });

  it("submits raw option values and leaves the draft alone for an unknown option", () => {
    const first = togglePendingUserInputOptionSelection(
      nativeChoiceQuestion,
      undefined,
      " first\t",
    );
    expect(isPendingUserInputOptionSelected(nativeChoiceQuestion, first, " first\t")).toBe(true);
    expect(isPendingUserInputOptionSelected(nativeChoiceQuestion, first, "second")).toBe(false);
    expect(buildPendingUserInputAnswers([nativeChoiceQuestion], { result: first })).toEqual({
      result: " first\t",
    });
    expect(togglePendingUserInputOptionSelection(nativeChoiceQuestion, first, "Result")).toBe(
      first,
    );
  });
});

describe("setPendingUserInputCustomAnswer", () => {
  it("rejects arbitrary text when the provider only accepts offered options", () => {
    expect(setPendingUserInputCustomAnswer(nativeChoiceQuestion, undefined, "Other")).toEqual({});
    expect(
      buildPendingUserInputAnswers([nativeChoiceQuestion], { result: { customAnswer: "Other" } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([nativeChoiceQuestion], {
        result: { selectedOptionValues: ["second"], customAnswer: "stale draft" },
      }),
    ).toEqual({ result: "second" });
  });
});

const compatQuestion = {
  id: "compat",
  header: "Compat",
  question: "How strict should compatibility be?",
  options: [{ label: "Keep current envelope", description: "Preserve current wire format" }],
  multiSelect: false,
} as const;

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, compatQuestion], {
        scope: { selectedOptionValues: ["Orchestration-first"] },
        compat: { customAnswer: "Keep the current envelope for one release window" },
      }),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });
});
