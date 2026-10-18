// @effect-diagnostics nodeBuiltinImport:off -- Exercise the private app-control boundary through owned temporary sockets/pipes.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import {
  DesktopResultConversationResponse,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopResultConversationRequest,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { startDesktopAppControlServer } from "./DesktopAppControlServer.ts";

const decodeResponse = Schema.decodeUnknownSync(DesktopResultConversationResponse);

const request: DesktopResultConversationRequest = {
  version: 1,
  requestId: "open-result-1",
  type: "open-result-conversation",
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("child-1"),
  origin: {
    environmentId: "environment-1",
    projectId: "project-1",
    parentThreadId: "parent-1",
    parentRunId: "parent-run-1",
    parentRootNodeId: "parent-root-1",
    taskId: "task-1",
    childThreadId: "child-1",
    childRunId: "child-run-1",
    childRootNodeId: "child-root-1",
  },
};

function exchange(address: string, payload: unknown) {
  return new Promise<DesktopResultConversationResponse>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      try {
        resolve(decodeResponse(JSON.parse(buffer.slice(0, newline))));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("end", () => {
      if (!buffer.includes("\n")) reject(new Error("App control closed without a response."));
    });
  });
}

const withServer = Effect.fn(function* (
  openResultConversation: Parameters<
    typeof startDesktopAppControlServer
  >[0]["openResultConversation"],
  run: (address: string) => Promise<void>,
) {
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  return yield* Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-result-"));
    const activated: string[] = [];
    const canceled: string[] = [];
    const reclaimErrors: unknown[] = [];
    const target = resolveDesktopAppControlAddress({
      stateDir: NodePath.join(root, "userdata"),
      platform,
      tempDir: root,
      userId,
      joinPath: NodePath.join,
    });
    try {
      const server = await startDesktopAppControlServer({
        ...target,
        userId,
        handle: async (input) => {
          activated.push(input.requestId);
          return {
            version: 1,
            requestId: input.requestId,
            ok: true,
            projectId: ProjectId.make("unexpected-project"),
            threadId: ThreadId.make("unexpected-thread"),
          };
        },
        cancel: (requestId) => {
          canceled.push(requestId);
        },
        onReclaimError: (error) => {
          reclaimErrors.push(error);
        },
        ...(openResultConversation === undefined ? {} : { openResultConversation }),
      });
      try {
        await run(target.address);
      } finally {
        await server.close();
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
    return { activated, canceled, reclaimErrors };
  });
});

describe("result conversation app control", () => {
  it.effect(
    "opens the canonical existing conversation without activation broker dispatch or cancellation",
    () =>
      Effect.gen(function* () {
        const opened: DesktopResultConversationRequest[] = [];
        const traffic = yield* withServer(
          async (input, alive) => {
            expect(alive()).toBe(true);
            opened.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              environmentId: input.environmentId,
              threadId: input.threadId,
              windowId: 42,
            };
          },
          async (address) => {
            expect(await exchange(address, request)).toEqual({
              version: 1,
              requestId: request.requestId,
              ok: true,
              environmentId: request.environmentId,
              threadId: request.threadId,
              windowId: 42,
            });
          },
        );
        expect(opened).toEqual([request]);
        expect(traffic).toEqual({ activated: [], canceled: [], reclaimErrors: [] });
      }),
  );

  it.effect(
    "rejects route/origin mismatches, incomplete origins and arbitrary URL or authority fields",
    () =>
      Effect.gen(function* () {
        const opened: DesktopResultConversationRequest[] = [];
        const traffic = yield* withServer(
          async (input) => {
            opened.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: false,
              code: "result-window-unavailable",
              message: "Must not be called.",
            };
          },
          async (address) => {
            for (const invalid of [
              { ...request, environmentId: "other-environment" },
              { ...request, threadId: "other-child" },
              { ...request, origin: { ...request.origin, childRunId: undefined } },
              { ...request, origin: { ...request.origin, taskId: "   " } },
              { ...request, url: "https://untrusted.example/result" },
              { ...request, credential: "untrusted-token" },
              { ...request, origin: { ...request.origin, url: "https://untrusted.example/" } },
            ]) {
              expect(await exchange(address, invalid)).toMatchObject({
                version: 1,
                requestId: request.requestId,
                ok: false,
                code: "invalid-request",
              });
            }
          },
        );
        expect(opened).toEqual([]);
        expect(traffic).toEqual({ activated: [], canceled: [], reclaimErrors: [] });
      }),
  );

  it.effect(
    "returns a typed unavailable result when this desktop has no result-window handler",
    () =>
      Effect.gen(function* () {
        const traffic = yield* withServer(undefined, async (address) => {
          expect(await exchange(address, request)).toEqual({
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "result-window-unavailable",
            message: "T3 Code could not open the result conversation.",
          });
        });
        expect(traffic).toEqual({ activated: [], canceled: [], reclaimErrors: [] });
      }),
  );

  it.effect(
    "returns a bounded typed failure when opening rejects, without routing through activation",
    () =>
      Effect.gen(function* () {
        const traffic = yield* withServer(
          async () => {
            throw new Error("private internal failure details");
          },
          async (address) => {
            expect(await exchange(address, request)).toEqual({
              version: 1,
              requestId: request.requestId,
              ok: false,
              code: "result-window-unavailable",
              message: "T3 Code could not open the result conversation.",
            });
          },
        );
        expect(traffic).toEqual({ activated: [], canceled: [], reclaimErrors: [] });
      }),
  );
});
