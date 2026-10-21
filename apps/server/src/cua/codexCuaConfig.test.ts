import { expect, it } from "vite-plus/test";
import { codexCuaConfig } from "./codexCuaConfig.ts";

it("preserves T3 and user MCP servers while revoking its own saved configuration", () => {
  const servers = {
    "mcp_servers.t3-code": { url: "http://environment/mcp" },
    "mcp_servers.cua-driver": { command: "user-managed-driver" },
    "mcp_servers.t3-windows-cua": { command: "old-managed-driver" },
  };
  expect(codexCuaConfig(servers, undefined)).toEqual({
    ...servers,
    "mcp_servers.t3-windows-cua": { enabled: false },
  });
  expect(servers["mcp_servers.t3-windows-cua"]).toEqual({ command: "old-managed-driver" });
});

it("uses the host's exact private routing descriptor without changing approval policy", () => {
  expect(
    codexCuaConfig(
      {},
      {
        generation: "one",
        driverVersion: "0.37.0",
        contractVersion: "fixture",
        mcpProtocolVersion: "fixture",
        mcp: {
          command: "C:\\private\\cua-driver.exe",
          args: [
            "mcp",
            "--embedded",
            "--socket",
            "private-generation-one",
            "--host-bundle-id",
            "codes.t3.windows",
          ],
          environment: [],
        },
      },
    ),
  ).toEqual({
    "mcp_servers.t3-windows-cua": {
      enabled: true,
      command: "C:\\private\\cua-driver.exe",
      args: [
        "mcp",
        "--embedded",
        "--socket",
        "private-generation-one",
        "--host-bundle-id",
        "codes.t3.windows",
      ],
      env: {},
    },
  });
});
