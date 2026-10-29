# Crew

<img src="assets/crew/native.svg" width="96" height="96" alt="Crew" />

**Your workspace for agentic work. Your crew, your direction.**

Crew is built by **Morrowbyte** as an independent fork of [T3 Code](https://github.com/pingdotgg/t3code).
It keeps T3 Code's local-first agent server and desktop, web, and mobile clients,
while exploring richer conversations, visible background work, and practical
multi-machine workflows. Bring your own supported provider account; the machine
hosting an environment runs its agents and owns its project files.

## What this fork adds

- **Answers you can explore.** Agents can stream charts, comparison cards,
  timelines, workflows, and UML diagrams directly into a conversation. The
  [visuals](docs/user/streamable-ui.md) render locally and retain their source data.
- **Work that stays findable.** Thread organization, activity history, and
  attention surfaces help you return to results, questions, and approvals without
  losing the original conversation. See [working with threads](docs/user/thread-sidebar.md)
  and the [activity log](docs/user/activity-log.md).
- **Remote environments as part of the workspace.** Connect desktop and mobile
  clients to the machine that owns a project, and use the integrated
  [browser](docs/user/default-browser.md) and [device panel](docs/user/devices.md)
  to inspect work where it runs.
- **Voice and desktop-assistant experiments.** [Jarvis conversations](docs/user/jarvis.md)
  can hand work to a durable T3 conversation while you continue talking. Voice,
  native integration, and background behavior are evolving; a feature on `main`
  is not a promise of identical behavior on every device or released build.
- **A separate release and update path.** The fork publishes Windows x64,
  Linux x64, NixOS packaging, and Android ARM64 artifacts through its own
  [nightly releases](https://github.com/morrowbyte/t3code/releases).

Crew also retains upstream support for providers including Codex, Claude
Code, Cursor, Grok, OpenCode, and Antigravity. Availability depends on the provider
installation, authentication, and client version. Provider subscriptions and
third-party services are separate from this project.

## Install Crew

Start with the [Crew releases](https://github.com/morrowbyte/t3code/releases)
and read the notes for the version you choose. These are development builds;
keep a working version available when updating.

- **Windows x64:** download the Windows installer from the selected release.
- **Linux x64:** download the AppImage. The release includes an optional
  `install-linux.sh` helper; inspect it before running it.
- **NixOS x64:** use the dedicated [NixOS package and updater](packaging/nixos/README.md).
  The generic AppImage installer is not the NixOS installation path.
- **Android ARM64:** download the signed `Morrowbyte-…-android-arm64.apk` from a
  release that includes it. The phone connects to a running environment server;
  it does not run desktop provider CLIs itself.

The upstream app stores, package-manager entries, `npx t3`, and installers at
`t3.codes` install **upstream T3 Code**, not this fork. macOS, iOS, and desktop
ARM64 artifacts are not currently published by the Morrowbyte release workflow.
Do not assume upstream and fork profiles or update channels are interchangeable.

The native app is **Crew**; the installed browser app is **Crew Web**, with the
same C mark inside a browser frame. Existing package IDs, profiles, deep links,
and update artifact names retain their Morrowbyte/T3 identifiers so existing
installations can continue updating without losing their connections or data.

## Get started

1. Install and authenticate a supported provider on the environment host.
2. Open Crew, add a project, and start a thread.
3. To work from another device, follow [remote access](docs/user/remote-access.md).
4. Review [permission modes](docs/user/permission-modes.md) before granting agents
   access to files, commands, browsers, or devices.

Further guides: [FAQ](docs/user/faq.md), [composer](docs/user/composer.md),
[keyboard shortcuts](docs/user/keybindings.md),
[project settings](docs/user/project-settings.md),
[outside agents and MCP](docs/user/outside-agents.md),
[updating](docs/user/updating.md), and [provider setup](docs/user/providers-codex.md).
Some inherited guides describe upstream distribution channels; use the fork
release links above when installing Crew.

## Develop

Install [Vite+](https://viteplus.dev/guide/), then:

```sh
git clone https://github.com/morrowbyte/t3code.git
cd t3code
vp install
vp run dev
```

Use isolated development state and keep credentials, personal transcripts, and
machine-specific configuration out of Git. See [development](docs/operations/development.md),
[architecture](docs/internals/overview.md), and [AGENTS.md](AGENTS.md).
Report fork-specific issues in [this repository](https://github.com/morrowbyte/t3code/issues).
When reporting upstream issues, reproduce them on upstream T3 Code first.

## Upstream and license

Crew builds on the work of the T3 Code maintainers and contributors. It is
not an official T3 Code release and is not endorsed by the upstream project.
The original [MIT license](LICENSE) and third-party notices remain in place;
see [open-source licenses](docs/user/open-source-licenses.md).
