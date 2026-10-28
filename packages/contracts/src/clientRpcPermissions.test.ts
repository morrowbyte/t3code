import { describe, expect, it } from "vite-plus/test";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
} from "./auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

it("guards selected Live voice context with operation authority on its destination", () => {
  expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.liveVoiceContext]).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(
    clientRpcRequiredScopes(WS_METHODS.liveVoiceContext, {
      leaseId: "lease",
      generation: 1,
      revision: 1,
      context: null,
    }),
  ).toEqual([AuthOrchestrationOperateScope]);
});

it("separates avatar reads from subscription-consuming generation on the destination", () => {
  for (const method of [WS_METHODS.agentAvatarGenerate, WS_METHODS.agentAvatarCancel]) {
    expect(clientRpcRequiredScopes(method, { threadId: "agent", theme: "weasel" })).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  }
});

it("requires read access for Windows CUA state on the destination environment", () => {
  expect(clientRpcRequiredScopes(WS_METHODS.windowsCuaSubscribe, {})).toEqual([
    AuthOrchestrationReadScope,
  ]);
});

it("uses existing read and operate scopes for native author reconciliation and mutations", () => {
  expect(clientRpcRequiredScopes(WS_METHODS.nativeAuthorRead, {})).toEqual([
    AuthOrchestrationReadScope,
  ]);
  expect(clientRpcRequiredScopes(WS_METHODS.nativeAuthorWrite, {})).toEqual([
    AuthOrchestrationOperateScope,
  ]);
});

describe("observatory read destination permissions", () => {
  it("uses the exact read grant for all selected destinations without introducing publish authority", () => {
    for (const method of [
      WS_METHODS.agentObservatorySubscribe,
      WS_METHODS.agentObservatoryReadNativeRoster,
      WS_METHODS.agentObservatorySubscribeNativeRoster,
    ]) {
      expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe(AuthOrchestrationReadScope);
      for (const threadId of ["thread:a", "thread:b"])
        expect(
          clientRpcRequiredScopes(method, { threadId, threadIds: [threadId], limit: 1 }),
        ).toEqual([AuthOrchestrationReadScope]);
    }
    expect(
      Object.values(WS_METHODS).some(
        (method) => method.startsWith("agentObservatory.") && /publish|update|write/.test(method),
      ),
    ).toBe(false);
  });
});

describe("baseline guarded RPC compatibility", () => {
  it("retains the existing settings-write gate independently of observatory read access", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.serverRunStorageCleanup, {})).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.serverRunStorageCleanup]).toBe(
      AuthSettingsWriteScope,
    );
  });
});

describe("update history permissions", () => {
  it("requires host maintenance authority for deleting a receipt", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.serverDeleteUpdateHistory, {
        component: "desktop",
        id: "receipt",
      }),
    ).toEqual([AuthEnvironmentMaintainScope]);
  });
});

it("requires read permission for timing on the selected project destination", () => {
  expect(
    clientRpcRequiredScopes(WS_METHODS.projectsFeatureTiming, { projectId: "project:timing" }),
  ).toEqual([AuthOrchestrationReadScope]);
});

it("guards the Yazi chooser, including file reads, with terminal operation authority", () => {
  for (const method of [
    WS_METHODS.yaziPickerOpen,
    WS_METHODS.yaziPickerPoll,
    WS_METHODS.yaziPickerWrite,
    WS_METHODS.yaziPickerResize,
    WS_METHODS.yaziPickerRead,
    WS_METHODS.yaziPickerClose,
  ]) {
    expect(clientRpcRequiredScopes(method, {})).toEqual([AuthTerminalOperateScope]);
  }
});

it("guards host-order UI aliases without granting VM request sessions human control", () => {
  expect(clientRpcRequiredScopes(WS_METHODS.approvalReviewOrderCreate, {})).toEqual([
    AuthOrchestrationOperateScope,
  ]);
  expect(clientRpcRequiredScopes(WS_METHODS.approvalReviewOrderCancel, {})).toEqual([
    AuthOrchestrationOperateScope,
  ]);
  expect(clientRpcRequiredScopes(WS_METHODS.approvalReviewOrderRead, {})).toEqual([
    AuthOrchestrationReadScope,
  ]);
  expect(clientRpcRequiredScopes(WS_METHODS.approvalReviewOrderReadiness, {})).toEqual([
    AuthOrchestrationReadScope,
  ]);
});
