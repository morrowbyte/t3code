import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  approvalSocketUrl,
  createApprovalCookie,
  selectLocalApprovalRoute,
  selectSavedApprovalRoute,
} from "./DesktopPrivilegedDecision.ts";

const base = new URL("http://127.0.0.1:3773/");
const bearer = "private-bearer";

afterEach(() => vi.unstubAllGlobals());

describe("desktop privileged approval bootstrap", () => {
  it("binds the environment before exchanging a fresh one-time credential for a cookie", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ environmentId: "local-id" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ credential: "one-time-grant" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 200,
          headers: {
            "set-cookie": "t3_session_3773=private-cookie; HttpOnly; SameSite=Lax; Path=/",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(await createApprovalCookie(base, bearer, "local-id")).toBe(
      "t3_session_3773=private-cookie",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, options] = fetchMock.mock.calls[2]!;
    expect(String(url)).toBe("http://127.0.0.1:3773/api/auth/browser-session");
    expect(options.redirect).toBe("error");
    expect(JSON.parse(options.body)).toEqual({
      credential: "one-time-grant",
    });
  });

  it("never exchanges a credential for a different target environment", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ environmentId: "other" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createApprovalCookie(base, bearer, "local-id")).rejects.toThrow(
      "Target environment mismatch.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects responses without the backend session cookie", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ environmentId: "local-id" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ credential: "one-time-grant" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response("{}", { status: 200, headers: { "set-cookie": "unrelated=x; Path=/" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createApprovalCookie(base, bearer, "local-id")).rejects.toThrow(
      "Browser session cookie missing.",
    );
  });
});

describe("local approval routes", () => {
  it("selects the matching WSL environment and its existing session", () => {
    const routes = [
      { environmentId: "windows", backendId: "primary", httpBaseUrl: "http://127.0.0.1:3773/" },
      { environmentId: "wsl", backendId: "wsl:Ubuntu", httpBaseUrl: "http://127.0.0.1:3774/" },
    ];
    const credentials = [
      {
        connectionId: "local:wsl:Ubuntu",
        credential: { _tag: "BearerConnectionCredential" as const, token: "wsl-session" },
      },
    ];
    expect(selectLocalApprovalRoute(routes, credentials, "wsl")).toEqual({
      httpBaseUrl: "http://127.0.0.1:3774/",
      token: "wsl-session",
    });
    expect(selectLocalApprovalRoute(routes, credentials, "other")).toBeNull();
    expect(selectLocalApprovalRoute(routes, [], "wsl")).toBeNull();
  });
});

describe("saved approval routes", () => {
  const baseCatalog = {
    schemaVersion: 1,
    disabledEnvironmentIds: [],
    remoteDpopTokens: [],
    targets: [
      {
        _tag: "BearerConnectionTarget",
        environmentId: "win",
        label: "Windows",
        connectionId: "saved",
      },
    ],
    profiles: [
      {
        _tag: "BearerConnectionProfile",
        environmentId: "win",
        label: "Windows",
        connectionId: "saved",
        httpBaseUrl: "https://win.example/",
        wsBaseUrl: "wss://win.example/",
      },
    ],
    credentials: [
      {
        connectionId: "saved",
        credential: { _tag: "BearerConnectionCredential", token: "private" },
      },
    ],
  } as unknown as import("@t3tools/client-runtime/platform").ConnectionCatalogDocument;
  it("selects only the saved matching environment and credential", () => {
    expect(selectSavedApprovalRoute(baseCatalog, "win")).toEqual({
      kind: "bearer",
      httpBaseUrl: "https://win.example/",
      wsBaseUrl: "wss://win.example/",
      token: "private",
    });
    expect(selectSavedApprovalRoute(baseCatalog, "other")).toBeNull();
    expect(selectSavedApprovalRoute({ ...baseCatalog, profiles: [] }, "win")).toMatchObject({
      kind: "unsupported",
    });
  });
  it("selects a saved SSH session and a learned route using its shared credential", () => {
    const id = baseCatalog.targets[0]!.environmentId;
    const ssh = {
      ...baseCatalog,
      targets: [
        {
          _tag: "SshConnectionTarget",
          environmentId: id,
          label: "SSH",
          connectionId: "saved",
        } as const,
      ],
      profiles: [
        {
          _tag: "SshConnectionProfile",
          environmentId: id,
          label: "SSH",
          connectionId: "saved",
          target: { alias: "win", hostname: "win", username: null, port: null },
        } as const,
      ],
    };
    expect(selectSavedApprovalRoute(ssh, "win")).toMatchObject({
      kind: "ssh",
      token: "private",
      target: { alias: "win" },
    });
    const connectionId = "learned:win:https://win.example@saved";
    const learned = {
      ...baseCatalog,
      targets: [{ ...baseCatalog.targets[0]!, connectionId }],
      profiles: [{ ...baseCatalog.profiles[0]!, connectionId }],
    } as typeof baseCatalog;
    expect(selectSavedApprovalRoute(learned, "win")).toMatchObject({
      kind: "bearer",
      token: "private",
    });
  });
  it("rejects disabled environments and reports unsupported DPoP routes", () => {
    const disabled = {
      ...baseCatalog,
      disabledEnvironmentIds: [baseCatalog.targets[0]!.environmentId],
    };
    expect(selectSavedApprovalRoute(disabled, "win")).toMatchObject({
      kind: "unsupported",
      message: expect.stringContaining("disabled"),
    });
    const relay = {
      ...baseCatalog,
      targets: [
        {
          _tag: "RelayConnectionTarget",
          environmentId: baseCatalog.targets[0]!.environmentId,
          label: "Win",
        } as const,
      ],
    };
    expect(selectSavedApprovalRoute(relay, "win")).toMatchObject({
      kind: "unsupported",
      message: expect.stringContaining("DPoP"),
    });
  });
  it("refuses to send the cookie to a different websocket host or a downgraded route", () => {
    expect(approvalSocketUrl("https://win.example/", "wss://win.example/").href).toContain(
      "wss://win.example/ws?",
    );
    expect(() => approvalSocketUrl("https://win.example/", "wss://other.example/")).toThrow();
    expect(() => approvalSocketUrl("https://win.example/", "ws://win.example/")).toThrow();
  });
});
