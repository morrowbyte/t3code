import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";

it.effect.each([undefined, false, true] as const)(
  "requires explicit operator activation (enabled=%s)",
  (enabled) =>
    Effect.gen(function* () {
      const policy = yield* Policy.ApprovalReviewOrderPolicy;
      assert.equal(policy.enabled, enabled === true);
      assert.deepEqual(policy.humans, []);
      assert.deepEqual(policy.channels, []);
    }).pipe(
      Effect.provide(
        Policy.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_APPROVAL_REVIEW_HOST_POLICY: JSON.stringify({
                    ...(enabled === undefined ? {} : { enabled }),
                    humans: [],
                    channels: [],
                  }),
                },
              }),
            ),
          ),
        ),
      ),
    ),
);
