import { type PreviewAutomationStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopApplications from "./DesktopApplications.ts";

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));

export const ComputerTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("web"),
    browser: Schema.optional(Name),
    systemProfile: Schema.optional(Name),
    currentSession: Schema.optional(Schema.Boolean),
    previewProfileId: Schema.optional(Name),
  }),
  Schema.Struct({ kind: Schema.Literal("application"), application: Name }),
  Schema.Struct({ kind: Schema.Literal("desktop") }),
]).check(
  Schema.makeFilter(
    (target) =>
      target.kind !== "web" ||
      !target.previewProfileId ||
      (!target.browser && !target.systemProfile && !target.currentSession) ||
      "Choose a preview profile or a system-browser context, not both.",
  ),
);
export type ComputerTarget = typeof ComputerTarget.Type;

export const ComputerRoute = Schema.Struct({
  route: Schema.Literals(["preview", "desktop", "unavailable"]),
  reason: Schema.Literals([
    "preview-available",
    "preview-unavailable",
    "profile-unavailable",
    "explicit-application",
    "existing-session",
    "desktop-task",
    "application-unavailable",
    "ambiguous-application",
    "inventory-incomplete",
    "native-discovery-required",
  ]),
  interaction: Schema.Literals(["background", "capability-dependent", "unavailable"]),
  applicationId: Schema.optional(Schema.String),
  systemProfile: Schema.optional(Schema.String),
  previewProfileId: Schema.optional(Schema.String),
  tabId: Schema.optional(Schema.String),
  reuseExistingTab: Schema.optional(Schema.Boolean),
  candidates: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  nextTools: Schema.Array(Schema.String),
});
export type ComputerRoute = typeof ComputerRoute.Type;

export function selectComputerRoute(
  target: ComputerTarget,
  inventory: Pick<
    DesktopApplications.DesktopApplicationInventory,
    "platform" | "applications" | "complete"
  >,
  preview: PreviewAutomationStatus | null,
): ComputerRoute {
  const base = { candidates: [] };
  const nativeTools =
    inventory.platform === "linux"
      ? ["desktop_windows", "desktop_semantic_direct", "desktop_observe", "desktop_act"]
      : ["start_session"];
  const desktop = {
    ...base,
    route: "desktop" as const,
    interaction: "capability-dependent" as const,
    nextTools: nativeTools,
  };
  if (target.kind === "desktop") return { ...desktop, reason: "desktop-task" };
  const requestedApp = target.kind === "application" ? target.application : target.browser;
  if (requestedApp) {
    const query = requestedApp.toLocaleLowerCase();
    const eligible = inventory.applications.filter((app) => target.kind !== "web" || app.browser);
    const exact = eligible.filter((app) =>
      [app.id, app.name, app.executable].some((value) => value?.toLocaleLowerCase() === query),
    );
    const candidates =
      exact.length > 0
        ? exact
        : eligible.filter((app) => `${app.id} ${app.name}`.toLocaleLowerCase().includes(query));
    if (inventory.platform === "linux" && !inventory.complete) {
      return {
        ...base,
        route: "unavailable",
        reason: "inventory-incomplete",
        interaction: "unavailable",
        candidates: candidates.slice(0, 10).map(({ id, name }) => ({ id, name })),
        nextTools: nativeTools,
      };
    }
    if (candidates.length === 1) {
      return {
        ...desktop,
        reason: "explicit-application",
        applicationId: candidates[0]!.id,
        ...(target.kind === "web" && target.systemProfile
          ? { systemProfile: target.systemProfile }
          : {}),
      };
    }
    if (inventory.platform !== "linux") {
      return {
        ...desktop,
        reason: "native-discovery-required",
        applicationId: requestedApp,
        ...(target.kind === "web" && target.systemProfile
          ? { systemProfile: target.systemProfile }
          : {}),
      };
    }
    return {
      ...base,
      route: "unavailable",
      interaction: "unavailable",
      reason: candidates.length > 1 ? "ambiguous-application" : "application-unavailable",
      candidates: candidates.slice(0, 10).map(({ id, name }) => ({ id, name })),
      nextTools: ["computer_apps"],
    };
  }
  if (target.kind === "application") {
    return {
      ...base,
      route: "unavailable",
      reason: "application-unavailable",
      interaction: "unavailable",
      nextTools: ["computer_apps"],
    };
  }
  if (target.systemProfile || target.currentSession) {
    return {
      ...desktop,
      reason: "existing-session",
      ...(target.systemProfile ? { systemProfile: target.systemProfile } : {}),
    };
  }
  if (
    !preview ||
    (!preview.available && !(preview.tabId === null && preview.profiles !== undefined))
  ) {
    return target.previewProfileId
      ? {
          ...base,
          route: "unavailable",
          reason: "profile-unavailable",
          interaction: "unavailable",
          nextTools: ["preview_status"],
        }
      : { ...desktop, reason: "preview-unavailable" };
  }
  if (
    target.previewProfileId &&
    !preview.profiles?.some((profile) => profile.id === target.previewProfileId)
  ) {
    return {
      ...base,
      route: "unavailable",
      reason: "profile-unavailable",
      interaction: "unavailable",
      nextTools: ["preview_status"],
    };
  }
  const tab = preview.tabs?.find(
    (candidate) =>
      candidate.ownedByCaller &&
      candidate.owner !== "human" &&
      (!target.previewProfileId || candidate.profileId === target.previewProfileId),
  );
  const currentOwned = preview.control?.ownedByCaller && preview.control.owner !== "human";
  const tabId = tab?.tabId ?? (!target.previewProfileId && currentOwned ? preview.tabId : null);
  return {
    ...base,
    route: "preview",
    reason: "preview-available",
    interaction: "background",
    ...(target.previewProfileId ? { previewProfileId: target.previewProfileId } : {}),
    ...(tabId ? { tabId } : {}),
    reuseExistingTab: !!tabId,
    nextTools: ["preview_open", "preview_snapshot", "preview_batch"],
  };
}

export class ComputerRouting extends Context.Service<
  ComputerRouting,
  {
    readonly route: (
      target: ComputerTarget,
      scope: McpInvocationContext.McpThreadInvocationScope,
    ) => Effect.Effect<ComputerRoute>;
  }
>()("t3/computer/ComputerRouting") {}

const make = Effect.gen(function* () {
  const applications = yield* DesktopApplications.DesktopApplications;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const platform = yield* HostProcess.Platform;
  const route = Effect.fn("ComputerRouting.route")(function* (
    target: ComputerTarget,
    scope: McpInvocationContext.McpThreadInvocationScope,
  ) {
    const needsApps = target.kind === "application" || (target.kind === "web" && !!target.browser);
    const inventory = needsApps
      ? yield* applications.list({
          ...(needsApps
            ? {
                query:
                  target.kind === "application"
                    ? target.application
                    : target.kind === "web"
                      ? target.browser
                      : undefined,
              }
            : {}),
          limit: 200,
          includeHidden: true,
        })
      : { platform, applications: [], complete: true };
    const needsPreview =
      target.kind === "web" && !target.browser && !target.systemProfile && !target.currentSession;
    const preview =
      needsPreview && scope.capabilities.has("preview")
        ? yield* broker
            .invoke<PreviewAutomationStatus>({
              scope,
              operation: "status",
              input: {},
              timeoutMs: 2000,
              updateCurrentTab: false,
            })
            .pipe(Effect.orElseSucceed(() => null))
        : null;
    return selectComputerRoute(target, inventory, preview);
  });
  return ComputerRouting.of({ route });
});

export const layer = Layer.effect(ComputerRouting, make);
