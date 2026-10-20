import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atomRegistry";

export const openYaziPicker = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Open attachment picker",
  tag: WS_METHODS.yaziPickerOpen,
});
const poll = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Read attachment picker",
  tag: WS_METHODS.yaziPickerPoll,
});
const write = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Type in attachment picker",
  tag: WS_METHODS.yaziPickerWrite,
});
const resize = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Resize attachment picker",
  tag: WS_METHODS.yaziPickerResize,
});
const read = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Read selected attachment",
  tag: WS_METHODS.yaziPickerRead,
});
const close = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Close attachment picker",
  tag: WS_METHODS.yaziPickerClose,
});

async function execute<W, A, E>(command: AtomCommand<W, A, E>, input: W) {
  const result = await runAtomCommand(appAtomRegistry, command, input, {
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export function yaziPickerApi(environmentId: EnvironmentId) {
  return {
    open: () => execute(openYaziPicker, { environmentId, input: { cols: 100, rows: 30 } }),
    poll: (sessionId: string) => execute(poll, { environmentId, input: { sessionId } }),
    write: (sessionId: string, data: string) =>
      execute(write, { environmentId, input: { sessionId, data } }),
    resize: (sessionId: string, cols: number, rows: number) =>
      execute(resize, { environmentId, input: { sessionId, cols, rows } }),
    read: (sessionId: string, fileId: string, offset: number) =>
      execute(read, { environmentId, input: { sessionId, fileId, offset } }),
    close: (sessionId: string) => execute(close, { environmentId, input: { sessionId } }),
  };
}
