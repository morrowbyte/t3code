import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { PairingRouteSurface } from "./PairingRouteSurface";

const harness = vi.hoisted(() => ({
  submit: vi.fn<(credential: string) => Promise<void>>(),
  strip: vi.fn(),
}));

vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: () => null,
  stripPairingTokenFromUrl: harness.strip,
  submitServerAuthCredential: harness.submit,
}));

it("pairs new links while the pairing page stays mounted, including after a rejected token", async () => {
  harness.submit
    .mockReset()
    .mockRejectedValueOnce(new Error("Invalid pairing token."))
    .mockResolvedValue();
  harness.strip.mockReset();
  const onAuthenticated = vi.fn();
  await using screen = await render(
    <PairingRouteSurface
      auth={{
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      }}
      onAuthenticated={onAuthenticated}
    />,
    { router: "/pair" },
  );
  await expect.element(screen.getByRole("textbox", { name: "Pairing token" })).toHaveValue("");
  await act(() => screen.router!.navigate({ to: "/pair", hash: "token=rejected-pairing-token" }));
  await expect.element(screen.getByText("Invalid pairing token.")).toBeVisible();
  await act(() => screen.router!.navigate({ to: "/pair", hash: "token=late-pairing-token" }));
  await vi.waitFor(() => expect(harness.submit).toHaveBeenLastCalledWith("late-pairing-token"));
  expect(harness.submit).toHaveBeenCalledTimes(2);
  expect(harness.strip).toHaveBeenCalledTimes(2);
  expect(onAuthenticated).toHaveBeenCalledOnce();
});
