// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { SourceControlProviderError } from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { TestClock } from "effect/testing";
import * as Duration from "effect/Duration";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("resolves filtered origin and upstream remotes without losing the fork identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-filtered-remotes-",
      });
      const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.succeed({
            stdout: input.args.includes("rev-parse")
              ? `${cwd}\n`
              : [
                  "origin\tgit@github.com:morrowbyte/t3code.git (fetch) [blob:none]",
                  "origin\tgit@github.com:morrowbyte/push-only.git (push)",
                  "upstream\thttps://github.com/t3tools/t3code.git (fetch) [blob:none]",
                  "upstream\thttps://github.com/t3tools/push-only.git (push)",
                ].join("\n"),
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      });
      const layerResolver = Layer.effect(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        RepositoryIdentityResolver.make(),
      ).pipe(Layer.provide(layerProcessRunner));

      yield* Effect.gen(function* () {
        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const identity = yield* resolver.resolve(cwd);
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.rootPath).toBe(cwd);
        expect(identity?.locator).toEqual({
          source: "git-remote",
          remoteName: "upstream",
          remoteUrl: "https://github.com/t3tools/t3code.git",
        });
        expect(identity?.origin).toEqual({
          canonicalKey: "github.com/morrowbyte/t3code",
          remoteUrl: "git@github.com:morrowbyte/t3code.git",
          displayName: "morrowbyte/t3code",
        });
      }).pipe(Effect.provide(layerResolver));
    }),
  );

  it.effect("refreshes the Git root only when requested", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-refresh-",
      });
      const projectPath = path.join(repoRoot, "packages", "web");
      yield* fileSystem.makeDirectory(projectPath, { recursive: true });
      const calls: Array<ReadonlyArray<string>> = [];
      let rootPath = repoRoot;
      let remoteUrl = "git@github.com:T3Tools/t3code.git";
      let refinements = 0;
      let refinementFails = false;
      const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.sync(() => {
            calls.push(input.args);
            return {
              stdout: input.args.includes("rev-parse")
                ? `${rootPath}\n`
                : `origin\t${remoteUrl} (fetch)\n`,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      });
      const layerResolver = Layer.effect(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        RepositoryIdentityResolver.make({
          refine: (identity) => {
            refinements++;
            if (refinementFails)
              return Effect.fail(
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("forgejo"),
                  operation: "detectProvider",
                  cwd: rootPath,
                  detail: "account unavailable",
                }),
              );
            return Effect.succeed(
              identity.canonicalKey.startsWith("ssh.forge.test/")
                ? {
                    ...identity,
                    provider: SourceControlProviderKind.make("forgejo"),
                    webUrl: "http://forge.test:3000/git/team/repo",
                  }
                : identity,
            );
          },
        }),
      ).pipe(Layer.provide(layerProcessRunner));

      yield* Effect.gen(function* () {
        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const first = yield* resolver.resolve(projectPath);
        rootPath = projectPath;
        // Longer than the one-minute cadence of the background sweeps.
        yield* TestClock.adjust(Duration.minutes(10));
        const second = yield* resolver.resolve(projectPath);

        expect(first?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(second).toEqual(first);
        expect(refinements).toBe(1);
        expect(calls).toEqual([
          ["-C", projectPath, "rev-parse", "--show-toplevel"],
          ["-C", repoRoot, "remote", "-v"],
        ]);

        const refreshed = yield* resolver.resolve(projectPath, { refresh: true });
        expect(refreshed?.rootPath).toBe(projectPath);
        expect(yield* resolver.resolve(projectPath)).toEqual(refreshed);
        expect(calls.slice(2)).toEqual([
          ["-C", projectPath, "rev-parse", "--show-toplevel"],
          ["-C", projectPath, "remote", "-v"],
        ]);
        remoteUrl = "git@ssh.forge.test:team/repo.git";
        const forgejo = yield* resolver.resolve(rootPath, { refresh: true });
        expect(forgejo?.webUrl).toBe("http://forge.test:3000/git/team/repo");
        expect(forgejo?.provider).toBe("forgejo");
        expect(forgejo?.canonicalKey).toBe("ssh.forge.test/team/repo");
        expect(forgejo?.locator.remoteUrl).toBe(remoteUrl);
        expect(yield* resolver.resolve(rootPath)).toEqual(forgejo);
        expect(refinements).toBe(3);
        refinementFails = true;
        const unavailable = yield* resolver.resolve(rootPath, { refresh: true });
        expect(unavailable?.webUrl).toBeUndefined();
        expect(unavailable?.canonicalKey).toBe("ssh.forge.test/team/repo");
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layerResolver)));
    }),
  );

  it.effect("retries Git root discovery after the negative TTL", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-negative-ttl-",
      });
      const projectPath = path.join(repoRoot, "packages", "web");
      yield* fileSystem.makeDirectory(projectPath, { recursive: true });
      const calls: Array<ReadonlyArray<string>> = [];
      let rootAttempts = 0;
      const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.sync(() => {
            calls.push(input.args);
            const bareLookup = input.args.includes("--is-bare-repository");
            const rootLookup = input.args.includes("--show-toplevel");
            const failed = bareLookup || (rootLookup && rootAttempts++ === 0);
            return {
              stdout: rootLookup
                ? failed
                  ? ""
                  : `${repoRoot}\n`
                : "origin\tgit@github.com:T3Tools/t3code.git (fetch)\n",
              stderr: failed ? "temporary Git failure" : "",
              code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      });
      const layerResolver = Layer.effect(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        RepositoryIdentityResolver.make(),
      ).pipe(Layer.provide(layerProcessRunner));

      yield* Effect.gen(function* () {
        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        expect(yield* resolver.resolve(projectPath)).toBeNull();
        expect(yield* resolver.resolve(projectPath)).toBeNull();

        yield* TestClock.adjust(Duration.minutes(1));
        const recovered = yield* resolver.resolve(projectPath);
        expect(recovered?.rootPath).toBe(repoRoot);
        expect(calls).toEqual([
          ["-C", projectPath, "rev-parse", "--show-toplevel"],
          ["-C", projectPath, "rev-parse", "--show-toplevel"],
          ["-C", repoRoot, "remote", "-v"],
        ]);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layerResolver)));
    }),
  );

  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath matches git's long paths when Windows temp dirs use 8.3 names.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
      expect(yield* resolver.resolve(path.join(cwd, ".git"))).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("resolves the fetch remote of a partial clone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-partial-clone-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["remote", "set-url", "--push", "origin", "git@github.com:T3Tools/push.git"]);
      yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
      yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);

      const remotes = yield* git(cwd, ["remote", "-v"]);
      expect(remotes.stdout).toContain("(fetch) [blob:none]");

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.locator.remoteUrl).toBe("git@github.com:T3Tools/t3code.git");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
        normalizeResolvedPath(resolvedRepoRoot),
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["bare clone", "dot-bare"] as const)(
    "resolves a %s to its Git directory and the same identity as a checkout",
    (layout) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkout = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-checkout-",
        });
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-bare-",
        });
        const bareGitDir = layout === "dot-bare" ? path.join(root, ".bare") : root;

        yield* git(checkout, ["init"]);
        yield* git(checkout, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
        yield* git(root, ["init", "--bare", bareGitDir]);
        if (layout === "dot-bare") {
          yield* fileSystem.writeFileString(path.join(root, ".git"), "gitdir: ./.bare\n");
        }
        yield* git(root, [
          "--git-dir",
          bareGitDir,
          "remote",
          "add",
          "origin",
          "https://github.com/T3Tools/t3code.git",
        ]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const checkoutIdentity = yield* resolver.resolve(checkout);
        expect(checkoutIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        const resolvedBareGitDir = NodeFS.realpathSync.native(bareGitDir);
        const projectRoots = layout === "dot-bare" ? [root, bareGitDir] : [root];

        for (const projectRoot of projectRoots) {
          const identity = yield* resolver.resolve(projectRoot);
          const resolvedIdentityRoot =
            identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);

          expect(identity).not.toBeNull();
          expect(identity?.canonicalKey).toBe(checkoutIdentity?.canonicalKey);
          expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
            normalizeResolvedPath(resolvedBareGitDir),
          );
        }

        yield* git(root, ["--git-dir", bareGitDir, "remote", "remove", "origin"]);
        for (const projectRoot of projectRoots) {
          expect(yield* resolver.resolve(projectRoot, { refresh: true })).toBeNull();
        }
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "returns null for non-git, missing and no-remote folders, probing only what can exist",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-non-git-",
        });
        const gitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-no-remote-",
        });

        yield* git(gitDir, ["init"]);

        const runner = yield* ProcessRunner.ProcessRunner;
        const runs: Array<ReadonlyArray<string>> = [];
        const resolver = yield* RepositoryIdentityResolver.make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.suspend(() => {
                runs.push(input.args);
                return runner.run(input);
              }),
          }),
        );
        const bareProbes = () =>
          runs.filter((args) => args.some((arg) => arg.startsWith("--git-dir=")));

        expect(yield* resolver.resolve(path.join(nonGitDir, "deleted"))).toBeNull();
        expect(runs).toEqual([]);

        expect(yield* resolver.resolve(nonGitDir)).toBeNull();
        expect(bareProbes()).toEqual([]);

        expect(yield* resolver.resolve(gitDir)).toBeNull();
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("ignores local-path remotes such as GitButler's gb-local", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const localOnlyDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-local-remote-",
      });
      const mixedDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-mixed-remote-",
      });

      yield* git(localOnlyDir, ["init"]);
      yield* git(localOnlyDir, ["remote", "add", "gb-local", "."]);
      yield* git(localOnlyDir, ["remote", "add", "backup", "/srv/git/repo.git"]);
      yield* git(localOnlyDir, ["remote", "add", "archive", "file:///srv/git/repo.git"]);
      yield* git(mixedDir, ["init"]);
      yield* git(mixedDir, ["remote", "add", "gb-local", "."]);
      yield* git(mixedDir, ["remote", "add", "mirror", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve(localOnlyDir)).toBeNull();

      const mixedIdentity = yield* resolver.resolve(mixedDir);
      expect(mixedIdentity?.locator.remoteName).toBe("mirror");
      expect(mixedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:T3Tools/t3code.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.displayName).toBe("T3Tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reports a fork's own remote as origin next to the upstream identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-fork-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.origin).toEqual({
        canonicalKey: "github.com/julius/t3code-fork",
        remoteUrl: "git@github.com:julius/t3code-fork.git",
        displayName: "julius/t3code-fork",
      });
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("T3Tools/platform/t3code");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );
});
