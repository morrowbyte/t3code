# Morrowbyte

Morrowbyte is an independent fork of [T3 Code](https://github.com/pingdotgg/t3code) for working with coding agents on your own computer. It provides a desktop app and a web client for your local server. The upstream license and copyright notices remain in [LICENSE](./LICENSE).

Use your own provider account and local projects. A maintainer's accounts, devices, network or preferences are not prerequisites.

## Installation

### Download

Install the Morrowbyte Windows x64 installer or Linux x64 AppImage supplied with your Morrowbyte release. If you have repository access, use [Morrowbyte releases](https://github.com/morrowbyte/t3code/releases). Other users need the release files from their distributor, not access to the maintainer's repository or machines. Upstream T3 Code installers, package registries and `npx t3@latest` install upstream T3 Code.

Release files may still be named `T3-Code-…`; the installed product is Morrowbyte. Existing installations retain their profiles and update path.

### First run on your computer

1. Open Morrowbyte and use the local environment. A remote server is optional.
2. In provider setup, choose your provider and add or sign in to **your own account**. Follow the available installation and sign-in steps. Provider availability and model access depend on that provider and your account; Morrowbyte does not include a subscription or guarantee entitlement.
3. Add a local project folder, choose an available provider/model and start a thread.

The app supports Codex, Claude Code, Cursor, Grok Build, OpenCode and Antigravity. Setup differs by provider; the [provider guides](./docs/user/install.md) describe the available paths. You do not need to sign in to a maintainer's account or copy their authentication files.

### Optional remote access

Use your own server and devices over a LAN or your own NetBird, Tailscale or Headscale network. Pair the client with that server using its normal pairing flow; see [remote access](./docs/user/remote-access.md). A Morrowbyte cloud account or Morrowbyte-operated T3 Connect service is not required for local use or direct access to your own server.

## Documentation

Docs live in [docs/](./docs). Some guides still use upstream T3 Code names and distribution links; use the Morrowbyte download instructions above for this fork.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
