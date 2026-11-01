import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as UsageService from "../../usage/UsageService.ts";
import { priceTurnUsage } from "../../usage/turnCost.ts";

export const layer = Layer.mock(UsageService.UsageService)({
  priceTurn: (input) =>
    Effect.succeed(
      priceTurnUsage(input, {
        rates: new Map(),
        overrides: new Map(),
        pricedAt: "2026-11-01T00:00:00Z",
        ratesFetchedAt: null,
      }),
    ),
});
