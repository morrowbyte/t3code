import { expect, it } from "@effect/vitest";
import {
  ApprovalReviewError,
  EnvironmentId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PrivilegedCommandService from "../../../orchestration-v2/PrivilegedCommandService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { PrivilegedCommandToolkit } from "./tools.ts";

it.effect.each([
  {
    shell: "sh" as const,
    cwd: "/var/tmp",
    script: [
      "set -eu",
      "",
      "PATH='/usr/sbin:/usr/bin:/sbin:/bin'",
      "export PATH",
      "report_dir='/var/tmp/T3 diagnostics'",
      "",
      'mkdir -p "$report_dir"',
      'ss -ltn > "$report_dir/listeners.txt"',
      "printf '%s\\n' 'Prüfung abgeschlossen'",
      "",
    ].join("\n"),
  },
  {
    shell: "powershell" as const,
    cwd: "C:\\ProgramData",
    script: [
      "$ErrorActionPreference = 'Stop'",
      "",
      "$reportDirectory = 'C:\\ProgramData\\T3 diagnostics'",
      "New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null",
      "",
      "Get-Service -Name 'sshd' |",
      "    Out-File -LiteralPath (Join-Path $reportDirectory 'services.txt')",
      'Write-Output "Prüfung: $reportDirectory"',
      "",
    ].join("\r\n"),
  },
])(
  "preserves the $shell proposal bytes through the tool contract while binding caller identity",
  ({ shell, cwd, script }) =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const identity = {
        environmentId: EnvironmentId.make("caller-host"),
        threadId: ThreadId.make("caller-thread"),
        providerSessionId: "caller-session",
      };
      const input = {
        purpose: "Inspect temporary artifacts",
        script,
        shell,
        cwd,
        timeoutMs: 1000,
      };
      const requestId = RuntimeRequestId.make("privileged-command:test");
      const dependencies = Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: identity.environmentId,
          thread: {
            threadId: identity.threadId,
            providerSessionId: identity.providerSessionId,
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"] as const),
          requestNamespace: "caller-session",
          issuedAt: 0,
        }),
        Layer.mock(PrivilegedCommandService.PrivilegedCommandService)({
          request: (value) => {
            calls.push(value);
            return Effect.fail(new ApprovalReviewError({ reason: "disabled" }));
          },
          wait: (value) => {
            calls.push(value);
            return Effect.fail(new ApprovalReviewError({ reason: "disabled" }));
          },
        }),
      );
      const toolkit = yield* PrivilegedCommandToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const spoofed = {
        ...input,
        environmentId: "other-host",
        threadId: "other-thread",
        providerSessionId: "other-session",
      };
      yield* toolkit
        .handle("privileged_command_request", spoofed)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      yield* toolkit
        .handle("privileged_command_wait", { requestId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(calls).toEqual([
        { ...input, ...identity },
        { requestId, ...identity },
      ]);
      expect(Object.keys(PrivilegedCommandToolkit.tools)).toEqual([
        "privileged_command_request",
        "privileged_command_wait",
      ]);
    }),
);

it("describes readable scripts as proposal guidance without adding a style approval", () => {
  const description = PrivilegedCommandToolkit.tools.privileged_command_request.description;
  expect(description).toContain("Check the task and host context before proposing");
  expect(description).toContain("POSIX shell or PowerShell");
  expect(description).toContain("reuse repeated paths and values");
  expect(description).toContain("Keep one-off literals inline when naming adds no clarity");
  expect(description).toContain("No extra approval round solely for style");
  expect(description).toContain("Never reformat an approved script");
});
