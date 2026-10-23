import { expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ThreadLinkBackButton } from "./ThreadLinkBackButton";

it("does not offer thread back on a direct entry or unrelated navigation", async () => {
  await using screen = await render(<ThreadLinkBackButton />, { router: "/env/a" });
  await expect
    .element(screen.getByRole("button", { name: "Back to previous thread" }))
    .not.toBeInTheDocument();
  await act(() =>
    screen.router!.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env", threadId: "b" },
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: "Back to previous thread" }))
    .not.toBeInTheDocument();
});

it("unwinds linked threads by history identity after the visible title changes", async () => {
  await using screen = await render(<ThreadLinkBackButton />, { router: "/env/a" });
  await act(() =>
    screen.router!.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: "other-env", threadId: "b" },
      state: { threadLinkOrigin: true },
    }),
  );
  await screen.rerender(
    <>
      <span>Unclear Test Request</span>
      <ThreadLinkBackButton />
    </>,
  );
  await act(() =>
    screen.router!.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env", threadId: "c" },
      state: { threadLinkOrigin: true },
    }),
  );
  await screen.getByRole("button", { name: "Back to previous thread" }).click();
  await expect.poll(() => screen.router!.state.location.pathname).toBe("/other-env/b");
  await screen.getByRole("button", { name: "Back to previous thread" }).click();
  await expect.poll(() => screen.router!.state.location.pathname).toBe("/env/a");
  await expect
    .element(screen.getByRole("button", { name: "Back to previous thread" }))
    .not.toBeInTheDocument();
});
