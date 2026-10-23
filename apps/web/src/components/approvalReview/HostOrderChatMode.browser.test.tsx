import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { FormEvent } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useHostOrderComposerStore } from "./HostOrderComposerStore";
import { ConfiguredHostOrderChatMode, HostOrderChatMode } from "./HostOrderChatMode";

const preferences = vi.hoisted(() => ({ hydrated: vi.fn(), enabled: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => preferences.hydrated(),
  useClientSettings: (select: (settings: { hostOrderEntryEnabled: boolean }) => unknown) =>
    select({ hostOrderEntryEnabled: preferences.enabled() }),
}));

vi.mock("./HostOrderComposer", () => ({
  HostOrderComposer: ({ active }: { active: boolean }) => (
    <form aria-label="Host task" onSubmit={(event) => event.preventDefault()}>
      <textarea aria-label="Original task" disabled={!active} />
      <button type="submit" disabled={!active}>
        Send host task
      </button>
    </form>
  ),
}));

const hosts = [
  { environmentId: EnvironmentId.make("host"), label: "Protecting host", connected: true },
];
const destination = {
  environmentId: EnvironmentId.make("vm"),
  threadId: ThreadId.make("vm-thread"),
};

it("defaults to normal chat even with a connected remote environment and saved thread", async () => {
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  await using screen = await render(
    <HostOrderChatMode hosts={hosts} destination={destination}>
      <textarea aria-label="Agent draft" defaultValue="Normal chat" />
    </HostOrderChatMode>,
  );
  await expect.element(screen.getByRole("textbox", { name: "Agent draft" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Protected task", exact: true }).elements(),
  ).toHaveLength(0);
  expect(screen.getByRole("region", { name: "Protected task" }).elements()).toHaveLength(0);
  expect(screen.container.textContent).not.toContain("Agent chat");
});

it("opens a separate protected task and preserves the normal composer and both drafts", async () => {
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  const submitAgent = vi.fn((event: FormEvent) => event.preventDefault());
  await using screen = await render(
    <HostOrderChatMode
      enabled
      hosts={hosts}
      destination={destination}
      destinationLabel="Work VM · Task conversation"
    >
      <form onSubmit={submitAgent}>
        <textarea aria-label="Agent draft" defaultValue="Keep agent draft" />
        <button type="submit">Send agent message</button>
      </form>
    </HostOrderChatMode>,
  );
  await screen.getByRole("button", { name: "Protected task", exact: true }).click();
  await expect.element(screen.getByText("Execution: Work VM · Task conversation")).toBeVisible();
  await screen.getByRole("combobox", { name: "Protecting host" }).click();
  await page.getByRole("option", { name: "Protecting host" }).click();
  await userEvent.fill(screen.getByRole("textbox", { name: "Original task" }), "Exact original 🚀");
  await expect.element(screen.getByRole("textbox", { name: "Agent draft" })).toBeVisible();
  await screen.getByRole("button", { name: "Send host task" }).click();
  expect(submitAgent).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(screen.getByRole("button", { name: "Protected task", exact: true }))
    .toHaveFocus();
  await expect
    .element(screen.getByRole("textbox", { name: "Agent draft" }))
    .toHaveValue("Keep agent draft");
  await screen.getByRole("button", { name: "Protected task", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Original task" }))
    .toHaveValue("Exact original 🚀");
});

it("closes on opt-out and retains saved drafts without reopening or sending on opt-in", async () => {
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  const content = (enabled: boolean) => (
    <HostOrderChatMode enabled={enabled} hosts={hosts} destination={destination}>
      <textarea aria-label="Agent draft" defaultValue="Unsent chat" />
    </HostOrderChatMode>
  );
  await using screen = await render(content(true));
  await screen.getByRole("button", { name: "Protected task", exact: true }).click();
  await screen.getByRole("combobox", { name: "Protecting host" }).click();
  await page.getByRole("option", { name: "Protecting host" }).click();
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Original task" }),
    "Unsent protected task",
  );
  await screen.rerender(content(false));
  await expect
    .element(screen.getByRole("textbox", { name: "Agent draft" }))
    .toHaveValue("Unsent chat");
  expect(screen.container.querySelector('textarea[aria-label="Original task"]')).toHaveProperty(
    "disabled",
    true,
  );
  expect(
    screen.getByRole("button", { name: "Protected task", exact: true }).elements(),
  ).toHaveLength(0);
  await screen.rerender(content(true));
  await expect
    .element(screen.getByRole("button", { name: "Protected task", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await screen.getByRole("button", { name: "Protected task", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Original task" }))
    .toHaveValue("Unsent protected task");
});

it("shows missing setup without an empty protecting-host select", async () => {
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  await using screen = await render(
    <HostOrderChatMode enabled hosts={[]} destination={destination}>
      <p>Normal chat</p>
    </HostOrderChatMode>,
  );
  await screen.getByRole("button", { name: "Protected task", exact: true }).click();
  await expect
    .element(screen.getByText("No protecting host is connected. Configure one in Settings."))
    .toBeVisible();
  expect(screen.getByRole("combobox").elements()).toHaveLength(0);
  await expect
    .element(screen.getByRole("link", { name: "Setup" }))
    .toHaveAttribute("href", "/settings/integrations#protected-tasks");
});

it("keeps offline selection distinct from missing setup", async () => {
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  await using screen = await render(
    <HostOrderChatMode
      enabled
      hosts={[{ ...hosts[0]!, connected: false }]}
      destination={destination}
    >
      <p>Normal chat</p>
    </HostOrderChatMode>,
  );
  await screen.getByRole("button", { name: "Protected task", exact: true }).click();
  await screen.getByRole("combobox", { name: "Protecting host" }).click();
  await page.getByRole("option", { name: "Protecting host · offline" }).click();
  await expect.element(screen.getByRole("button", { name: "Send host task" })).toBeDisabled();
});

it("explains a missing persisted conversation without replacing normal chat", async () => {
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  await using screen = await render(
    <HostOrderChatMode enabled hosts={[]} destination={null}>
      <textarea aria-label="Agent draft" />
    </HostOrderChatMode>,
  );
  await screen.getByRole("button", { name: "Protected task", exact: true }).click();
  await expect
    .element(screen.getByText("Start a conversation before choosing its protecting host."))
    .toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Agent draft" })).toBeVisible();
});

it("waits for settings hydration and never opens a panel just because saved opt-in loads", async () => {
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  preferences.hydrated.mockReset().mockReturnValue(false);
  preferences.enabled.mockReset().mockReturnValue(true);
  const content = () => (
    <ConfiguredHostOrderChatMode hosts={hosts} destination={destination}>
      <textarea aria-label="Agent draft" defaultValue="Saved chat draft" />
    </ConfiguredHostOrderChatMode>
  );
  await using screen = await render(content());
  expect(
    screen.getByRole("button", { name: "Protected task", exact: true }).elements(),
  ).toHaveLength(0);
  preferences.hydrated.mockReturnValue(true);
  await screen.rerender(content());
  await expect
    .element(screen.getByRole("button", { name: "Protected task", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await expect
    .element(screen.getByRole("textbox", { name: "Agent draft" }))
    .toHaveValue("Saved chat draft");
  preferences.enabled.mockReturnValue(false);
  await screen.rerender(content());
  expect(
    screen.getByRole("button", { name: "Protected task", exact: true }).elements(),
  ).toHaveLength(0);
});

it.each(["empty-hosts", "no-destination"] as const)(
  "closes %s setup with local Escape after keyboard opening",
  async (state) => {
    useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
    await using screen = await render(
      <HostOrderChatMode
        enabled
        hosts={[]}
        destination={state === "no-destination" ? null : destination}
      >
        <textarea aria-label="Agent draft" defaultValue="Keep normal draft" />
      </HostOrderChatMode>,
    );
    await screen.getByRole("button", { name: "Protected task", exact: true }).element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("region", { name: "Protected task" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("button", { name: "Protected task", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByRole("button", { name: "Protected task", exact: true }))
      .toHaveFocus();
    await expect
      .element(screen.getByRole("textbox", { name: "Agent draft" }))
      .toHaveValue("Keep normal draft");
  },
);
