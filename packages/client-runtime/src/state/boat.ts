import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createBoatEnvironment<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    defaults: createEnvironmentRpcCommand(runtime, {
      label: "boat:defaults",
      tag: WS_METHODS.boatDefaults,
    }),
    read: createEnvironmentRpcCommand(runtime, { label: "boat:read", tag: WS_METHODS.boatRead }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "boat:connect",
      tag: WS_METHODS.boatConnect,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "boat:disconnect",
      tag: WS_METHODS.boatDisconnect,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "boat:configure",
      tag: WS_METHODS.boatConfigure,
    }),
    setup: createEnvironmentRpcCommand(runtime, {
      label: "boat:setup",
      tag: WS_METHODS.boatSetup,
    }),
    operate: createEnvironmentRpcCommand(runtime, {
      label: "boat:operate",
      tag: WS_METHODS.boatOperate,
    }),
  };
}
