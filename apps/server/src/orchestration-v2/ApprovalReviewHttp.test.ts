import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  ApprovalReviewError,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as AuthHttp from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ApprovalReviewHttp from "./ApprovalReviewHttp.ts";
import * as ApprovalReviewService from "./ApprovalReviewService.ts";
import * as HostOrders from "./ApprovalReviewHostOrders.ts";
import * as Receiver from "./ApprovalReviewOrderReceiver.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.approvalReview) {}
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "enforces request/execute scopes before service access and preserves authenticated identity for worker read",
  () =>
    Effect.gen(function* () {
      const inputs = {
        ready: {},
        read: { threadId: "thread", requestId: "request" },
        submit: {
          orderId: "order:one",
          excerpt: { startUtf16: 0, endUtf16: 1, text: "x" },
          submissionId: "one",
          expiresAt: 1,
          action: {
            kind: "create_file_once",
            verifiedTargetId: "host",
            path: "/tmp/new",
            content: "",
            mode: 384,
            expectedAbsent: true,
            implementationVersion: "v1",
            implementationHash: "0".repeat(64),
          },
        },
        claim: {
          threadId: "thread",
          requestId: "request",
          packageHash: "0".repeat(64),
          verifiedTargetId: "host",
          claimId: "claim",
        },
        receipt: {
          threadId: "thread",
          requestId: "request",
          packageHash: "0".repeat(64),
          verifiedTargetId: "host",
          claimId: "claim",
          receipt: { outcome: "unknown" },
        },
      };
      for (const identity of [
        {
          subject: "requester",
          scopes: ["approval-review:request"] as const,
          permitted: ["submit", "read"],
        },
        {
          subject: "worker",
          scopes: ["approval-review:execute"] as const,
          permitted: ["ready", "claim", "receipt", "read"],
        },
        { subject: "ordinary-peer", scopes: ["orchestration:operate"] as const, permitted: [] },
      ] satisfies readonly {
        subject: string;
        scopes: readonly AuthEnvironmentScope[];
        permitted: readonly string[];
      }[]) {
        const calls: { operation: string; subject: string; worker?: boolean }[] = [];
        const record = (operation: string, subject: string, worker?: boolean) => {
          calls.push({ operation, subject, ...(worker === undefined ? {} : { worker }) });
          return Effect.fail(new ApprovalReviewError({ reason: "missing" }));
        };
        const routes = HttpApiBuilder.layer(TestApi).pipe(
          Layer.provide(ApprovalReviewHttp.layer),
          Layer.provide(
            Layer.mock(ApprovalReviewService.ApprovalReviewService)({
              submit: (_input, actor) => record("submit", actor.subject),
              read: (_input, actor, worker) =>
                record("read", typeof actor === "string" ? actor : actor.subject, worker),
              claim: (_input, subject) => record("claim", subject),
              receipt: (_input, subject) => record("receipt", subject),
              ready: (subject) => record("ready", subject),
            }),
          ),
          Layer.provide(
            Layer.mock(HostOrders.ApprovalReviewHostOrders)({
              create: (_input, actor) => record("orderCreate", actor.subject),
              read: (_id, actor) => record("orderRead", actor.subject),
              cancel: (_id, actor) => record("orderCancel", actor.subject),
              readiness: () =>
                Effect.succeed({
                  enabled: false,
                  reason: "human-authority-unconfigured",
                  channels: [],
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(Receiver.ApprovalReviewOrderReceiver)({
              receive: (_input, actor) => record("orderReceive", actor.subject),
            }),
          ),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
          Layer.provide(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              authenticateHttpRequest: () =>
                Effect.succeed({
                  sessionId: AuthSessionId.make(identity.subject),
                  subject: identity.subject,
                  method: "bearer-access-token",
                  scopes: identity.scopes,
                }),
            }),
          ),
          Layer.provide(
            HttpPlatform.layer.pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(Etag.layerWeak),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );
        const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
        yield* Effect.acquireUseRelease(
          Effect.succeed(web),
          (web) =>
            Effect.gen(function* () {
              const ownIdentity = yield* Effect.promise(() =>
                web.handler(
                  new Request("http://environment.test/api/approval-review/identity"),
                  Context.empty(),
                ),
              );
              assert.equal(ownIdentity.status, identity.subject === "ordinary-peer" ? 200 : 403);
              if (ownIdentity.status === 200)
                assert.deepEqual(yield* Effect.promise(() => ownIdentity.json()), {
                  sessionId: identity.subject,
                  subject: identity.subject,
                });
              for (const [operation, payload] of Object.entries(inputs)) {
                const before = calls.length;
                const response = yield* Effect.promise(() =>
                  web.handler(
                    new Request(`http://environment.test/api/approval-review/${operation}`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: encodeJson(payload),
                    }),
                    Context.empty(),
                  ),
                );
                const permitted = identity.permitted.some((allowed) => allowed === operation);
                assert.equal(
                  response.status,
                  permitted ? 409 : 403,
                  `${identity.subject}/${operation}`,
                );
                assert.equal(calls.length - before, permitted ? 1 : 0);
                if (permitted) assert.equal(calls.at(-1)?.subject, identity.subject);
                if (operation === "read" && permitted)
                  assert.equal(calls.at(-1)?.worker, identity.subject === "worker");
              }
            }),
          (web) => Effect.promise(() => web.dispose()),
        );
      }
    }),
);
