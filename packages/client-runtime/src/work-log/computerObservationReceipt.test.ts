import { expect, it } from "vite-plus/test";
import {
  computerObservationReceipt,
  isNativeObservationTool,
} from "./computerObservationReceipt.ts";

const data = {
  schema: 1,
  status: "observation_mode_set",
  observation_mode: "disabled",
  observation_active: false,
  observation_generation: 3,
  session_id: "test-session",
  epoch: 1,
};
const content = [{ type: "text", text: JSON.stringify(data) }];

it.each([
  "desktop_status",
  "weasel_desktop.desktop_status",
  "weasel_desktop/desktop_status",
  "mcp__weasel_desktop__desktop_set_observation_mode",
])("recognizes the native policy tool %s", (toolName) => {
  expect(isNativeObservationTool(toolName)).toBe(true);
});

it.each([null, "functions.exec", "mcp__other__desktop_status", "desktop_status_extra"])(
  "ignores unrelated tools including same-name tools from another server: %s",
  (toolName) => {
    expect(computerObservationReceipt({ toolName, status: "completed", output: data })).toBeNull();
  },
);

it.each([
  data,
  JSON.stringify(data),
  content,
  { content, isError: false },
  { structuredContent: data, content, isError: false },
])("reads complete successful native provider representations %#", (output) => {
  expect(
    computerObservationReceipt({
      toolName: "mcp__weasel_desktop__desktop_set_observation_mode",
      status: "completed",
      output,
    }),
  ).toEqual({ kind: "confirmed", mode: "disabled", active: false });
});

it.each([false, true])("keeps enabled policy distinct from active reads: %s", (active) => {
  expect(
    computerObservationReceipt({
      toolName: "desktop_status",
      status: "completed",
      output: { ...data, observation_mode: "enabled", observation_active: active },
    }),
  ).toEqual({ kind: "confirmed", mode: "enabled", active });
});

it.each([
  { content, isError: true },
  { error: "failed", result: data },
  { ...data, status: "failed" },
  { ...data, schema: 2 },
  { ...data, observation_mode: "unknown" },
  { ...data, observation_active: "false" },
  { ...data, observation_active: true },
  { ...data, observation_generation: undefined },
  { ...data, observation_generation: -1 },
  { ...data, observation_generation: 0.5 },
  { ...data, observation_mode: undefined, include_image: false, observe_after: false },
  { input: data },
  { structuredContent: data, content: [{ type: "text", text: "truncated" }] },
  {
    structuredContent: data,
    content: [{ type: "text", text: JSON.stringify({ ...data, status: "failed" }) }],
  },
  {
    structuredContent: data,
    content: [{ type: "text", text: JSON.stringify({ ...data, observation_generation: 4 }) }],
  },
  [...content, ...content],
  `Status: ${JSON.stringify(data)}`,
  JSON.stringify({ ...data, extra: "x".repeat(16_384) }),
])("does not confirm malformed, failed, ambiguous or partial output %#", (output) => {
  expect(
    computerObservationReceipt({ toolName: "desktop_status", status: "completed", output }),
  ).toEqual({ kind: "unconfirmed", reason: "invalid" });
});

it.each(["failed", "cancelled", "interrupted", "running", "waiting"] as const)(
  "never reuses a successful-looking result on a %s call",
  (status) => {
    expect(
      computerObservationReceipt({ toolName: "desktop_status", status, output: data })?.kind,
    ).toBe("unconfirmed");
  },
);

it("requires complete output and the setter's success status", () => {
  expect(
    computerObservationReceipt({
      toolName: "desktop_status",
      status: "completed",
      output: data,
      outputOmitted: true,
    }),
  ).toEqual({ kind: "unconfirmed", reason: "unavailable" });
  expect(computerObservationReceipt({ toolName: "desktop_status", status: "completed" })).toEqual({
    kind: "unconfirmed",
    reason: "unavailable",
  });
  expect(
    computerObservationReceipt({
      toolName: "desktop_set_observation_mode",
      status: "completed",
      output: { ...data, status: "failed" },
    }),
  ).toEqual({ kind: "unconfirmed", reason: "invalid" });
});
