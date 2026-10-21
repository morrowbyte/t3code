import type * as Schema from "effect/Schema";
import type { CuaConnection } from "./CuaDriverHost.ts";

const MANAGED_SERVER = "t3-windows-cua";

/** Reapply on start AND resume so a saved thread cannot retain a revoked attachment. */
export const codexCuaConfig = (
  config: Readonly<Record<string, Schema.Json>>,
  connection: CuaConnection | undefined,
): Readonly<Record<string, Schema.Json>> => ({
  ...config,
  [`mcp_servers.${MANAGED_SERVER}`]: connection
    ? {
        enabled: true,
        command: connection.mcp.command,
        args: [...connection.mcp.args],
        env: Object.fromEntries(connection.mcp.environment.map(({ name, value }) => [name, value])),
      }
    : {
        // Codex validates the transport even when disabled. Replace saved routing
        // as well as revoking it, so resume cannot retain a previous attachment.
        enabled: false,
        command: "t3-windows-cua-disabled",
        args: [],
        env: {},
      },
});
