import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { and, asc, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { KB_KINDS, PRIORITIES, TICKET_STATUSES, httpUrl, type ApprovalPayload, type InboxItem, type QuestionPayload } from "@zippy/shared";
import { agents, comments, db, labels, orgs, terminalTemplates, ticketFolders, tickets, workspaces } from "./db/index.ts";
import { addKnowledge, render, search } from "./kb.ts";
import { termLine } from "./mcp.ts";
import { DOMAIN, domainActive } from "./domain.ts";
import { claudePath, foldersOf } from "./runner.ts";
import { allTerminals, listTerminals, userEnv } from "./term.ts";
import { act, closeTab, connected, DESKTOP_ONLY, evalScript, getTab, listTabs, openTab, readText, settled, snapshot } from "./browser.ts";

// Zippy Hub: the human's whole Zippy (tickets, agents, terminals, knowledge) as one MCP server, registered in Claude Code at user scope
// so any Claude session outside Zippy can drive it. Unlike /mcp (one agent on one ticket), this acts as the human, like the web UI does.
export const HUB_NAME = "zippy-hub";
const CONFIG_FILE = join(homedir(), ".zippy", "hub.json"); // { token, tools: { name: on } } ; 0600, holds the bearer token
// zippy.localhost with no port once the local domain is set up (plain http on loopback, see domain.ts), else zippy.localhost:<port>.
const hubUrl = () => `http://${DOMAIN}${domainActive() ? "" : `:${process.env.PORT ?? 3001}`}/api/mcp/hub`;

type HubConfig = { token?: string; enabled?: boolean; tools?: Record<string, boolean> };
function readConfig(): HubConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(patch: HubConfig) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
}
const readToken = () => readConfig().token ?? null;
function newToken() {
  const token = `zh_${randomUUID().replaceAll("-", "")}`;
  writeConfig({ token });
  return token;
}

