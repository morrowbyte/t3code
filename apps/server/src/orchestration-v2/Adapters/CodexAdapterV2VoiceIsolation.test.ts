import { assert, it } from "@effect/vitest";
import {
  assertCodexVoiceMcpIsolation,
  assertCodexVoiceThreadIsolation,
  codexVoiceIsolationConfig,
} from "./CodexAdapterV2VoiceIsolation.ts";

it("overrides each inherited server while preserving a bounded read-only research path", () => {
  const effective = {
    config: {
      mcp_servers: {
        inherited: { enabled: true, command: "existing-command" },
        "t3-code": { enabled: true, url: "http://existing-host/mcp" },
      },
    },
  };
  const decision = codexVoiceIsolationConfig(effective, false);
  assert.deepEqual(decision.mcp_servers, {
    inherited: { enabled: false },
    "t3-code": { enabled: false },
  });
  assert.isFalse(decision.features.shell_tool);
  assert.isFalse(decision.features.plugins);
  assert.equal(decision.web_search, "disabled");
  const research = codexVoiceIsolationConfig(effective, true);
  assert.isTrue(research.features.shell_tool);
  assert.equal(research.web_search, "live");
  assert.isTrue(
    effective.config.mcp_servers.inherited.enabled,
    "the existing configuration is untouched",
  );
});

it("requires effective empty environment and MCP inventories rather than trusting requested flags", () => {
  const empty = {
    approvalPolicy: "never",
    sandbox: { type: "readOnly", networkAccess: false },
    thread: { id: "isolated", environments: [] },
    runtimeWorkspaceRoots: [],
  };
  assert.equal(assertCodexVoiceThreadIsolation(empty, true), "isolated");
  assert.throws(() =>
    assertCodexVoiceThreadIsolation(
      { ...empty, thread: { ...empty.thread, environments: [{ id: "inherited" }] } },
      true,
    ),
  );
  assert.throws(() =>
    assertCodexVoiceThreadIsolation({ ...empty, approvalPolicy: "on-request" }, true),
  );
  assert.doesNotThrow(() => assertCodexVoiceMcpIsolation({ data: [], nextCursor: null }));
  assert.throws(() =>
    assertCodexVoiceMcpIsolation({
      data: [{ tools: { mutate: {} }, resources: [], resourceTemplates: [] }],
      nextCursor: null,
    }),
  );
  assert.throws(() => assertCodexVoiceMcpIsolation({ data: [], nextCursor: "uninspected-page" }));
});
