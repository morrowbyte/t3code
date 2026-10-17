import type * as Electron from "electron";
import { AutofillUnavailable, type AutofillTarget } from "./ProtonPassAutofill.ts";
import { makeAutofill } from "./ProtonPassAutofill.ts";
import { ProtonPassUnavailable } from "./ProtonPassCli.ts";

export interface AutofillMenuUi {
  choose(title: string, choices: readonly string[]): Promise<number | undefined>;
  notice(message: string): Promise<void>;
  restoreFocus(): void | Promise<void>;
}
// WebContents.focus alone can leave the embedder's activeElement outside its webview.
export async function restoreAutofillWebviewFocus(
  owner: Electron.BrowserWindow,
  contents: Electron.WebContents,
) {
  const current = () =>
    !owner.isDestroyed() &&
    owner.isFocused() &&
    !contents.isDestroyed() &&
    contents.hostWebContents === owner.webContents;
  if (!current()) throw new AutofillUnavailable();
  const focused: unknown = await owner.webContents.executeJavaScript(`(() => {
    const matches = [...document.querySelectorAll('webview')].filter(element =>
      element.isConnected && element.ownerDocument === document &&
      typeof element.getWebContentsId === 'function' && element.getWebContentsId() === ${contents.id});
    if (matches.length !== 1 || !document.hasFocus() || document.visibilityState !== 'visible') return false;
    const webview = matches[0];
    webview.focus();
    return webview.isConnected && document.activeElement === webview && document.hasFocus();
  })()`);
  if (!current() || focused !== true) throw new AutofillUnavailable();
  contents.focus();
  if (!current() || !contents.isFocused()) throw new AutofillUnavailable();
}
const label = (value: string) =>
  value
    .replace(/[\r\n\t]/g, " ")
    .replaceAll("&", "&&")
    .slice(0, 120);
export function makeNativeAutofillUi(
  owner: Electron.BrowserWindow,
  contents: Electron.WebContents,
  native: Pick<typeof Electron, "Menu" | "dialog">,
): AutofillMenuUi {
  return {
    restoreFocus: () => restoreAutofillWebviewFocus(owner, contents),
    async choose(title, choices) {
      const pageSize = 64;
      let offset = 0;
      while (!owner.isDestroyed() && !contents.isDestroyed()) {
        const selected = await new Promise<number | "previous" | "next" | undefined>((resolve) => {
          const menu = native.Menu.buildFromTemplate([
            { label: label(title), enabled: false },
            ...choices.slice(offset, offset + pageSize).map((choice, index) => ({
              label: label(choice),
              click: () => resolve(offset + index),
            })),
            ...(offset > 0 ? [{ label: "Previous items…", click: () => resolve("previous") }] : []),
            ...(offset + pageSize < choices.length
              ? [{ label: "More items…", click: () => resolve("next") }]
              : []),
            { label: "Cancel", click: () => resolve(undefined) },
          ]);
          menu.popup({ window: owner, callback: () => resolve(undefined) });
        });
        if (selected === "previous") offset -= pageSize;
        else if (selected === "next") offset += pageSize;
        else return selected;
      }
      return undefined;
    },
    async notice(message) {
      if (owner.isDestroyed()) return;
      await native.dialog.showMessageBox(owner, { type: "info", message, buttons: ["OK"] });
    },
  };
}
/** Native menus expose references and static statuses only, never credential values. */
export async function makeAutofillMenu(
  target: AutofillTarget,
  service: ReturnType<typeof makeAutofill>,
  ui: AutofillMenuUi,
): Promise<Electron.MenuItemConstructorOptions[]> {
  const action = (operation: () => Promise<void>) => async () => {
    try {
      await ui.restoreFocus();
      await operation();
    } catch (error: unknown) {
      try {
        await ui.notice(
          error instanceof ProtonPassUnavailable
            ? error.message
            : "Proton Pass could not complete this fill. If sharing is paused, clear login fields and resume sharing explicitly.",
        );
      } catch {
        /* Keep the tab private if native UI is unavailable. */
      }
    }
  };
  const linked = await service.linked(target).catch(() => []);
  return [
    {
      label: "Proton Pass",
      submenu: [
        ...(target.privateEntry
          ? [{ label: "Private entry — sharing paused", enabled: false }]
          : []),
        { label: `Linked logins for ${label(target.origin)}`, enabled: false },
        ...linked.flatMap((entry) => [
          {
            label: `Fill ${label(entry.title)}`,
            click: action(() => service.fill(target, entry)),
          },
          {
            label: `Remove linked login: ${label(entry.title)}`,
            click: action(() => service.unlink(target, entry)),
          },
        ]),
        {
          label: "Link a login to this site…",
          click: action(async () => {
            const selected = await service.link(target, async (provider) => {
              const vaults = await provider.vaults();
              const vaultIndex = await ui.choose(
                "Choose a Proton vault",
                vaults.map((entry) => entry.title),
              );
              const vault = vaultIndex === undefined ? undefined : vaults[vaultIndex];
              if (!vault) return;
              const items = await provider.logins(vault.shareId);
              const itemIndex = await ui.choose(
                `Link a login to ${target.origin}`,
                items.map((entry) => entry.title),
              );
              await ui.restoreFocus();
              return itemIndex === undefined ? undefined : items[itemIndex];
            });
            if (selected) await service.fill(target, selected);
          }),
        },
        ...(target.privateEntry
          ? [
              {
                label: "Clear login fields and resume sharing",
                click: action(() => service.clearAndResume(target)),
              },
            ]
          : []),
      ],
    },
  ];
}