// Every hub tool: Settings group, risk, a one-line summary for the user, and the description the AI reads to decide when to call it.
// read: no side effects. write: changes tickets/terminals the way the UI would. danger: hard to undo; off until the user enables it.
type Risk = "read" | "write" | "danger";
type ToolInfo = { group: string; risk: Risk; summary: string; ai: string };
const T = (group: string, risk: Risk, summary: string, ai: string): ToolInfo => ({ group, risk, summary, ai });
export const HUB_TOOLS: Record<string, ToolInfo> = {
  zippy_overview: T("Board", "read", "Orgs, folders, agents, labels, pipelines, what is running", "Map of the user's Zippy: orgs, working folders (repos and paths), agents with their roles, labels, pipelines, terminal templates, what agents are running now and how much waits in the inbox. Call this FIRST in any Zippy task: the names it returns are what the other tools take (folder, agent handle, label, pipeline, template)."),
  list_tickets: T("Board", "read", "Search and filter tickets", "Find tickets on the user's board. Use when the user asks what is open, assigned to someone, in review, blocked, about a topic, or in a repo, or when you need a ticket's identifier. Filters combine. Returns one line per ticket: identifier, status, priority, title, assignee, folders, labels, PR state."),
  get_ticket: T("Board", "read", "Full ticket with timeline", "Everything about one ticket: description, folders with worktree path, branch and PR, sub-issues, related tickets, agents and cost, and the timeline (comments, agent questions and approvals with their comment ids, handoffs, PRs, test results). Use before acting on a ticket, to see what an agent did or asked, or to find the worktree path to read its code."),
  create_ticket: T("Tickets", "write", "Create tickets and sub-issues", "Create a ticket on the user's board. Use when the user wants work tracked or handed to an agent (\"make a ticket\", \"have Zippy fix X\"). Write a clear title and a markdown body with context and acceptance criteria. Giving folders plus an agent assignee starts that agent immediately; omit assignee to only file it."),
  update_ticket: T("Tickets", "write", "Change status, assignee, priority, labels, folders", "Change fields of an existing ticket: status, title, description, priority, labels, folders, assignee, archive. Only what you pass changes. Assigning an agent starts it. Use to triage, move status, or mark done after the user reviewed."),
  comment: T("Tickets", "write", "Comment as the user, @mention agents", "Post a comment on a ticket as the user. It reaches agents: @handle mentions start those agents with the comment as their instruction; otherwise the assignee agent picks it up. Use to give an agent feedback, follow-up instructions or context."),
  run_agent: T("Agents", "write", "Start or nudge an agent on a ticket", "Start an agent on a ticket, optionally with an instruction. Default agent: the assignee. Use when the user says to have an agent work, continue or redo something. The agent runs in the background in Zippy; follow progress with get_ticket."),
  cancel_agent: T("Agents", "write", "Stop an agent's current turn", "Stop an agent that is working on a ticket right now. Use when the user wants it halted or it is going in the wrong direction."),
  zippy_inbox: T("Inbox", "read", "What waits on the user", "Everything waiting on the user across the board: agent questions, permission approvals, pipeline stages awaiting sign-off, tickets ready for review, blocked tickets and proposed learnings, each with the ids and options to act on it. Use when the user asks what needs their attention, or before answering on their behalf."),
  answer_question: T("Inbox", "write", "Answer an agent's question", "Answer a question an agent asked (comment id from zippy_inbox or get_ticket); the agent resumes with it. Only answer with what the user decided or clearly told you; ask the user when unsure."),
  decide_approval: T("Inbox", "write", "Allow or deny an agent's permission request", "Allow or reject an agent's pending permission request (a tool call or terminal action) by optionId. Only with the user's explicit go-ahead."),
  decide_learning: T("Inbox", "write", "Accept or dismiss a proposed learning", "Accept (saved to the org context agents read) or dismiss a lesson an agent proposed. Only on the user's say."),
  start_pipeline: T("Agents", "write", "Run a multi-agent pipeline on a ticket", "Run a pipeline (a chain of agents such as validate, plan, implement, review, open PR) on a ticket that has a working folder. Use when the user wants a ticket built end to end by agents."),
  advance_pipeline: T("Agents", "write", "Approve or send back a pipeline stage", "Sign off a pipeline stage waiting on the user: pass moves to the next stage, fail sends it back with an optional note. Only with the user's decision."),
  ticket_diff: T("Code", "read", "Branch diff of a ticket", "The code changes on a ticket's branch versus base, per folder: file list with +/- counts, or full patches with patch=true. Use to review what an agent changed before merge or to answer questions about the change."),
  run_tests: T("Code", "write", "Run folder tests on a ticket", "Run each folder's configured test command in the ticket's worktree. Results arrive later as test cards in get_ticket. Use to verify an agent's work."),
  merge_ticket: T("Code", "danger", "Squash-merge the ticket's PRs", "Squash-merge every open PR on the ticket on GitHub and mark it done. Irreversible. Only when the user explicitly asked to merge this ticket."),
  kb_search: T("Knowledge", "read", "Search the knowledge base", "Search the org knowledge base: commands, gotchas, conventions and links the user and agents saved. Use when working in the user's repos and you need project-specific know-how."),
  kb_add: T("Knowledge", "write", "Save a lesson for agents", "Save one durable, non-obvious lesson (a command, gotcha, preference, link) that Zippy's agents will use on future tickets. Use when the user states a preference or you learn something about their repos worth keeping. Not for facts obvious from the code."),
  list_terminals: T("Terminals", "read", "List live terminals", "Live terminals in Zippy with id, state (idle, running a process, exited), title, command, folder and cwd. Use to find a running dev server, watcher or agent shell before reading or typing into it."),
  open_terminal: T("Terminals", "write", "Open a shell the user sees live", "Open a persistent shell in a working folder (or a ticket's worktree), optionally running a command. It shows live in Zippy and keeps running after you finish. Use for long-running things the user should watch or keep: dev servers, watchers, queues, log tails. For quick one-off commands use your own shell instead."),
  terminal_read: T("Terminals", "read", "Read terminal output", "Last lines of a terminal's output plus its state. Use to check a dev server's logs, a command's result, or errors in a running process."),
  terminal_write: T("Terminals", "write", "Type into a terminal", "Type into a live terminal (Enter added unless enter=false; raw keys like Ctrl-C as escape codes). Use to run commands in an existing shell, restart a process with Ctrl-C then up-arrow, or answer a prompt. Read the terminal after."),
  update_terminal: T("Terminals", "write", "Rename or tag a terminal", "Rename a terminal or set its tags (@agent handles, ticket identifiers) so the user can find it."),
  restart_terminal: T("Terminals", "write", "Restart a terminal", "Restart a terminal in place (same id); its start command runs again. Use when a dev server or watcher died or must reload."),
  close_terminal: T("Terminals", "write", "Close a terminal", "Close a terminal and kill its process. Use when the user is done with it or to stop a server you started."),
  run_terminal_template: T("Terminals", "write", "Run a saved terminal setup", "Run a saved terminal template: opens one shell per step in its folder with its command (e.g. backend and frontend dev servers together). Use when the user wants their usual environment up. Names come from zippy_overview."),
  list_ports: T("System", "read", "Listening ports and their processes", "TCP ports listening on this machine with pid and command. Use to find what occupies a port or whether a dev server is up."),
  browser_tabs: T("Browser", "read", "List tabs in the Zippy browser", "List the browser tabs open in the Zippy desktop app: id, whose tab (the user's or an agent's), title, URL. Tabs share the user's signed-in session (Gmail, Slack, dashboards…). Use when the user refers to a page open in Zippy."),
  browser_open: T("Browser", "write", "Open a page in a new tab", "Open a URL in a new tab of the Zippy browser and get its snapshot. Tabs share the user's signed-in session, so you see sites as the user does, and the user watches it on the Browser page. Use for pages behind the user's logins; for public pages your own fetch tools are fine."),
  browser_snapshot: T("Browser", "read", "Headings and clickable elements of a tab", "List a tab's headings and interactive elements, each with a ref like [e12] for browser_click / browser_type. Refs change with every snapshot."),
  browser_read: T("Browser", "read", "Read a tab's text", "Read the visible text of a tab, or of one element by ref (e.g. an email body). Long pages come in chunks: pass offset to continue."),
  browser_navigate: T("Browser", "write", "Load a URL, back, forward, reload", "Load a URL in a tab, or go back / forward / reload. Returns the new snapshot."),
  browser_click: T("Browser", "write", "Click in a tab", "Click an element by ref from the latest snapshot. Returns the new snapshot. Acts as the user in their signed-in accounts: only do what the user asked."),
  browser_type: T("Browser", "write", "Type into a tab", "Type into a text field or editor by ref (replaces its text unless clear=false; for a <select>, pass the option's text). submit=true presses Enter after. Returns the new snapshot. Acts as the user: only send what the user asked."),
  browser_press: T("Browser", "write", "Press a key in a tab", 'Press a key, optionally on an element by ref (default: the focused one). Examples: "Enter", "Escape", "Tab", "PageDown", "Meta+Enter". Returns the new snapshot.'),
  browser_eval: T("Browser", "danger", "Run JavaScript in a tab", "Run JavaScript in a tab as a function body (use return; await works). Returns the JSON result. Runs inside the user's signed-in session; only for what the other browser tools can't do."),
  browser_close: T("Browser", "write", "Close a tab", "Close a browser tab. Close tabs you opened when done; close the user's or an agent's tab only when the user asks."),
  kill_port: T("System", "danger", "Kill whatever listens on a port", "Kill the process listening on a port (SIGTERM, force for SIGKILL). Only when the user asked to free that port."),
};
const enabled = (name: string, cfg = readConfig()) => cfg.tools?.[name] ?? HUB_TOOLS[name]!.risk !== "danger";

