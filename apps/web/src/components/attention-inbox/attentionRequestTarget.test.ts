import { EnvironmentId, NodeId, RuntimeRequestId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import {
  attentionRequestFromLocation,
  attentionRequestHref,
  resolveAttentionRequestTarget,
  selectAttentionRequests,
} from "./attentionRequestTarget";

describe("attention request navigation", () => {
  it("selects Q2 without activating Q1 or a different pending category", () => {
    const questions = [{ requestId: "q1" }, { requestId: "q2" }];
    const approvals = [{ requestId: "approval" }];
    expect(selectAttentionRequests(questions, "q2")).toEqual([questions[1]]);
    expect(selectAttentionRequests(approvals, "q2")).toEqual([]);
    expect(selectAttentionRequests(approvals, "approval")).toEqual(approvals);
    expect(selectAttentionRequests(questions, "approval")).toEqual([]);
    expect(selectAttentionRequests(questions, "auth")).toEqual([]);
    expect(selectAttentionRequests(questions, "secret-card")).toEqual([]);
    expect(selectAttentionRequests(questions, "resolved-q2")).toEqual([]);
    expect(selectAttentionRequests(questions, null)).toBe(questions);
  });

  it("keeps targets across reload/back/reconnect and scopes identical IDs to their route", () => {
    const ref = {
      environmentId: EnvironmentId.make("env:one"),
      threadId: ThreadId.make("thread:one"),
    };
    const href = "/env%3Aone/thread%3Aone?requestId=q%3A2";
    expect(attentionRequestFromLocation(href, ref)).toBe("q:2");
    expect(attentionRequestFromLocation(attentionRequestHref(ref, "q:2"), ref)).toBe("q:2");
    expect(
      attentionRequestFromLocation(href, { ...ref, environmentId: EnvironmentId.make("env:two") }),
    ).toBeNull();
    expect(
      attentionRequestFromLocation(href, { ...ref, threadId: ThreadId.make("thread:two") }),
    ).toBeNull();
    expect(attentionRequestFromLocation("/env%3Aone/thread%3Aone", ref)).toBeNull();
    expect(attentionRequestFromLocation(href, ref)).toBe("q:2");
  });

  it("keeps an absent target closed and presents only its own delivery failure", () => {
    const projection = makeThreadProjectionFixture();
    const request = {
      id: RuntimeRequestId.make("auth"),
      nodeId: NodeId.make("node"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "auth_refresh" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: projection.updatedAt,
      resolvedAt: null,
    };
    const source = { ...projection, runtimeRequests: [request] };
    expect(resolveAttentionRequestTarget(source, "auth").kind).toBe("runtime");
    expect(resolveAttentionRequestTarget(source, "absent").kind).toBe("resolved");
    expect(
      resolveAttentionRequestTarget(source, "missing-card", [
        { ...request, id: RuntimeRequestId.make("missing-card") },
      ]).kind,
    ).toBe("unavailable");
    expect(resolveAttentionRequestTarget(source, "auth", []).kind).toBe("resolved");
    for (const status of ["resolved", "cancelled", "expired"] as const) {
      expect(
        resolveAttentionRequestTarget(
          { ...source, runtimeRequests: [{ ...request, status }] },
          "auth",
        ).kind,
      ).toBe("resolved");
    }
    const failure = {
      requestId: request.id,
      itemId: TurnItemId.make("turn-item:runtime-request-delivery-failure:auth"),
      message: "Answer delivery not confirmed",
      occurredAt: projection.updatedAt,
    };
    expect(resolveAttentionRequestTarget(source, "auth", [], failure)).toMatchObject({
      kind: "delivery_failed",
      failure,
    });
    expect(resolveAttentionRequestTarget(source, "different", [], failure).kind).toBe("resolved");
  });
});
