import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { userEnv } from "./term.ts";

// macOS: app bundle name for `open -a`. Elsewhere: CLI on PATH. Add a row to support another editor.
const EDITORS = [
  { id: "vscode", name: "VS Code", app: "Visual Studio Code", cli: "code" },
  { id: "cursor", name: "Cursor", app: "Cursor", cli: "cursor" },
  { id: "windsurf", name: "Windsurf", app: "Windsurf", cli: "windsurf" },
  { id: "devin", name: "Devin", app: "Devin" }, // no CLI: `devin` on PATH is the agent, not an editor
  { id: "zed", name: "Zed", app: "Zed", cli: "zed" },
  { id: "sublime", name: "Sublime Text", app: "Sublime Text", cli: "subl" },
  { id: "vscodium", name: "VSCodium", app: "VSCodium", cli: "codium" },
  { id: "webstorm", name: "WebStorm", app: "WebStorm", cli: "webstorm" },
  { id: "idea", name: "IntelliJ IDEA", app: "IntelliJ IDEA", cli: "idea" },
  { id: "xcode", name: "Xcode", app: "Xcode" },
] as const;

const mac = process.platform === "darwin";

function installed(e: (typeof EDITORS)[number]) {
  if (mac) return [join("/Applications", `${e.app}.app`), join(homedir(), "Applications", `${e.app}.app`)].some(existsSync);
  return "cli" in e && (userEnv().PATH ?? "").split(":").some((d) => d && existsSync(join(d, e.cli)));
}

/** Editors present on this machine, in list order. Checked per call so a fresh install shows up without a restart. */
export const listEditors = () => EDITORS.filter(installed).map(({ id, name }) => ({ id, name }));

const run = (cmd: string, args: string[]) => new Promise<boolean>((res) => execFile(cmd, args, { env: userEnv() }, (err) => res(!err)));

/** Open `abs` in an editor id, "finder" (reveal), or "default" (OS default app). Unknown ids fail. */
export async function openWith(target: string, abs: string, reveal: boolean) {
  if (target === "finder") return run(mac ? "open" : "xdg-open", mac && reveal ? ["-R", abs] : [abs]);
  if (target === "default") return run(mac ? "open" : "xdg-open", [abs]);
  const e = EDITORS.find((x) => x.id === target);
  if (!e) return false;
  if (mac) return run("open", ["-a", e.app, abs]);
  return "cli" in e && run(e.cli, [abs]);
}
