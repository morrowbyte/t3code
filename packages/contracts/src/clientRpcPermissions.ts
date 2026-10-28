import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.connectedEnvironmentSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.connectedEnvironmentRespond]: AuthOrchestrationReadScope,
  [WS_METHODS.connectedEnvironmentRead]: AuthOrchestrationReadScope,
  [WS_METHODS.connectedEnvironmentPrepare]: AuthOrchestrationOperateScope,
  [WS_METHODS.connectedEnvironmentSend]: AuthOrchestrationOperateScope,
  [WS_METHODS.approvalReviewOrderCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.approvalReviewOrderRead]: AuthOrchestrationReadScope,
  [WS_METHODS.approvalReviewOrderCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.approvalReviewOrderReadiness]: AuthOrchestrationReadScope,
  [WS_METHODS.agentAvatarGenerate]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentAvatarCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.windowsCuaSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.yaziPickerOpen]: AuthTerminalOperateScope,
  [WS_METHODS.yaziPickerPoll]: AuthTerminalOperateScope,
  [WS_METHODS.yaziPickerWrite]: AuthTerminalOperateScope,
  [WS_METHODS.yaziPickerResize]: AuthTerminalOperateScope,
  [WS_METHODS.yaziPickerRead]: AuthTerminalOperateScope,
  [WS_METHODS.yaziPickerClose]: AuthTerminalOperateScope,

  [WS_METHODS.nativeAuthorRead]: AuthOrchestrationReadScope,
  [WS_METHODS.nativeAuthorWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDeleteUpdateHistory]: AuthEnvironmentMaintainScope,
  [WS_METHODS.projectsFeatureTiming]: AuthOrchestrationReadScope,
  [WS_METHODS.agentObservatorySubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.agentObservatoryReadNativeRoster]: AuthOrchestrationReadScope,
  [WS_METHODS.agentObservatorySubscribeNativeRoster]: AuthOrchestrationReadScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [WS_METHODS.liveVoicePrepare]: AuthOrchestrationOperateScope,
  [WS_METHODS.liveVoiceStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.liveVoiceStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.liveVoiceContext]: AuthOrchestrationOperateScope,
  [WS_METHODS.liveVoiceStatus]: AuthOrchestrationOperateScope,
  [WS_METHODS.liveVoiceSubscribe]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
