export interface DesktopApplication {
  readonly id: string;
  readonly name: string;
  readonly executable: string | null;
  readonly categories: ReadonlyArray<string>;
  readonly browser: boolean;
  readonly dbusActivatable: boolean;
  readonly visible: boolean;
  readonly terminal: boolean;
  readonly desktopActions: ReadonlyArray<string>;
  readonly flatpakId: string | null;
  readonly toolkitHint: "gtk" | "qt" | "unknown";
}

const unescapeValue = (value: string) =>
  value.replace(/\\([sntr\\])/g, (_, character: string) => {
    switch (character) {
      case "s":
        return " ";
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return "\\";
    }
  });

const listValue = (value: string | undefined) =>
  (value ?? "").split(";").filter(Boolean).slice(0, 32);

export function parseDesktopEntry(id: string, text: string, locale: string) {
  const values = new Map<string, string>();
  let inEntry = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      inEntry = line.trim() === "[Desktop Entry]";
      continue;
    }
    if (!inEntry || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1));
  }
  if (values.get("Hidden") === "true") return { hidden: true as const };
  if (values.get("Type") !== "Application") return null;
  const language = locale.split(/[_@]/)[0];
  const name =
    values.get(`Name[${locale}]`) ?? values.get(`Name[${language}]`) ?? values.get("Name");
  if (!name) return null;
  const exec = values.get("Exec");
  const executable =
    exec
      ?.match(/^(?:"([^"]+)"|([^\s]+))/)
      ?.slice(1)
      .find(Boolean) ?? null;
  const dbusActivatable = values.get("DBusActivatable") === "true";
  const categories = listValue(values.get("Categories"));
  const mimeTypes = listValue(values.get("MimeType"));
  return {
    hidden: false as const,
    tryExec: values.get("TryExec"),
    application: {
      id,
      name: unescapeValue(name).slice(0, 200),
      executable: executable?.split("/").at(-1)?.slice(0, 200) ?? null,
      categories,
      browser: categories.includes("WebBrowser") || mimeTypes.includes("x-scheme-handler/https"),
      dbusActivatable,
      visible: values.get("NoDisplay") !== "true",
      terminal: values.get("Terminal") === "true",
      desktopActions: listValue(values.get("Actions")),
      flatpakId: values.get("X-Flatpak")?.slice(0, 255) ?? null,
      toolkitHint: categories.includes("GTK")
        ? "gtk"
        : categories.includes("Qt")
          ? "qt"
          : "unknown",
    } satisfies DesktopApplication,
  };
}
