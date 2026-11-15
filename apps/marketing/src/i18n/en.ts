// Source strings. Every other locale must provide the same shape (see `Messages`).
// `{name}` placeholders are filled at render time and must survive translation.
export const en = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription:
      "Crew. One workspace for conversations, research, code, and delegated work.",
    socialImageAlt:
      "T3 Code: the open-source control plane for coding agents, with Claude Code, Codex, Cursor, OpenCode, Grok and Antigravity.",
    homeLabel: "T3 Code home",
    download: "Download",
    starsLabel: "Star T3 Code on GitHub, {stars} stars",
    githubStars: "{stars} GitHub stars",
    language: "Language",
    mitLicensed: "MIT licensed",
    iosApp: "iOS app",
    androidApp: "Android app",
    terms: "Terms",
    privacy: "Privacy",
    security: "Security",
  },
  home: {
    title: "Crew | Your ambition. Your direction. Your crew.",
    description: "Crew. One workspace for conversations, research, code, and delegated work.",
    heroTitle: ["Your ambition.", "Your direction.", "Your crew."],
    heroSub:
      "One workspace for conversations, research, code, and delegated work. Bring your own agents. Stay part of the decisions.",
    downloadForMac: "Download for macOS",
    downloadForWindows: "Download for Windows",
    downloadForLinux: "Download for Linux",
    downloadForIos: "Download for iOS",
    downloadForAndroid: "Download for Android",
    sourceLink: "Steal our code (legally)",
    alsoOnPhone: "Also on your phone:",
    screenshotAlt: "T3 Code running Claude, Codex, Muse, and Gemini subagents in one thread",
    endorsementsTitle: "From the T3 Code community",
    endorsementsSub: "About upstream T3 Code, not Crew.",
    endorsementsLabel: "Developer endorsements",
    readPost: "Read {handle}'s post on X",
    harnessTitle: "Bring your own sub",
    harnessBody:
      "Crew doesn't resell tokens. Plug in Claude Code, Codex, Antigravity, OpenCode, Cursor, Grok, Kiro, Pi, or Muse Code with the credentials you already have. We orchestrate them, you keep your plan.",
    googleSignIn: "Google sign-in",
    harnessPoints: [
      "No keys resold. No quota caps.",
      "Switch models mid-thread.",
      "More harnesses shipping weekly.",
    ],
    gitVisualLabel:
      "Illustration of the Crew Git workflow: review a diff, commit and push changes, and open a pull request.",
    prReady: "Ready",
    prCommits: "3 commits",
    viewDiff: "View diff",
    openPullRequest: "Open pull request",
    commitPush: "Commit & push",
    gitTitle: "One button to commit, push, and make a PR.",
    gitBody:
      "Every agent thread writes to its own branch. When it's good, one button opens the PR on GitHub with a generated title, body and changelog. No terminal dance required.",
    gitPoints: [
      "Auto-generated PR titles & bodies",
      "Inline diff review before you push",
      "Draft PRs, stack PRs, amend PRs",
      "Works with your existing GitHub auth",
    ],
    openTitle: "If you don't like something, fork it.",
    openPoints: [
      { lead: "Change the UI.", rest: "Restyle every surface to match your taste." },
      { lead: "Add an agent.", rest: "Wire in your own tools, models, and flows." },
      { lead: "Ship your own build.", rest: "Self-host it or distribute it as your own." },
    ],
    stars: "{stars} stars",
    forkOnGithub: "Fork on GitHub",
    browseSource: "Browse source",
    ctaTitle: "Your agents deserve better than a terminal.",
    ctaSub:
      "Crew is free, open source and fast. Install it, plug in the harness you already pay for, and let your agents get to work.",
    otherPlatforms: "Other platforms",
    nativeAppAlt: "Crew native app icon",
    webAppAlt: "Crew Web app icon with browser frame",
  },
  download: {
    title: "Download | Crew",
    description: "Download Crew for Windows x64, Linux x64, NixOS, and Android ARM64.",
    breadcrumb: "Download",
    heading: "Download Crew",
    channelLabel: "Release channel",
    stable: "Stable",
    nightly: "Nightly",
    intelNote: "On an Intel Mac? {link}.",
    intelLink: "Download the x64 build",
    armNote: "On ARM? Download the arm64 {deb} or {appimage}.",
    mobile: "Mobile",
    iphoneIpad: "iPhone & iPad",
    terminal: "Terminal",
    tryOnce: "Or try it once without installing:",
    allBuilds: "Crew builds are published on the {link}.",
    releasesPage: "Morrowbyte GitHub releases page",
    builtAgo: "Built {age}",
    releasesFallback: "Releases",
    windowsInstaller: "Windows installer",
    nixosGuide: "Package and installation guide",
    installGuide: "Install guide",
    viewReleases: "View releases",
    unavailablePlatforms: "macOS and iOS production builds are not available for this fork.",
  },
};

type Widen<T> = T extends string
  ? string
  : T extends ReadonlyArray<infer Item>
    ? ReadonlyArray<Widen<Item>>
    : { readonly [Key in keyof T]: Widen<T[Key]> };

export type Messages = Widen<typeof en>;
