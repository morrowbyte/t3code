import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { Plugin } from "vite-plus";

// An explicit local mount lets the native companion share this dev server.
// It never starts a second listener or supplies a replacement native bridge.
export function jarvisDevMountPlugin(
  root: string | undefined,
  tauriApi: string | undefined,
): Plugin | undefined {
  if (!root || !tauriApi || !NodePath.isAbsolute(root) || !NodePath.isAbsolute(tauriApi)) return;
  const companionRoot = NodePath.resolve(root);
  const webEntry = NodeURL.fileURLToPath(new URL("../src/main.tsx", import.meta.url));
  const repositoryRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  return {
    name: "t3code:jarvis-dev-mount",
    apply: "serve",
    config: () => ({
      server: { fs: { allow: [repositoryRoot, companionRoot, NodePath.dirname(tauriApi)] } },
    }),
    async resolveId(id, importer) {
      if (!importer?.startsWith(`${companionRoot}/`)) return;
      if (id === "@tauri-apps/api/core") return tauriApi;
      if (/^(react(?:\/|$)|react-dom(?:\/|$)|lucide-react$)/.test(id)) {
        return this.resolve(id, webEntry, { skipSelf: true });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void (async () => {
          if (!request.url?.startsWith("/jarvis/")) return next();
          const url = new URL(request.url, "http://localhost");
          let file: string;
          try {
            file = NodePath.resolve(
              companionRoot,
              decodeURIComponent(url.pathname.slice("/jarvis/".length)) || "index.html",
            );
          } catch {
            response.statusCode = 400;
            response.end();
            return;
          }
          if (NodePath.relative(companionRoot, file).startsWith("..")) {
            response.statusCode = 403;
            response.end();
            return;
          }
          if (file.endsWith(".html")) {
            try {
              const source = (await NodeFSP.readFile(file, "utf8")).replaceAll(
                'src="./src/',
                `src="/@fs/${companionRoot}/src/`,
              );
              const html = await server.transformIndexHtml(url.pathname, source);
              response.setHeader("Content-Type", "text/html; charset=utf-8");
              response.end(html);
            } catch (error) {
              next(error);
            }
            return;
          }
          request.url = `/@fs/${file}${url.search}`;
          next();
        })().catch(next);
      });
    },
  };
}
