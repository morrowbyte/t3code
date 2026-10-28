import { createLiveVoiceEnvironmentAtoms } from "@t3tools/client-runtime/state/live-voice";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const liveVoiceEnvironment = {
  ...createLiveVoiceEnvironmentAtoms(connectionAtomRuntime),
  context: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:live-voice:context",
    tag: WS_METHODS.liveVoiceContext,
  }),
};
