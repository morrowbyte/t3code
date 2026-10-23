import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { FormEvent } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { HostOrderChatMode } from "./HostOrderChatMode";

vi.mock("./HostOrderComposer", () => ({
  HostOrderComposer: () => (
    <form aria-label="Host task" onSubmit={(event) => event.preventDefault()}>
      <textarea aria-label="Original task" />
      <button type="submit">Send host task</button>
    </form>
  ),
}));

it("opens host task delivery before any approval and preserves both drafts across modes", async () => {
  const submitAgent = vi.fn((event: FormEvent) => event.preventDefault());
  await using screen = await render(
    <HostOrderChatMode
      hosts={[{ environmentId: EnvironmentId.make("host"), label: "Protecting host" }]}
      destination={{
        environmentId: EnvironmentId.make("vm"),
        threadId: ThreadId.make("vm-thread"),
      }}
    >
      <form onSubmit={submitAgent}>
        <textarea aria-label="Agent draft" defaultValue="Keep agent draft" />
        <button type="submit">Send agent message</button>
      </form>
    </HostOrderChatMode>,
  );
  await screen.getByRole("button", { name: "Host-bound task", exact: true }).click();
  await screen.getByRole("combobox", { name: "Protecting host" }).click();
  await screen.getByRole("option", { name: "Protecting host" }).click();
  await userEvent.type(screen.getByRole("textbox", { name: "Original task" }), "Exact original 🚀");
  await screen.getByRole("button", { name: "Send host task" }).click();
  expect(submitAgent).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Agent chat" })).toHaveFocus();
  await expect
    .element(screen.getByRole("textbox", { name: "Agent draft" }))
    .toHaveValue("Keep agent draft");
  await screen.getByRole("button", { name: "Host-bound task", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Original task" }))
    .toHaveValue("Exact original 🚀");
});

it("requires a persisted source thread before host delivery", async () => {
  await using screen = await render(
    <HostOrderChatMode hosts={[]} destination={null}>
      <p>Draft chat</p>
    </HostOrderChatMode>,
  );
  await expect.element(screen.getByRole("button", { name: "Host-bound task" })).toBeDisabled();
});
