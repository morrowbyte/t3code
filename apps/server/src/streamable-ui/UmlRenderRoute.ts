import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as UmlRenderer from "./UmlRenderer.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "streamableUi",
  Effect.fnUntraced(function* (handlers) {
    const renderer = yield* UmlRenderer.UmlRenderer;
    return handlers.handle(
      "renderUml",
      Effect.fn("environment.streamableUi.renderUml")(function* ({ payload }) {
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* renderer.render(payload);
      }),
    );
  }),
);
