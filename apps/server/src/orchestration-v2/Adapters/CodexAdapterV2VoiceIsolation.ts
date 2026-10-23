import * as Schema from "effect/Schema";

const Configuration = Schema.Struct({ config: Schema.Record(Schema.String, Schema.Json) });
const decodeConfiguration = Schema.decodeUnknownSync(Configuration);
const ThreadIsolation = Schema.Struct({
  approvalPolicy: Schema.Literal("never"),
  sandbox: Schema.Struct({
    type: Schema.Literal("readOnly"),
    networkAccess: Schema.Literal(false),
  }),
  runtimeWorkspaceRoots: Schema.Array(Schema.Unknown),
  thread: Schema.Struct({ id: Schema.String, environments: Schema.Array(Schema.Unknown) }),
});
const decodeThreadIsolation = Schema.decodeUnknownSync(ThreadIsolation);
const Inventory = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      tools: Schema.Record(Schema.String, Schema.Unknown),
      resources: Schema.Array(Schema.Unknown),
      resourceTemplates: Schema.Array(Schema.Unknown),
      toolsError: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
const decodeInventory = Schema.decodeUnknownSync(Inventory);

export function codexVoiceIsolationConfig(response: unknown, research: boolean) {
  const { config } = decodeConfiguration(response);
  const servers = config.mcp_servers;
  if (
    servers !== undefined &&
    (servers === null || typeof servers !== "object" || Array.isArray(servers))
  )
    throw new Error("Effective MCP configuration is unavailable.");
  const names = Object.keys(servers ?? {});
  if (names.length > 256) throw new Error("Effective MCP inventory exceeds the isolation bound.");
  return {
    mcp_servers: Object.fromEntries(names.map((name) => [name, { enabled: false }])),
    features: {
      shell_tool: research,
      multi_agent: false,
      multi_agent_v2: false,
      plugins: false,
      apps: false,
      stable_environment_tools: false,
      image_generation: false,
      view_image: false,
      request_permissions_tool: false,
      deferred_executor: false,
      sleep_tool: false,
      current_time_reminder: false,
      token_budget: false,
      send_message_to_user_async: false,
      standalone_web_search: research,
      code_mode: false,
      code_mode_only: false,
    },
    tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
    web_search: research ? "live" : "disabled",
  } satisfies Record<string, Schema.Json>;
}

export function assertCodexVoiceThreadIsolation(response: unknown, noEnvironment: boolean) {
  const parsed = decodeThreadIsolation(response);
  if (noEnvironment && (parsed.thread.environments.length || parsed.runtimeWorkspaceRoots.length))
    throw new Error("The voice decision thread inherited an environment.");
  return parsed.thread.id;
}

export function assertCodexVoiceMcpIsolation(response: unknown) {
  const parsed = decodeInventory(response);
  if (
    parsed.nextCursor !== null ||
    parsed.data.some(
      (server) =>
        Object.keys(server.tools).length ||
        server.resources.length ||
        server.resourceTemplates.length ||
        server.toolsError != null,
    )
  )
    throw new Error("The voice thread retained MCP capabilities.");
}
