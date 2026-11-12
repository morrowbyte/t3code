import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DesktopBrowserEvent,
  DesktopBrowserCommand,
  DesktopBrowserPrivateEntryRequest,
  DesktopBrowserPrivateEntryResponse,
  DesktopBrowserRegistrationDescriptor,
  DesktopBrowserRegistration,
  DesktopBrowserReady,
} from "./desktopBrowser.ts";

const decodeEvent = Schema.decodeUnknownSync(DesktopBrowserEvent);
const decodeCommand = Schema.decodeUnknownSync(DesktopBrowserCommand);
const decodeRequest = Schema.decodeUnknownSync(DesktopBrowserPrivateEntryRequest);
const decodeResponse = Schema.decodeUnknownSync(DesktopBrowserPrivateEntryResponse);
const target = {
  threadId: "thread-a",
  tabId: "tab-a",
  channelEpoch: "channel-a",
  attachmentId: "attachment-a",
  requestId: "request-a",
};
const lease = { ...target, leaseId: "lease-a", generation: 2 };
describe("desktop native private-entry boundary", () => {
  it("round-trips bound acquire, cancel, release and all result variants", () => {
    for (const request of [
      { type: "private-entry-acquire", ...target },
      { type: "private-entry-cancel", ...target },
      { type: "private-entry-release", ...lease },
    ])
      expect(decodeEvent(request)).toEqual(request);
    for (const response of [
      { type: "private-entry-granted", ...lease },
      { type: "private-entry-released", ...lease },
      { type: "private-entry-revoked", ...lease, reason: "closed" },
      { type: "private-entry-refused", ...target, reason: "agent-owned" },
    ])
      expect(decodeCommand(response)).toEqual(response);
  });
  it("does not turn legacy attach into ownership permission", () => {
    const legacy = decodeEvent({
      type: "attached",
      threadId: "thread-a",
      tabId: "tab-a",
    });
    expect("privateEntry" in legacy).toBe(false);
    expect(
      decodeEvent({
        type: "attached",
        threadId: "thread-a",
        tabId: "tab-a",
        privateEntry: { channelEpoch: "c", attachmentId: "a" },
      }),
    ).toMatchObject({ privateEntry: { channelEpoch: "c", attachmentId: "a" } });
  });
  it("rejects missing binding, invalid generations and secret or authority extensions", () => {
    for (const field of ["requestId", "channelEpoch", "attachmentId"] as const) {
      const { [field]: _missing, ...partial } = target;
      expect(() => decodeRequest({ type: "private-entry-acquire", ...partial })).toThrow();
    }
    for (const generation of [-1, 1.5, Infinity, NaN])
      expect(() =>
        decodeResponse({ type: "private-entry-granted", ...lease, generation }),
      ).toThrow();
    for (const field of ["username", "password", "token", "owner", "provider", "credentials"]) {
      expect(() =>
        decodeRequest({ type: "private-entry-acquire", ...target, [field]: "forbidden" }),
      ).toThrow();
      expect(() =>
        decodeResponse({ type: "private-entry-granted", ...lease, [field]: "forbidden" }),
      ).toThrow();
    }
  });
});

describe("OS-local desktop browser registration", () => {
  it("keeps the secret in the descriptor and registration, outside browser events and ready", () => {
    const binding = { environmentId: "target", processEpoch: "process", token: "secret" };
    const descriptor = { ...binding, endpoint: "/private/browser.sock", processId: 42 };
    expect(Schema.decodeSync(DesktopBrowserRegistrationDescriptor)(descriptor)).toEqual(descriptor);
    const registration = { type: "desktop-browser-register", ...binding };
    expect(Schema.decodeUnknownSync(DesktopBrowserRegistration)(registration)).toEqual(
      registration,
    );
    expect(() => decodeEvent(registration)).toThrow();
    expect(() => decodeCommand(registration)).toThrow();
    const ready = {
      type: "desktop-browser-ready",
      environmentId: "target",
      processEpoch: "process",
    };
    expect(Schema.decodeUnknownSync(DesktopBrowserReady)(ready)).toEqual(ready);
    expect(() =>
      Schema.decodeUnknownSync(DesktopBrowserReady)({ ...ready, token: "secret" }),
    ).toThrow();
    for (const processId of [0, -1, 1.5, Infinity]) {
      expect(() =>
        Schema.decodeSync(DesktopBrowserRegistrationDescriptor)({ ...descriptor, processId }),
      ).toThrow();
    }
    for (const field of ["environmentId", "processEpoch", "token"] as const) {
      const { [field]: _missing, ...incomplete } = registration;
      expect(() => Schema.decodeUnknownSync(DesktopBrowserRegistration)(incomplete)).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(DesktopBrowserRegistration)({ ...registration, [field]: "" }),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(DesktopBrowserRegistration)({
        ...registration,
        authority: "viewer",
      }),
    ).toThrow();
  });
});
