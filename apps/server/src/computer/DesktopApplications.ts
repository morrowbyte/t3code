import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { parseDesktopEntry, type DesktopApplication } from "./desktopEntries.ts";

export interface DesktopApplicationInventory {
  readonly platform: string;
  readonly supported: boolean;
  readonly complete: boolean;
  readonly applications: ReadonlyArray<DesktopApplication>;
  readonly total: number;
  readonly unreadable: number;
}

export class DesktopApplications extends Context.Service<
  DesktopApplications,
  {
    readonly list: (input: {
      readonly query?: string | undefined;
      readonly limit?: number | undefined;
      readonly includeHidden?: boolean | undefined;
    }) => Effect.Effect<DesktopApplicationInventory>;
  }
>()("t3/computer/DesktopApplications") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const locale = (environment.LC_MESSAGES || environment.LANG || "").split(".")[0] ?? "";
  const dataHome = environment.XDG_DATA_HOME;
  const dataDirs = (environment.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":");
  const roots = [
    ...new Set([
      dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(home, ".local/share"),
      ...dataDirs.filter((directory) => path.isAbsolute(directory)),
      path.join(home, ".nix-profile/share"),
      "/run/current-system/sw/share",
    ]),
  ].map((directory) => path.join(directory, "applications"));

  const list: DesktopApplications["Service"]["list"] = Effect.fn("DesktopApplications.list")(
    function* (input) {
      if (platform !== "linux") {
        return {
          platform,
          supported: false,
          complete: false,
          applications: [],
          total: 0,
          unreadable: 0,
        };
      }
      const applications: Array<DesktopApplication> = [];
      const seen = new Set<string>();
      let unreadable = 0;
      let complete = true;
      let visited = 0;
      const executableExists = Effect.fn("DesktopApplications.executableExists")(function* (
        executable: string,
      ) {
        const candidates = path.isAbsolute(executable)
          ? [executable]
          : (environment.PATH ?? "")
              .split(":")
              .filter((directory) => path.isAbsolute(directory))
              .map((directory) => path.join(directory, executable));
        for (const candidate of candidates) {
          const info = yield* fs.stat(candidate).pipe(Effect.orElseSucceed(() => null));
          if (info?.type === "File" && (info.mode & 0o111) !== 0) return true;
        }
        return false;
      });
      for (const root of roots) {
        const directories = [{ directory: root, prefix: "", depth: 0 }];
        while (directories.length > 0) {
          const current = directories.shift();
          if (!current) break;
          const entries = yield* fs.readDirectory(current.directory).pipe(
            Effect.catchTags({
              PlatformError: (error) => {
                if (error.reason._tag !== "NotFound") unreadable++;
                return Effect.succeed([] as Array<string>);
              },
            }),
          );
          for (const name of entries.sort()) {
            if (++visited > 4096) {
              complete = false;
              break;
            }
            const filename = path.join(current.directory, name);
            const info = yield* fs.stat(filename).pipe(Effect.orElseSucceed(() => null));
            if (!info) {
              unreadable++;
              continue;
            }
            if (info.type === "Directory") {
              if (current.depth < 4)
                directories.push({
                  directory: filename,
                  prefix: `${current.prefix}${name}-`,
                  depth: current.depth + 1,
                });
              else complete = false;
              continue;
            }
            if (!name.endsWith(".desktop")) continue;
            const id = `${current.prefix}${name}`;
            if (seen.has(id)) continue;
            seen.add(id);
            if (info.size > 65536) {
              unreadable++;
              continue;
            }
            const text = yield* fs.readFileString(filename).pipe(Effect.orElseSucceed(() => null));
            if (text === null) {
              unreadable++;
              continue;
            }
            const entry = parseDesktopEntry(id, text, locale);
            if (!entry || entry.hidden) continue;
            if (entry.tryExec && !(yield* executableExists(entry.tryExec))) continue;
            applications.push(entry.application);
          }
          if (!complete && visited > 4096) break;
        }
        if (!complete && visited > 4096) break;
      }
      const query = input.query?.trim().toLocaleLowerCase() ?? "";
      const matches = applications
        .filter(
          (app) =>
            (input.includeHidden || app.visible) &&
            (!query ||
              `${app.id} ${app.name} ${app.executable ?? ""}`.toLocaleLowerCase().includes(query)),
        )
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const limit = Math.max(1, Math.min(200, input.limit ?? 80));
      return {
        platform,
        supported: true,
        complete: complete && unreadable === 0 && matches.length <= limit,
        applications: matches.slice(0, limit),
        total: matches.length,
        unreadable,
      };
    },
  );
  return DesktopApplications.of({ list });
});

export const layer = Layer.effect(DesktopApplications, make);