// Claude Desktop's config only takes stdio servers: bridge to the HTTP hub with mcp-remote. The token sits in a 0600 header file,
// not in the config or the process list, so a token rotation needs no Desktop config change.
const DESKTOP_DIR = join(homedir(), "Library/Application Support/Claude");
const DESKTOP_CONFIG = join(DESKTOP_DIR, "claude_desktop_config.json");
const HEADER_FILE = join(homedir(), ".zippy", "hub-header");
const readJson = (p: string) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
};
const desktopArgs = () => ["-y", "mcp-remote@0.14.3", hubUrl(), "--allow-http", "--header-file", HEADER_FILE];
function writeDesktop(token: string | null) {
  if (!existsSync(DESKTOP_DIR)) return; // Desktop not installed
  const cfg = readJson(DESKTOP_CONFIG);
  const servers = { ...cfg.mcpServers };
  if (token) {
    writeFileSync(HEADER_FILE, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
    chmodSync(HEADER_FILE, 0o600);
    // Desktop launches with a bare PATH: absolute npx, and our PATH so its `#!/usr/bin/env node` resolves.
    const PATH = userEnv().PATH ?? "";
    const npx = PATH.split(":").map((d) => join(d, "npx")).find((f) => existsSync(f)) ?? "npx";
    servers[HUB_NAME] = { command: npx, args: desktopArgs(), env: { PATH } };
  } else {
    if (!servers[HUB_NAME]) return;
    delete servers[HUB_NAME];
  }
  writeFileSync(DESKTOP_CONFIG, JSON.stringify({ ...cfg, mcpServers: servers }, null, 2));
}

/** Hub registration in Claude Code (~/.claude.json) and Claude Desktop: registered, or current (this URL and token everywhere). */
function registration(token: string | null) {
  const code: { url?: string; headers?: Record<string, string> } | undefined = readJson(join(homedir(), ".claude.json")).mcpServers?.[HUB_NAME];
  const desktop: { args?: string[] } | undefined = existsSync(DESKTOP_DIR) ? readJson(DESKTOP_CONFIG).mcpServers?.[HUB_NAME] : undefined;
  let header = "";
  try {
    header = readFileSync(HEADER_FILE, "utf8").trim();
  } catch {}
  const codeOk = !!code && code.url === hubUrl() && code.headers?.Authorization === `Bearer ${token}`;
  const desktopOk = !existsSync(DESKTOP_DIR) || (!!desktop && desktop.args?.includes(hubUrl()) === true && header === `Authorization: Bearer ${token}`);
  return { registered: !!code || !!desktop, current: codeOk && desktopOk, desktop: existsSync(DESKTOP_DIR) ? !!desktop : null };
}

const run = promisify(execFile);
const addArgs = (token: string) => ["mcp", "add", "--transport", "http", "--scope", "user", HUB_NAME, hubUrl(), "--header", `Authorization: Bearer ${token}`];
async function register(token: string) {
  const claude = claudePath ?? "claude";
  await run(claude, ["mcp", "remove", "--scope", "user", HUB_NAME], { env: userEnv() }).catch(() => {}); // absent on first register
  // execFile's error message carries the argv, token included: surface only stderr.
  await run(claude, addArgs(token), { env: userEnv() }).catch((e: { stderr?: string }) => {
    throw new Error(`claude mcp add failed: ${e.stderr?.trim().replaceAll(token, "***") || "unknown error"}`);
  });
  writeDesktop(token);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const ago = (d: Date | string) => {
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

function buildServer(app: Hono) {
  const server = new McpServer(
    { name: HUB_NAME, version: "0.1.0" },
    {
      instructions: [
        "Zippy is the user's local work hub: a ticket board where AI agents (\"Zippers\", addressed as @handle) work tickets in git worktrees and open PRs, plus live terminals the user watches in the Zippy app.",
        "Use these tools when the user mentions Zippy, tickets/issues/board (identifiers like COM-123), their agents or Zippers, the inbox, pipelines, or terminals/dev servers running in Zippy. Not for the code in your current directory unless it is one of Zippy's folders.",
        "Start with zippy_overview: it lists the folder, agent, label, pipeline and template names the other tools take.",
        "Agents run in the background: creating a ticket with an agent assignee, run_agent, or an @mention in a comment starts one; follow up with get_ticket. Questions and approvals agents raise land in zippy_inbox.",
        "You act as the user. Answer agent questions, approve permissions, advance pipelines or merge only on the user's explicit decision.",
        "Browser tools drive tabs in the Zippy desktop app, signed in as the user: use them for pages behind the user's logins, and act there only as the user asked.",
        "Use open_terminal for long-running processes the user should see (dev servers, watchers); use your own shell for one-off commands.",
        "Some tools may be switched off by the user in Zippy Settings; do not try to work around a missing tool.",
      ].join("\n"),
    },
  );

  const cfg = readConfig();
  // Same signature as registerTool; skips tools the user switched off and fills description/annotations from HUB_TOOLS.
  const tool = ((name: string, config: { inputSchema: z.ZodRawShape }, cb: never) => {
    const t = HUB_TOOLS[name]!;
    if (!enabled(name, cfg)) return;
    server.registerTool(name, { ...config, title: t.summary, description: t.ai, annotations: { readOnlyHint: t.risk === "read", destructiveHint: t.risk === "danger", openWorldHint: false } }, cb);
  }) as unknown as typeof server.registerTool;

  // Internal call into the REST API: same validation and side effects (agent runs, Linear sync, live UI updates) as the web app.
  const call = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await app.request(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await res.text();
    if (!res.ok) {
      const err = (() => { try { return JSON.parse(raw); } catch { return { error: raw }; } })();
      throw new Error(err.issues?.[0] ? `${err.issues[0].path.join(".")}: ${err.issues[0].message}` : err.error || `${res.status} ${res.statusText}`);
    }
    return (res.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : raw) as T;
  };

  const orgArg = z.string().optional().describe("Org key, name or id; default: the first org");
  async function orgOf(key?: string) {
    const all = await db.select().from(orgs).orderBy(asc(orgs.createdAt));
    const o = key ? all.find((x) => [x.key, x.name, x.id].some((v) => v.toLowerCase() === key.toLowerCase())) : all[0];
    if (!o) throw new Error(key ? `No org "${key}". Orgs: ${all.map((x) => x.key).join(", ")}` : "No organization yet. Create one in Zippy first.");
    return o;
  }
  async function ticketOf(id: string, org?: string) {
    const o = org ? await orgOf(org) : undefined;
    const uuid = /^[0-9a-f-]{36}$/i.test(id);
    const rows = await db.select().from(tickets).where(and(uuid ? eq(tickets.id, id) : eq(tickets.identifier, id.toUpperCase()), isNull(tickets.deletedAt), o ? eq(tickets.orgId, o.id) : undefined));
    if (!rows.length) throw new Error(`No ticket ${id}.`);
    if (rows.length > 1) throw new Error(`${id} exists in several orgs; pass org.`);
    return rows[0]!;
  }
  const team = (orgId: string) => db.select().from(agents).where(eq(agents.orgId, orgId));
  async function agentOf(orgId: string, handle: string) {
    const all = await team(orgId);
    const a = all.find((x) => x.handle === handle.replace(/^@/, ""));
    if (!a) throw new Error(`No agent @${handle.replace(/^@/, "")}. Agents: ${all.map((x) => `@${x.handle}`).join(", ")}`);
    return a;
  }
  async function foldersByName(orgId: string, names: string[]) {
    const all = await db.select().from(workspaces).where(eq(workspaces.orgId, orgId));
    return names.map((n) => {
      const w = all.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (!w) throw new Error(`No folder "${n}". Folders: ${all.map((x) => x.name).join(", ")}`);
      return w;
    });
  }
  async function labelsByName(orgId: string, names: string[]) {
    const all = await db.select().from(labels).where(eq(labels.orgId, orgId));
    return names.map((n) => {
      const l = all.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (!l) throw new Error(`No label "${n}". Labels: ${all.map((x) => x.name).join(", ")}`);
      return l.id;
    });
  }
  /** Assignee field for create/update: agent handle, "me" (the human) or "none". */
  async function assigneeOf(orgId: string, who: string) {
    if (who === "none") return { assigneeAgentId: null, assigneeHuman: false };
    if (who === "me") return { assigneeAgentId: null, assigneeHuman: true };
    return { assigneeAgentId: (await agentOf(orgId, who)).id, assigneeHuman: false };
  }

  tool(
    "zippy_overview",
    { inputSchema: { org: orgArg } },
    async ({ org }) => {
      const o = await orgOf(org);
      const all = await db.select({ key: orgs.key, name: orgs.name }).from(orgs);
      const [ws, team_, lbls, pipes, tpls, running, inbox] = await Promise.all([
        db.select().from(workspaces).where(eq(workspaces.orgId, o.id)),
        team(o.id),
        db.select().from(labels).where(eq(labels.orgId, o.id)),
        call<{ name: string; autoStart: boolean; stages: { name: string }[] }[]>("GET", `/orgs/${o.id}/pipelines`),
        db.select().from(terminalTemplates).where(eq(terminalTemplates.orgId, o.id)),
        call<{ agentId: string; ticket: { identifier: string; title: string; kind: string } }[]>("GET", `/orgs/${o.id}/running`),
        call<InboxItem[]>("GET", `/orgs/${o.id}/inbox`),
      ]);
      const handle = new Map(team_.map((a) => [a.id, a.handle]));
      const role = (md: string) => md.split("\n").find((l, i) => i > 0 && l.trim())?.trim().slice(0, 120) ?? "";
      return text(
        [
          `Org ${o.name} (${o.key})${all.length > 1 ? `; others: ${all.filter((x) => x.key !== o.key).map((x) => x.key).join(", ")}` : ""}${o.profile.handle ? `; you are @${o.profile.handle}` : ""}`,
          `\nFolders:\n${ws.map((w) => `- ${w.name}: ${w.path} (base ${w.baseBranch}${w.testCmd ? `, test: ${w.testCmd}` : ""})`).join("\n") || "- none"}`,
          `\nAgents:\n${team_.map((a) => `- @${a.handle} ${a.name}${a.canWrite ? "" : " (read-only)"}: ${role(a.rolePromptMd)}`).join("\n") || "- none"}`,
          `\nLabels: ${lbls.map((l) => l.name).join(", ") || "none"}`,
          `Pipelines: ${pipes.map((p) => `${p.name}${p.autoStart ? " (auto-start)" : ""} [${p.stages.map((s) => s.name).join(" → ")}]`).join("; ") || "none"}`,
          `Terminal templates: ${tpls.map((t) => t.name).join(", ") || "none"}`,
          `\nRunning now: ${running.map((r) => `@${handle.get(r.agentId)} on ${r.ticket.kind === "chat" ? `chat "${r.ticket.title}"` : r.ticket.identifier}`).join(", ") || "nothing"}`,
          `Inbox: ${inbox.length} item(s) waiting on the user${inbox.length ? "; see zippy_inbox" : ""}`,
        ].join("\n"),
      );
    },
  );

  tool(
    "list_tickets",
    {
      inputSchema: {
        org: orgArg,
        status: z.array(z.enum(TICKET_STATUSES)).optional(),
        assignee: z.string().optional().describe('Agent handle, "me" or "none"'),
        label: z.string().optional(),
        folder: z.string().optional(),
        query: z.string().optional().describe("Matches title, body or identifier"),
        archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ org, status, assignee, label, folder, query, archived, limit }) => {
      const o = await orgOf(org);
      const team_ = await team(o.id);
      const handle = new Map(team_.map((a) => [a.id, a.handle]));
      const lbls = new Map((await db.select().from(labels).where(eq(labels.orgId, o.id))).map((l) => [l.id, l.name]));
      const ws = new Map((await db.select().from(workspaces).where(eq(workspaces.orgId, o.id))).map((w) => [w.id, w.name]));
      let rows = await db
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.orgId, o.id),
            eq(tickets.kind, "ticket"),
            isNull(tickets.deletedAt),
            eq(tickets.archived, archived),
            status?.length ? inArray(tickets.status, status) : undefined,
            query ? or(ilike(tickets.title, `%${query}%`), ilike(tickets.body, `%${query}%`), ilike(tickets.identifier, `%${query}%`)) : undefined,
          ),
        )
        .orderBy(desc(tickets.updatedAt));
      if (assignee) {
        const a = assignee === "me" || assignee === "none" ? null : await agentOf(o.id, assignee);
        rows = rows.filter((t) => (assignee === "me" ? t.assigneeHuman : assignee === "none" ? !t.assigneeHuman && !t.assigneeAgentId : t.assigneeAgentId === a!.id));
      }
      if (label) {
        const [id] = await labelsByName(o.id, [label]);
        rows = rows.filter((t) => t.labelIds.includes(id!));
      }
      const folders = rows.length ? await db.select().from(ticketFolders).where(inArray(ticketFolders.ticketId, rows.map((t) => t.id))) : [];
      if (folder) {
        const [w] = await foldersByName(o.id, [folder]);
        const on = new Set(folders.filter((f) => f.workspaceId === w!.id).map((f) => f.ticketId));
        rows = rows.filter((t) => on.has(t.id));
      }
      const total = rows.length;
      const lines = rows.slice(0, limit).map((t) => {
        const fs = folders.filter((f) => f.ticketId === t.id);
        const who = t.assigneeAgentId ? `@${handle.get(t.assigneeAgentId)}` : t.assigneeHuman ? "@me" : "";
        const prs = fs.filter((f) => f.prUrl).map((f) => `PR ${f.prState?.toLowerCase()}`);
        return [`${t.identifier} [${t.status}]${t.priority !== "none" ? ` (${t.priority})` : ""} ${t.title}`, who, fs.map((f) => ws.get(f.workspaceId)).join(","), t.labelIds.map((l) => `#${lbls.get(l)}`).join(" "), ...prs, ago(t.updatedAt)]
          .filter(Boolean)
          .join(" · ");
      });
      return text(lines.length ? `${lines.join("\n")}${total > limit ? `\n… ${total - limit} more` : ""}` : "No tickets match.");
    },
  );

  tool(
    "get_ticket",
    { inputSchema: { id: z.string().describe("Identifier, e.g. ZIP-12"), org: orgArg, timeline: z.number().int().min(0).max(200).default(40).describe("Latest timeline entries to include") } },
    async ({ id, org, timeline }) => {
      const t = await ticketOf(id, org);
      type Detail = { related: { identifier: string; title: string; status: string }[]; parent: { identifier: string; title: string } | null; children: { identifier: string; title: string; status: string }[]; comments: (typeof comments.$inferSelect)[]; sessions: { agentId: string; running: boolean; costUsd: number }[]; pipeline: { name: string; stages: { id: string; name: string }[] } | null };
      const d = await call<Detail>("GET", `/tickets/${t.id}`);
      const team_ = await team(t.orgId);
      const handle = new Map(team_.map((a) => [a.id, a.handle]));
      const lbls = new Map((await db.select().from(labels).where(eq(labels.orgId, t.orgId))).map((l) => [l.id, l.name]));
      const dirs = await foldersOf(t.id);
      const who = (agentId: string | null) => (agentId ? `@${handle.get(agentId) ?? "agent"}` : "user");
      const entry = (c: Detail["comments"][number]) => {
        const p = c.payload as Record<string, any>;
        const head = `[${ago(c.createdAt)}] ${who(c.agentId)}`;
        switch (c.kind) {
          case "text": return `${head}: ${p.text}`;
          case "plan": return `${head} plan: ${JSON.stringify(p.entries ?? p).slice(0, 400)}`;
          case "question": { const q = p as QuestionPayload; return `${head} asks (comment ${c.id}): ${q.question}\n  options: ${q.options.join(" | ")}${q.recommended ? ` (recommends ${q.recommended})` : ""}${q.answer ? `\n  answered: ${q.answer}` : "\n  UNANSWERED: use answer_question"}`; }
          case "approval": { const a = p as ApprovalPayload; return `${head} needs approval (comment ${c.id}): ${a.title}\n  options: ${a.options.map((o) => `${o.optionId}=${o.name}`).join(", ")}${a.decision !== undefined ? `\n  decided: ${a.decision ?? "cancelled"}` : "\n  PENDING: use decide_approval"}`; }
          case "handoff": return `${head} handoff ${p.verdict} (${p.stage}${p.next ? ` → ${p.next}` : ""}): ${p.summary}${p.notes ? `\n  ${p.notes}` : ""}`;
          case "pr": return `${head} opened PR ${p.url} ${p.title}`;
          case "test": return `${head} tests ${p.ok ? "passed" : "FAILED"} in ${p.folder}: ${p.command}${p.ok ? "" : `\n${String(p.output).slice(-1500)}`}`;
          case "status": return `${head} status ${p.from ?? "?"} → ${p.to}`;
          case "stage": return `${head} stage ${p.name}${p.loop ? ` (loop ${p.loop})` : ""}`;
          case "error": return `${head} ERROR: ${p.message ?? p.text ?? JSON.stringify(p)}`;
          case "draft": return `${head} proposed ticket: ${p.title}`;
          case "learning": return `${head} learning: ${p.text}`;
          default: return null; // tool calls: noise here
        }
      };
      const shown = d.comments.map((c) => entry(c)).filter(Boolean).slice(timeline ? -timeline : Infinity); // slice(-0) would be everything
      const stage = t.stageId && d.pipeline?.stages.find((s) => s.id === t.stageId)?.name;
      return text(
        [
          `${t.identifier}: ${t.title}`,
          `Status ${t.status} · priority ${t.priority} · assignee ${t.assigneeAgentId ? who(t.assigneeAgentId) : t.assigneeHuman ? "me (user)" : "none"}${t.labelIds.length ? ` · labels ${t.labelIds.map((l) => lbls.get(l)).join(", ")}` : ""}${t.archived ? " · ARCHIVED" : ""}`,
          d.pipeline ? `Pipeline ${d.pipeline.name}${stage ? `, stage ${stage}` : ""}` : "",
          t.linearUrl ? `Linear: ${t.linearUrl}` : "",
          d.parent ? `Parent: ${d.parent.identifier} ${d.parent.title}` : "",
          d.children.length ? `Sub-issues:\n${d.children.map((c) => `- ${c.identifier} [${c.status}] ${c.title}`).join("\n")}` : "",
          d.related.length ? `Related: ${d.related.map((r) => `${r.identifier} [${r.status}]`).join(", ")}` : "",
          `Folders:\n${dirs.map(({ folder: f, ws }) => `- ${ws.name}: ${f.worktreePath ?? ws.path}${f.branch ? ` (branch ${f.branch})` : ""}${f.prUrl ? ` PR ${f.prState} ${f.prUrl}` : ""}`).join("\n") || "- none"}`,
          d.sessions.length ? `Agents: ${d.sessions.map((s) => `${who(s.agentId)}${s.running ? " (working now)" : ""} $${s.costUsd.toFixed(2)}`).join(", ")}` : "",
          `\n${t.body || "(no description)"}`,
          shown.length ? `\nTimeline:\n${shown.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  const ticketFields = {
    title: z.string().min(1).max(200),
    body: z.string().describe("Markdown: context, scope, acceptance criteria"),
    folders: z.array(z.string()).describe("Working folder names (repos) the work happens in"),
    assignee: z.string().describe('Agent handle (starts it working), "me" or "none"'),
    priority: z.enum(PRIORITIES),
    labels: z.array(z.string()).describe("Label names"),
    status: z.enum(TICKET_STATUSES),
  };
  tool(
    "create_ticket",
    {
      inputSchema: { org: orgArg, ...ticketFields, body: ticketFields.body.default(""), folders: ticketFields.folders.optional(), assignee: ticketFields.assignee.optional(), priority: ticketFields.priority.optional(), labels: ticketFields.labels.optional(), status: ticketFields.status.optional(), parent: z.string().optional().describe("Parent ticket identifier: makes this a sub-issue") },
    },
    async ({ org, title, body, folders, assignee, priority, labels: ls, status, parent }) => {
      const o = await orgOf(org);
      const parentId = parent ? (await ticketOf(parent, o.id)).id : null; // resolve before creating, so a bad parent creates nothing
      const who = assignee ? await assigneeOf(o.id, assignee) : {};
      const input = { title, body, priority, status, workspaceIds: (await foldersByName(o.id, folders ?? [])).map((w) => w.id), labelIds: await labelsByName(o.id, ls ?? []), ...who };
      const t = await call<{ id: string; identifier: string; pipelineId: string | null }>("POST", `/orgs/${o.id}/tickets`, input);
      if (parentId) await db.update(tickets).set({ parentId }).where(eq(tickets.id, t.id)); // the create route takes no parent
      const start = "assigneeAgentId" in who && who.assigneeAgentId && !t.pipelineId; // an auto-start pipeline already runs its own agents
      if (start) await call("POST", `/tickets/${t.id}/run`, { agentId: who.assigneeAgentId });
      return text(`Created ${t.identifier}${t.pipelineId ? "; pipeline started" : start ? `; @${assignee!.replace(/^@/, "")} started` : ""}.`);
    },
  );

  tool(
    "update_ticket",
    {
      inputSchema: { id: z.string(), org: orgArg, title: ticketFields.title.optional(), body: ticketFields.body.optional(), folders: ticketFields.folders.optional(), assignee: ticketFields.assignee.optional(), priority: ticketFields.priority.optional(), labels: ticketFields.labels.optional(), status: ticketFields.status.optional(), archived: z.boolean().optional() },
    },
    async ({ id, org, folders, assignee, labels: ls, ...rest }) => {
      const t = await ticketOf(id, org);
      const patch = {
        ...rest,
        ...(folders && { workspaceIds: (await foldersByName(t.orgId, folders)).map((w) => w.id) }),
        ...(ls && { labelIds: await labelsByName(t.orgId, ls) }),
        ...(assignee && (await assigneeOf(t.orgId, assignee))),
      };
      if (!Object.keys(patch).length) return text("Nothing to change.");
      await call("PATCH", `/tickets/${t.id}`, patch);
      return text(`Updated ${t.identifier}.`);
    },
  );

  tool(
    "comment",
    { inputSchema: { id: z.string(), org: orgArg, body: z.string().min(1), replyTo: z.string().uuid().optional().describe("Comment id to reply to") } },
    async ({ id, org, body, replyTo }) => {
      const t = await ticketOf(id, org);
      await call("POST", `/tickets/${t.id}/comments`, { body, parentId: replyTo ?? null });
      return text(`Commented on ${t.identifier}.`);
    },
  );

  tool(
    "run_agent",
    { inputSchema: { id: z.string(), org: orgArg, agent: z.string().optional(), message: z.string().optional().describe("Instruction; default: start work") } },
    async ({ id, org, agent, message }) => {
      const t = await ticketOf(id, org);
      const a = agent ? await agentOf(t.orgId, agent) : t.assigneeAgentId ? (await team(t.orgId)).find((x) => x.id === t.assigneeAgentId)! : null;
      if (!a) return text("No assignee; pass agent.");
      if (message) await call("POST", `/tickets/${t.id}/comments`, { body: `@${a.handle} ${message}`, parentId: null });
      else await call("POST", `/tickets/${t.id}/run`, { agentId: a.id });
      return text(`@${a.handle} is working on ${t.identifier}. Follow with get_ticket.`);
    },
  );

  tool(
    "cancel_agent",
    { inputSchema: { id: z.string(), org: orgArg, agent: z.string() } },
    async ({ id, org, agent }) => {
      const t = await ticketOf(id, org);
      await call("POST", `/tickets/${t.id}/cancel`, { agentId: (await agentOf(t.orgId, agent)).id });
      return text("Cancelled.");
    },
  );

  tool(
    "zippy_inbox",
    { inputSchema: { org: orgArg } },
    async ({ org }) => {
      const o = await orgOf(org);
      const items = await call<InboxItem[]>("GET", `/orgs/${o.id}/inbox`);
      const handle = new Map((await team(o.id)).map((a) => [a.id, a.handle]));
      const how: Record<InboxItem["kind"], string> = { question: "answer_question", approval: "decide_approval", gate: "advance_pipeline", review: "merge_ticket or update_ticket status=done", blocked: "comment", learning: "decide_learning" };
      return text(
        items.length
          ? items
              .map((i) => `${i.kind.toUpperCase()} ${i.ticket.identifier} ${i.ticket.title}${i.agentId ? ` · @${handle.get(i.agentId)}` : ""} · ${ago(i.createdAt)}\n  ${i.title}${i.detail ? `\n  ${i.detail.slice(0, 300)}` : ""}${i.commentId ? `\n  comment ${i.commentId}` : ""}${i.options ? `\n  options: ${i.options.map((x) => (x.id === x.label ? x.id : `${x.id}=${x.label}`)).join(" | ")}` : ""}\n  act with ${how[i.kind]}`)
              .join("\n\n")
          : "Inbox empty.",
      );
    },
  );

  tool(
    "answer_question",
    { inputSchema: { commentId: z.string().uuid(), answer: z.string().min(1) } },
    async ({ commentId, answer }) => (await call("POST", `/comments/${commentId}/answer`, { answer }), text("Answered; the agent resumes.")),
  );
  tool(
    "decide_approval",
    { inputSchema: { commentId: z.string().uuid(), optionId: z.string() } },
    async ({ commentId, optionId }) => (await call("POST", `/approvals/${commentId}`, { optionId }), text("Decided.")),
  );
  tool(
    "decide_learning",
    { inputSchema: { commentId: z.string().uuid(), accept: z.boolean() } },
    async ({ commentId, accept }) => (await call("POST", `/comments/${commentId}/learning`, { accept }), text(accept ? "Added." : "Dismissed.")),
  );

  tool(
    "start_pipeline",
    { inputSchema: { id: z.string(), org: orgArg, pipeline: z.string().describe("Pipeline name") } },
    async ({ id, org, pipeline }) => {
      const t = await ticketOf(id, org);
      const all = await call<{ id: string; name: string }[]>("GET", `/orgs/${t.orgId}/pipelines`);
      const p = all.find((x) => x.name.toLowerCase() === pipeline.toLowerCase());
      if (!p) return text(`No pipeline "${pipeline}". Pipelines: ${all.map((x) => x.name).join(", ")}`);
      await call("POST", `/tickets/${t.id}/pipeline`, { pipelineId: p.id });
      return text(`${p.name} started on ${t.identifier}.`);
    },
  );
  tool(
    "advance_pipeline",
    { inputSchema: { id: z.string(), org: orgArg, verdict: z.enum(["pass", "fail"]), note: z.string().optional() } },
    async ({ id, org, verdict, note }) => {
      const t = await ticketOf(id, org);
      await call("POST", `/tickets/${t.id}/advance`, { verdict, note });
      return text(`Stage ${verdict === "pass" ? "approved" : "sent back"}.`);
    },
  );

  tool(
    "ticket_diff",
    { inputSchema: { id: z.string(), org: orgArg, patch: z.boolean().default(false), path: z.string().optional().describe("Only files whose path contains this") } },
    async ({ id, org, patch, path }) => {
      const t = await ticketOf(id, org);
      const diffs = await call<{ folder: string; branch: string | null; base: string; error?: string; files: { path: string; additions: number; deletions: number; risky: boolean; patch: string }[] }[]>("GET", `/tickets/${t.id}/diff`);
      return text(
        diffs
          .map((d) => {
            const files = d.files.filter((f) => !path || f.path.includes(path));
            return `${d.folder}: ${d.branch ?? "no branch"} vs ${d.base}${d.error ? ` (${d.error})` : ""}\n${files.map((f) => (patch ? f.patch : `  ${f.path} +${f.additions} -${f.deletions}${f.risky ? " (protected)" : ""}`)).join("\n") || "  no changes"}`;
          })
          .join("\n\n") || "No folders.",
      );
    },
  );
  tool(
    "run_tests",
    { inputSchema: { id: z.string(), org: orgArg } },
    async ({ id, org }) => {
      const t = await ticketOf(id, org);
      const r = await call<{ started: string[] }>("POST", `/tickets/${t.id}/tests`);
      return text(`Tests started in ${r.started.join(", ")}.`);
    },
  );
  tool(
    "merge_ticket",
    { inputSchema: { id: z.string(), org: orgArg } },
    async ({ id, org }) => {
      const t = await ticketOf(id, org);
      await call("POST", `/tickets/${t.id}/merge`);
      return text(`Merged ${t.identifier}; marked done.`);
    },
  );

  tool(
    "kb_search",
    { inputSchema: { org: orgArg, query: z.string().min(2), folder: z.string().optional() } },
    async ({ org, query, folder }) => {
      const o = await orgOf(org);
      const ids = folder ? (await foldersByName(o.id, [folder])).map((w) => w.id) : (await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, o.id))).map((w) => w.id);
      const rows = await search(o.id, ids, query);
      return text(rows.length ? render(rows) : "No matches.");
    },
  );
  tool(
    "kb_add",
    { inputSchema: { org: orgArg, kind: z.enum(KB_KINDS), text: z.string().min(1).max(300), url: httpUrl.optional(), folder: z.string().optional().describe("Only for this folder"), pinned: z.boolean().default(false).describe("Always given to agents") } },
    async ({ org, kind, text: lesson, url, folder, pinned }) => {
      const o = await orgOf(org);
      const [w] = folder ? await foldersByName(o.id, [folder]) : [];
      const { row, created } = await addKnowledge(o.id, { kind, text: lesson, url: url ?? "", workspaceId: w?.id ?? null, pinned }, { source: "user" });
      return text(created ? `Saved [${row.id.slice(0, 8)}].` : `Already known as [${row.id.slice(0, 8)}].`);
    },
  );

  // Terminals: the same live PTYs as the Terminals page. The user watches them; they outlive this client.
  type Term = ReturnType<typeof listTerminals>[number];
  async function termsOf(org?: string) {
    const o = await orgOf(org);
    return listTerminals((await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, o.id))).map((w) => w.id));
  }
  function termOf(id: string) {
    const t = allTerminals().find((x) => x.id === id);
    if (!t) throw new Error(`No terminal ${id}. Call list_terminals.`);
    return t;
  }
  tool(
    "list_terminals",
    { inputSchema: { org: orgArg, folder: z.string().optional(), ticket: z.string().optional().describe("Only terminals opened for this ticket") } },
    async ({ org, folder, ticket }) => {
      const o = await orgOf(org);
      const ws = new Map((await db.select().from(workspaces).where(eq(workspaces.orgId, o.id))).map((w) => [w.id, w.name]));
      let all = await termsOf(o.id);
      if (folder) all = all.filter((t) => ws.get(t.workspaceId)?.toLowerCase() === folder.toLowerCase());
      if (ticket) {
        const t = await ticketOf(ticket, o.id);
        all = all.filter((x) => x.ticketId === t.id);
      }
      return text(all.length ? all.map((t: Term) => `${termLine(t)}  ${ws.get(t.workspaceId)}  ${t.cwd}`).join("\n") : "No terminals.");
    },
  );
  tool(
    "open_terminal",
    {
      inputSchema: { org: orgArg, folder: z.string().optional().describe("Folder name; default: the ticket's first folder"), ticket: z.string().optional(), command: z.string().max(2000).optional(), title: z.string().max(60).optional() },
    },
    async ({ org, folder, ticket, command, title }) => {
      const o = await orgOf(org);
      let info: Term;
      if (ticket) {
        const t = await ticketOf(ticket, o.id);
        const dirs = await foldersOf(t.id);
        const row = folder ? dirs.find((d) => d.ws.name.toLowerCase() === folder.toLowerCase()) : dirs[0];
        if (!row) return text(folder ? `${t.identifier} has no folder "${folder}".` : `${t.identifier} has no working folder.`);
        info = await call<Term>("POST", `/tickets/${t.id}/terminals`, { workspaceId: row.ws.id, command: command ?? "", title });
      } else {
        if (!folder) return text("Pass folder or ticket.");
        const [w] = await foldersByName(o.id, [folder]);
        info = await call<Term>("POST", `/workspaces/${w!.id}/terminals`, { cols: 120, rows: 30, command: command ?? "", title });
      }
      return text(`Terminal ${info.id} "${info.title}" opened in ${info.cwd}. Read it with terminal_read.`);
    },
  );
  tool(
    "terminal_read",
    { inputSchema: { id: z.string(), lines: z.number().int().min(1).max(2000).default(100) } },
    async ({ id, lines }) => {
      const t = termOf(id);
      const out = await call<string>("GET", `/terminals/${t.id}/text?lines=${lines}`);
      return text(`${out.trim() || "(no output yet)"}\n\n[${termLine(t)}]`);
    },
  );
  tool(
    "terminal_write",
    { inputSchema: { id: z.string(), input: z.string().max(100_000), enter: z.boolean().default(true) } },
    async ({ id, input, enter }) => {
      const t = termOf(id);
      if (!t.alive) return text("That terminal has exited. restart_terminal or open a new one.");
      await call("POST", `/terminals/${t.id}/input`, { data: enter ? `${input}\r` : input });
      return text("Sent. Wait a moment, then terminal_read.");
    },
  );
  tool(
    "update_terminal",
    { inputSchema: { id: z.string(), title: z.string().min(1).max(60).optional(), tags: z.array(z.string()).max(12).optional() } },
    async ({ id, title, tags }) => (await call("PATCH", `/terminals/${termOf(id).id}`, { title, tags }), text("Updated.")),
  );
  tool(
    "restart_terminal",
    { inputSchema: { id: z.string() } },
    async ({ id }) => (await call("POST", `/terminals/${termOf(id).id}/restart`), text("Restarted.")),
  );
  tool(
    "close_terminal",
    { inputSchema: { id: z.string() } },
    async ({ id }) => (await call("DELETE", `/terminals/${termOf(id).id}`), text("Closed.")),
  );
  tool(
    "run_terminal_template",
    { inputSchema: { org: orgArg, name: z.string() } },
    async ({ org, name }) => {
      const o = await orgOf(org);
      const all = await db.select().from(terminalTemplates).where(eq(terminalTemplates.orgId, o.id));
      const tpl = all.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!tpl) return text(`No template "${name}". Templates: ${all.map((x) => x.name).join(", ") || "none"}`);
      const opened = await call<Term[]>("POST", `/terminal-templates/${tpl.id}/run`);
      return text(opened.map((t) => `${t.id} "${t.title}"`).join("\n") || "Template has no steps.");
    },
  );
  tool(
    "list_ports",
    { inputSchema: { port: z.number().int().min(1).max(65535).optional() } },
    async ({ port }) => {
      const rows = await call<{ port: number; pid: number; command: string }[]>("GET", port ? `/system/ports/${port}` : "/system/ports");
      return text(rows.map((r) => `${r.port}  pid ${r.pid}  ${r.command}`).join("\n") || "Nothing listening.");
    },
  );
  tool(
    "kill_port",
    { inputSchema: { port: z.number().int().min(1).max(65535), force: z.boolean().default(false) } },
    async ({ port, force }) => {
      const r = await call<{ killed: number[] }>("POST", `/system/ports/${port}/kill`, { force });
      return text(`Killed pid ${r.killed.join(", ")}.`);
    },
  );

  // Browser: the desktop app's tabs. The hub acts as the user, so no approval cards (those live on an agent's ticket):
  // the calling Claude asks the user before tools, and browser_eval is off until switched on.
  const inTab = async (tab: string, run: () => Promise<string>) => {
    if (!connected()) return text(DESKTOP_ONLY);
    if (!getTab(tab)) return text("No such tab. Call browser_tabs.");
    return text(await run().catch((e: Error) => `Failed: ${e.message}`));
  };
  const tabArg = z.string().describe("Tab id from browser_tabs or browser_open");
  tool("browser_tabs", { inputSchema: {} }, async () => {
    if (!connected()) return text(DESKTOP_ONLY);
    const all = listTabs();
    return text(all.map((t) => `${t.id}  ${t.agentId ? "an agent's" : "the user's"}  "${t.title}"  ${t.url}`).join("\n") || "No tabs open. Open one with browser_open.");
  });
  tool("browser_open", { inputSchema: { url: httpUrl } }, async ({ url }) => {
    if (!connected()) return text(DESKTOP_ONLY);
    const t = await openTab(url);
    return text(`Tab ${t.id}\n${await settled(t.id)}`);
  });
  tool("browser_snapshot", { inputSchema: { tab: tabArg } }, async ({ tab }) => inTab(tab, () => snapshot(tab)));
  tool(
    "browser_read",
    { inputSchema: { tab: tabArg, ref: z.string().optional(), offset: z.number().int().min(0).default(0), max: z.number().int().min(200).max(30_000).default(8000) } },
    async ({ tab, ref, offset, max }) => inTab(tab, () => readText(tab, ref, offset, max)),
  );
  tool("browser_navigate", { inputSchema: { tab: tabArg, to: z.union([httpUrl, z.enum(["back", "forward", "reload"])]) } }, async ({ tab, to }) => inTab(tab, () => act(tab, { go: to })));
  tool("browser_click", { inputSchema: { tab: tabArg, ref: z.string() } }, async ({ tab, ref }) => inTab(tab, () => act(tab, { click: ref })));
  tool(
    "browser_type",
    { inputSchema: { tab: tabArg, ref: z.string(), text: z.string().max(20_000), clear: z.boolean().default(true), submit: z.boolean().default(false) } },
    async ({ tab, ref, text: t, clear, submit }) => inTab(tab, () => act(tab, { type: ref, text: t, clear, submit })),
  );
  tool("browser_press", { inputSchema: { tab: tabArg, key: z.string().max(40), ref: z.string().optional() } }, async ({ tab, key, ref }) => inTab(tab, () => act(tab, { press: key, ref })));
  tool("browser_eval", { inputSchema: { tab: tabArg, code: z.string().max(20_000) } }, async ({ tab, code }) => inTab(tab, () => evalScript(tab, code)));
  tool("browser_close", { inputSchema: { tab: tabArg } }, async ({ tab }) => inTab(tab, () => closeTab(tab).then(() => "Closed.")));

  return server;
}

/** Hub MCP endpoint and its Settings routes. */
export function mountHub(app: Hono) {
  app.all("/mcp/hub", async (c) => {
    const { token, enabled: on } = readConfig();
    if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
    if (on === false) return c.json({ error: "Zippy Hub is disabled. Enable it in Zippy → Settings → Connectors." }, 403);
    // Newer clients send a protocol revision the SDK rejects with 404; fall back to the default.
    const v = c.req.header("mcp-protocol-version");
    if (v && !SUPPORTED_PROTOCOL_VERSIONS.includes(v)) c.req.raw.headers.delete("mcp-protocol-version");
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await buildServer(app).connect(transport);
    return transport.handleRequest(c);
  });

  // Settings: token, registration state, the command for other MCP clients, and which tools are on. All in ~/.zippy/hub.json (0600).
  const status = () => {
    const cfg = readConfig();
    const token = cfg.token ?? null;
    const tools = Object.entries(HUB_TOOLS).map(([name, t]) => ({ name, group: t.group, risk: t.risk, summary: t.summary, enabled: enabled(name, cfg) }));
    return { name: HUB_NAME, url: hubUrl(), enabled: cfg.enabled !== false, token, command: token ? `claude ${addArgs(token).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}` : null, ...registration(token), tools };
  };
  app.get("/system/hub", (c) => c.json(status()));
  // { name: on } for any subset of tools. Takes effect on the client's next connection (new Claude Code session or /mcp reconnect).
  app.post("/system/hub/tools", async (c) => {
    const patch = z.partialRecord(z.enum(Object.keys(HUB_TOOLS) as [string, ...string[]]), z.boolean()).parse(await c.req.json());
    writeConfig({ tools: { ...readConfig().tools, ...(patch as Record<string, boolean>) } });
    return c.json(status());
  });
  app.post("/system/hub/register", async (c) => {
    await register(readToken() ?? newToken());
    return c.json(status());
  });
  // New token: the old one stops working at once; re-registers when it was registered.
  app.post("/system/hub/rotate", async (c) => {
    const was = registration(readToken()).registered;
    const token = newToken();
    if (was) await register(token);
    return c.json(status());
  });
  const unregister = async () => {
    writeDesktop(null);
    await run(claudePath ?? "claude", ["mcp", "remove", "--scope", "user", HUB_NAME], { env: userEnv() }).catch(() => {}); // may be Desktop-only
  };
  app.post("/system/hub/unregister", async (c) => (await unregister(), c.json(status())));
  // Off: every client gets 403, registration and token kept. Back on: works again, nothing to re-register.
  app.post("/system/hub/enabled", async (c) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    writeConfig({ enabled });
    return c.json(status());
  });
  // Revoke: delete the token (every client, Claude Code or other, is locked out) and remove the Claude Code registration.
  app.post("/system/hub/revoke", async (c) => {
    writeConfig({ token: undefined });
    if (registration(null).registered) await unregister().catch(() => {});
    return c.json(status());
  });
}
