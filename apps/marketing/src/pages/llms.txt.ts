import type { APIRoute } from "astro";

import { GITHUB_REPOSITORY_URL, NIXOS_INSTALL_URL, UPSTREAM_REPOSITORY_URL } from "../lib/site";
import { SITE_TAGLINE } from "../lib/seo";

export const GET: APIRoute = () => {
  const body = `# Crew

> ${SITE_TAGLINE}. Crew is the Morrowbyte fork of the MIT-licensed T3 Code project.

## Downloads and source

- [Crew releases](${GITHUB_REPOSITORY_URL}/releases): Windows x64, Linux x64 and Android ARM64 builds
- [NixOS installation](${NIXOS_INSTALL_URL})
- [Crew source code](${GITHUB_REPOSITORY_URL})
- [Upstream T3 Code](${UPSTREAM_REPOSITORY_URL})

The T3 Code npm package and mobile store listings belong to upstream. They are not Crew release channels.
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
