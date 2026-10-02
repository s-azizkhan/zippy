import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Catalog, CatalogItem } from "@zippy/shared";

const run = promisify(execFile);
const HOME = homedir();
const json = (p: string) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
};

const desc = (dir: string) => /^description:\s*(.+)$/m.exec(readFileSync(join(dir, "SKILL.md"), "utf8"))?.[1]?.replace(/^["']|["']$/g, "") ?? "";
const skillsIn = (root: string, prefix: string, source: string): CatalogItem[] => {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((d) => {
    const dir = join(root, d);
    if (!existsSync(join(dir, "SKILL.md"))) return [];
    const name = prefix + d;
    return [{ id: `skill:${name}`, kind: "skill" as const, name, description: desc(realpathSync(dir)), source, defaultOn: true }];
  });
};

const mcpsOf = (servers: Record<string, unknown> | undefined, source: string, defaultOn: boolean): CatalogItem[] =>
  Object.keys(servers ?? {}).map((name) => ({ id: `mcp:${name}`, kind: "mcp", name, description: "", source, defaultOn }));

const DESKTOP = join(HOME, "Library/Application Support/Claude/claude_desktop_config.json");
/** Desktop-only MCP servers, runnable as stdio. */
export const desktopMcps = (): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> => json(DESKTOP).mcpServers ?? {};

export function scanCatalog(): Omit<Catalog, "presets"> {
  const plugins = json(join(HOME, ".claude/plugins/installed_plugins.json")).plugins ?? {};
  const enabled = json(join(HOME, ".claude/settings.json")).enabledPlugins ?? {};
  const fromPlugins = Object.entries<{ installPath: string }[]>(plugins)
    .filter(([key]) => enabled[key])
    .flatMap(([key, [p]]) => skillsIn(join(p!.installPath, "skills"), `${key.split("@")[0]}:`, `plugin ${key}`));
  const code = mcpsOf(json(join(HOME, ".claude.json")).mcpServers, "Claude Code", true);
  const seen = new Set(code.map((m) => m.name));
  const desktop = mcpsOf(desktopMcps(), "Claude Desktop", false).filter((m) => !seen.has(m.name));
  return { items: [...skillsIn(join(HOME, ".claude/skills"), "", "~/.claude/skills"), ...fromPlugins, ...code, ...desktop] };
}

/** Org default, then agent override. */
export const isOn = (item: CatalogItem, ...layers: Record<string, boolean>[]) =>
  layers.reduce((on, l) => l[item.id] ?? on, item.defaultOn);

// Fixed commands only; nothing from the request reaches a shell.
const PRESETS = {
  caveman: {
    name: "caveman",
    description: "Terse caveman-style replies (plugin).",
    installed: () => Object.keys(json(join(HOME, ".claude/plugins/installed_plugins.json")).plugins ?? {}).some((k) => k.startsWith("caveman@")),
    cmds: [["claude", "plugin", "marketplace", "add", "JuliusBrussee/caveman"], ["claude", "plugin", "install", "caveman@caveman"]],
  },
  humanizer: {
    name: "humanizer",
    description: "Strip AI-sounding patterns from text (skill).",
    installed: () => existsSync(join(HOME, ".claude/skills/humanizer")),
    cmds: [["npx", "-y", "skills", "add", "blader/humanizer", "-g", "-y"]],
  },
  rtk: {
    name: "rtk",
    description: "Token-saving CLI proxy for shell commands (CLI + hook).",
    installed: () => existsSync(join(HOME, ".claude/RTK.md")),
    cmds: [["sh", "-c", "command -v rtk >/dev/null || brew install rtk"], ["rtk", "init", "-g", "--auto-patch"]],
  },
} as const;

export const presets = () => Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, description: p.description, installed: p.installed() }));

export async function installPreset(id: string) {
  const p = PRESETS[id as keyof typeof PRESETS];
  if (!p) return null;
  for (const [cmd, ...args] of p.cmds) await run(cmd!, args, { timeout: 300_000 });
  return true;
}
