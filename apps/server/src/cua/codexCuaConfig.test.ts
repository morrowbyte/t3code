import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
    "mcp_servers.t3-windows-cua": {
      enabled: false,
      command: "t3-windows-cua-disabled",
      args: [],
      env: {},
    },
  });
  expect(servers["mcp_servers.t3-windows-cua"]).toEqual({ command: "old-managed-driver" });
});

it("clears routing and environment when an attached session is revoked", () => {
  const active = codexCuaConfig(
    {},
    {
      generation: "revoked",
      driverVersion: "0.37.0",
      contractVersion: "fixture",
      mcpProtocolVersion: "fixture",
      mcp: {
        command: "previous-driver.exe",
        args: ["mcp", "--socket", "previous-generation"],
        environment: [{ name: "PREVIOUS_ATTACHMENT", value: "fixture" }],
      },
    },
  );
  const off = codexCuaConfig(active, undefined);
  expect(off["mcp_servers.t3-windows-cua"]).toEqual({
    enabled: false,
    command: "t3-windows-cua-disabled",
    args: [],
    env: {},
  });
  expect(codexCuaConfig(off, undefined)).toEqual(off);
});

const codexBinary = process.env.T3CODE_CODEX_CONFIG_TEST_BINARY;

it.skipIf(!codexBinary)(
  "parses fresh and revoked configurations with the actual Codex binary",
  () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cua-config-"));
    const env = { ...process.env, CODEX_HOME: home };
    try {
      const invalid = NodeChildProcess.spawnSync(
        codexBinary!,
        ["-c", "mcp_servers.t3-windows-cua={enabled=false}", "mcp", "list", "--json"],
        {
          cwd: home,
          env,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toContain("invalid transport");
      const overrides = Object.entries(codexCuaConfig({}, undefined)).flatMap(([key, value]) =>
        Object.entries(value as Record<string, unknown>).flatMap(([field, setting]) => [
          "-c",
          `${key}.${field}=${JSON.stringify(setting)}`,
        ]),
      );
      for (const saved of [false, true]) {
        if (saved) {
          NodeFS.writeFileSync(
            NodePath.join(home, "config.toml"),
            '[mcp_servers.t3-windows-cua]\nenabled = true\ncommand = "previous-driver.exe"\nargs = ["mcp", "--socket", "previous-generation"]\nenv = { PREVIOUS_ATTACHMENT = "fixture" }\n',
          );
        }
        const servers = JSON.parse(
          NodeChildProcess.execFileSync(codexBinary!, [...overrides, "mcp", "list", "--json"], {
            cwd: home,
            env,
            encoding: "utf8",
            timeout: 10_000,
          }),
        );
        expect(servers).toEqual([
          expect.objectContaining({
            name: "t3-windows-cua",
            enabled: false,
            transport: expect.objectContaining({
              command: "t3-windows-cua-disabled",
              args: [],
            }),
          }),
        ]);
      }
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  },
);

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
