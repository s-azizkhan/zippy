import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { ApprovalPayload, TicketStatus, ToolPayload } from "@zippy/shared";
import { emit } from "./bus.ts";
import { desktopMcps, isOn, scanCatalog } from "./catalog.ts";
import { forAgent } from "./files.ts";
import { ensureWorktree } from "./git.ts";
import { agentToken, LINEAR_MCP_URL, postComment, syncStatus } from "./linear.ts";
import { issueToken, revokeToken } from "./mcp.ts";
import { notify } from "./notify.ts";
import { afterTurn } from "./pipeline.ts";
import { agentSessions, agents, comments, db, mcpServers, orgs, ticketFolders, tickets, workspaces } from "./db/index.ts";

const ADAPTER = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");

/** Local `claude` CLI if installed; otherwise the adapter's bundled CLI (subscription login). */
export const claudePath = (() => {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

export function claudeAuthStatus(): { loggedIn: boolean; authMethod?: string } {
  if (!claudePath) return { loggedIn: false };
  try {
    return JSON.parse(execFileSync(claudePath, ["auth", "status", "--json"], { encoding: "utf8", timeout: 5000 }));
  } catch {
    return { loggedIn: false };
  }
}

/** Spawns the ACP adapter and handshakes; resolves to its name/version or throws. */
export async function acpHealth() {
  const proc = spawn(process.execPath, [ADAPTER], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...(claudePath && { CLAUDE_CODE_EXECUTABLE: claudePath }) } });
  const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>);
  const conn = new acp.ClientSideConnection(() => ({}) as acp.Client, stream);
  try {
    const r = await Promise.race([
      conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000)),
    ]);
    return { ok: true as const, agent: r.agentInfo?.name, version: r.agentInfo?.version };
  } finally {
    proc.kill();
  }
}

type Agent = typeof agents.$inferSelect;
type Ticket = typeof tickets.$inferSelect;
type Comment = typeof comments.$inferSelect;
type Workspace = typeof workspaces.$inferSelect;
/** A ticket folder resolved to where agents work in it. */
type Dir = { ws: Workspace; cwd: string; branch: string | null };

/** The ticket's folders in position order, with their workspace rows. */
export async function foldersOf(ticketId: string) {
  return db
    .select({ folder: ticketFolders, ws: workspaces })
    .from(ticketFolders)
    .innerJoin(workspaces, eq(workspaces.id, ticketFolders.workspaceId))
    .where(eq(ticketFolders.ticketId, ticketId))
    .orderBy(asc(ticketFolders.position));
}

type Live = {
  proc: ChildProcess;
  conn: acp.ClientSideConnection;
  acpSessionId: string;
  replaying: boolean;
  turn: Promise<unknown>; // serializes prompts
  work: Promise<unknown>; // serializes update handling
  text: { id: string; text: string; createdAt: Date } | null;
  tools: Map<string, string>; // toolCallId -> comment id
  planId: string | null;
  flush: () => Promise<void>; // persist the streamed text comment
  busy: boolean; // a prompt turn is in flight
  costBase: number; // DB cost when this process started; ACP cost restarts at 0 per process
  overBudget: boolean;
  idleTimer?: NodeJS.Timeout;
};

// ponytail: idle processes are killed; loadSession restores them on the next prompt.
const IDLE_MS = 10 * 60_000;

const live = new Map<string, Live>(); // key: agent_sessions.id
const pendingApprovals = new Map<string, (optionId: string | null) => void>(); // key: comment id

export const isRunning = (sessionRowId: string) => !!live.get(sessionRowId)?.busy;

// Kinds mirrored to Linear as comments.
const MIRRORED = new Set(["text", "handoff", "question", "pr", "error"]);

function linearBody(kind: string, p: any): string {
  if (kind === "handoff") return `**${p.stage}: ${p.verdict.toUpperCase()}** → ${p.next}\n\n${p.summary}${p.notes ? `\n\n${p.notes}` : ""}`;
  if (kind === "question") return `**Question:** ${p.question}\n\n${p.options.map((o: string) => `- ${o}${o === p.recommended ? " (recommended)" : ""}`).join("\n")}`;
  if (kind === "pr") return `PR opened: [${p.title}](${p.url})`;
  return p.text;
}

async function mirror(c: Comment) {
  if (!MIRRORED.has(c.kind)) return;
  const [t] = await db.select().from(tickets).where(eq(tickets.id, c.ticketId));
  if (!t?.linearId) return;
  const [org] = await db.select().from(orgs).where(eq(orgs.id, t.orgId));
  const [a] = c.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, c.agentId)) : [];
  const [parent] = c.parentId ? await db.select({ lid: comments.linearCommentId }).from(comments).where(eq(comments.id, c.parentId)) : [];
  const lid = await postComment(org!, t, linearBody(c.kind, c.payload), a?.name ?? "Zippy", parent?.lid);
  if (lid) await db.update(comments).set({ linearCommentId: lid }).where(eq(comments.id, c.id));
}

/** Persist + broadcast a timeline comment. `fromLinear` skips mirroring it back. */
export async function addComment(
  ticketId: string,
  agentId: string | null,
  kind: Comment["kind"],
  payload: unknown,
  id: string = randomUUID(),
  opts: { createdAt?: Date; fromLinear?: boolean; parentId?: string | null; linearCommentId?: string } = {},
) {
  const [c] = await db
    .insert(comments)
    .values({ id, ticketId, agentId, kind, payload, parentId: opts.parentId ?? null, linearCommentId: opts.linearCommentId, ...(opts.createdAt && { createdAt: opts.createdAt }) })
    .returning();
  emit(ticketId, { type: "comment", comment: c });
  if (!opts.fromLinear) mirror(c!).catch((e) => console.error("[linear]", e.message));
  return c!;
}

async function patchComment(ticketId: string, id: string, payload: unknown) {
  const [c] = await db.update(comments).set({ payload }).where(eq(comments.id, id)).returning();
  if (c) emit(ticketId, { type: "comment", comment: c });
}

/** Org per-ticket budget minus what this ticket's agents spent. null = no budget set. */
export async function budgetLeft(ticketId: string) {
  const [row] = await db
    .select({ budget: orgs.budgetUsd, spent: sql<number>`coalesce(sum(${agentSessions.costUsd}), 0)` })
    .from(tickets)
    .innerJoin(orgs, eq(orgs.id, tickets.orgId))
    .leftJoin(agentSessions, eq(agentSessions.ticketId, tickets.id))
    .where(eq(tickets.id, ticketId))
    .groupBy(orgs.budgetUsd);
  return row?.budget == null ? null : row.budget - Number(row.spent);
}

const overBudgetNote = (ticketId: string) =>
  addComment(ticketId, null, "error", { text: "This ticket reached its agent budget. Raise the budget in Settings → Organization to continue." }).then(() =>
    setStatus(ticketId, "needs_input"),
  );

export async function setStatus(ticketId: string, to: TicketStatus) {
  const [prev] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticketId));
  if (!prev || prev.status === to) return;
  const [t] = await db.update(tickets).set({ status: to, updatedAt: new Date() }).where(eq(tickets.id, ticketId)).returning();
  const folders = (await foldersOf(ticketId)).map((f) => f.folder);
  emit(ticketId, { type: "ticket", ticket: { ...t, folders } });
  await addComment(ticketId, null, "status", { from: prev.status, to });
  const [org] = await db.select().from(orgs).where(eq(orgs.id, t!.orgId));
  syncStatus(org!, t!, to).catch((e) => console.error("[linear]", e.message));
  const ping = { needs_input: "needs your input", in_review: "is ready for review", blocked: "is blocked" }[to as string];
  if (ping) notify(org!, t!, ping).catch(console.error);
}

async function systemPrompt(ticket: Ticket, agent: Agent, dirs: Dir[]) {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, ticket.orgId));
  const team = await db.select({ handle: agents.handle, name: agents.name }).from(agents).where(eq(agents.orgId, ticket.orgId));
  return [
    `# Organization: ${org!.name}`,
    org!.contextMd,
    ...dirs.map((d, i) =>
      [
        `# Working folder: ${d.ws.name}${i === 0 ? " (your cwd)" : ""}`,
        `Path: ${d.cwd}${d.branch ? ` (git worktree, branch \`${d.branch}\`, base \`${d.ws.baseBranch}\`)` : ""}`,
        d.ws.testCmd && `Test command: \`${d.ws.testCmd}\``,
        d.ws.contextMd,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    `# Your role: ${agent.name} (@${agent.handle})`,
    agent.rolePromptMd,
    "# Style\nUse the caveman skill (full). Keep your response short and to the point, no over-explaining.",
    !agent.canWrite && "You are read-only. Do not edit files.",
    `# Team\nYou work on a shared ticket with: ${team.map((a) => `@${a.handle} (${a.name})`).join(", ")}. Your replies are posted as ticket comments.`,
    `# Zippy tools\nThe zippy MCP server gives you: \`handoff\` (finish a pipeline stage), \`ask_user\` (a decision only the user can make), \`mention\` (ask another agent), \`create_subtickets\` (split big work into sub-issues), \`propose_learning\` (a durable lesson for future tickets; the user accepts it into context)${agent.canWrite ? ", `open_pr` (push and open the PR)" : ""}.`,
    dirs.some((d) => d.branch) && "# Git\nCommit your work in each folder you change, with clear messages. Do not push; `open_pr` pushes and opens one PR per changed folder.",
    `# Ticket ${ticket.identifier}: ${ticket.title}`,
    ticket.linearUrl && `Linear: ${ticket.linearUrl}`,
    forAgent(ticket.body) || "(no description)",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function mcpFor(ticket: Ticket, agent: Agent, token: string, dirs: Dir[]): Promise<acp.McpServer[]> {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, ticket.orgId));
  const builtIn: acp.McpServer[] = [
    { type: "http", name: "zippy", url: `http://127.0.0.1:${process.env.PORT ?? 3001}/api/mcp`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] },
  ];
  const linear = org && (await agentToken(org).catch((e) => void console.error("[linear]", e.message)));
  if (linear) builtIn.push({ type: "http", name: "linear", url: LINEAR_MCP_URL, headers: [{ name: "Authorization", value: `Bearer ${linear}` }] });
  const rows = await db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.orgId, ticket.orgId),
        eq(mcpServers.enabled, true),
        dirs.length ? or(isNull(mcpServers.workspaceId), inArray(mcpServers.workspaceId, dirs.map((d) => d.ws.id))) : isNull(mcpServers.workspaceId),
      ),
    );
  const desktop = scanCatalog().items.filter((i) => i.kind === "mcp" && i.source === "Claude Desktop" && isOn(i, org?.toggles ?? {}, agent.toggles));
  const fromDesktop = desktop.map((i) => {
    const m = desktopMcps()[i.name]!;
    return { name: i.name, command: m.command, args: m.args ?? [], env: Object.entries(m.env ?? {}).map(([name, value]) => ({ name, value })) };
  });
  return [...builtIn, ...fromDesktop].concat(rows.map((m) =>
    m.transport === "http"
      ? { type: "http" as const, name: m.name, url: m.url, headers: Object.entries(m.env).map(([name, value]) => ({ name, value })) }
      : { name: m.name, command: m.command, args: m.args, env: Object.entries(m.env).map(([name, value]) => ({ name, value })) },
  ));
}

const POLICY_AUTO_ALLOW = new Set(["read", "search", "think"]);

async function start(sessionRow: typeof agentSessions.$inferSelect, ticket: Ticket, agent: Agent, dirs: Dir[]): Promise<Live> {
  const cwd = dirs[0]!.cwd;
  const additionalDirectories = dirs.slice(1).map((d) => d.cwd);
  const proc = spawn(process.execPath, [ADAPTER], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...(claudePath && { CLAUDE_CODE_EXECUTABLE: claudePath }) },
  });
  const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>);
  const l = {
    proc,
    replaying: false,
    turn: Promise.resolve(),
    work: Promise.resolve(),
    text: null,
    tools: new Map(),
    planId: null,
    costBase: sessionRow.costUsd,
    overBudget: false,
  } as unknown as Live;
  const queue = (fn: () => Promise<unknown>) => (l.work = l.work.then(fn).catch((e) => console.error("[runner]", e)));

  const flushText = (l.flush = async () => {
    if (!l.text) return;
    const { id, text, createdAt } = l.text;
    l.text = null;
    if (text.trim()) await addComment(ticket.id, agent.id, "text", { text }, id, { createdAt });
  });

  const trackCost = async (amount: number) => {
    await db.update(agentSessions).set({ costUsd: l.costBase + amount }).where(eq(agentSessions.id, sessionRow.id));
    const budget = await budgetLeft(ticket.id);
    if (budget !== null && budget <= 0 && l.busy && !l.overBudget) {
      l.overBudget = true;
      await l.conn.cancel({ sessionId: l.acpSessionId });
    }
  };

  const client: acp.Client = {
    async sessionUpdate({ update }) {
      if (l.replaying) return;
      if (update.sessionUpdate === "usage_update") {
        const amount = update.cost?.amount;
        if (amount != null) queue(() => trackCost(amount));
        return;
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        if (update.content.type !== "text") return;
        const chunk = update.content.text;
        // Stream deltas without a DB write per chunk; persisted on flushText.
        if (!l.text) {
          l.text = { id: randomUUID(), text: chunk, createdAt: new Date() };
          emit(ticket.id, {
            type: "comment",
            comment: { id: l.text.id, ticketId: ticket.id, agentId: agent.id, kind: "text", payload: { text: chunk }, createdAt: l.text.createdAt },
          });
        } else {
          l.text.text += chunk;
          emit(ticket.id, { type: "delta", id: l.text.id, text: chunk });
        }
        return;
      }
      queue(async () => {
        if (update.sessionUpdate === "tool_call") {
          await flushText();
          const id = randomUUID();
          l.tools.set(update.toolCallId, id);
          await addComment(ticket.id, agent.id, "tool", { toolCallId: update.toolCallId, title: update.title, kind: update.kind, status: update.status } satisfies ToolPayload, id);
        } else if (update.sessionUpdate === "tool_call_update") {
          const id = l.tools.get(update.toolCallId);
          if (!id) return;
          const [c] = await db.select().from(comments).where(eq(comments.id, id));
          const output = update.content
            ?.map((b) => (b.type === "content" && b.content.type === "text" ? b.content.text : b.type === "diff" ? `diff: ${b.path}` : ""))
            .join("\n")
            .slice(0, 4000);
          await patchComment(ticket.id, id, {
            ...(c!.payload as ToolPayload),
            ...(update.title && { title: update.title }),
            ...(update.status && { status: update.status }),
            ...(output && { output }),
          });
        } else if (update.sessionUpdate === "plan") {
          await flushText();
          if (l.planId) await patchComment(ticket.id, l.planId, { entries: update.entries });
          else l.planId = (await addComment(ticket.id, agent.id, "plan", { entries: update.entries })).id;
        }
      });
    },

    async requestPermission({ toolCall, options }) {
      const pick = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
      const allow = pick("allow_once") ?? pick("allow_always");
      if (allow && (POLICY_AUTO_ALLOW.has(toolCall.kind ?? "") || (agent.canWrite && toolCall.kind === "edit"))) {
        return { outcome: { outcome: "selected", optionId: allow } };
      }
      const approval = await new Promise<{ id: string; decided: Promise<string | null> }>((resolve) =>
        queue(async () => {
          await flushText();
          const c = await addComment(ticket.id, agent.id, "approval", {
            title: toolCall.title ?? "Permission requested",
            kind: toolCall.kind ?? undefined,
            options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
          } satisfies ApprovalPayload);
          await setStatus(ticket.id, "needs_input");
          resolve({ id: c.id, decided: new Promise((r) => pendingApprovals.set(c.id, r)) });
        }),
      );
      const optionId = await approval.decided;
      return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
    },
  };

  l.conn = new acp.ClientSideConnection(() => client, stream);
  const token = issueToken(ticket.id, agent.id);
  proc.on("exit", () => {
    revokeToken(token);
    live.delete(sessionRow.id);
    clearTimeout(l.idleTimer);
    emit(ticket.id, { type: "session", agentId: agent.id, running: false });
  });

  await l.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const mcp = await mcpFor(ticket, agent, token, dirs);
  const [org] = await db.select({ toggles: orgs.toggles, defaultModel: orgs.defaultModel, defaultEffort: orgs.defaultEffort }).from(orgs).where(eq(orgs.id, ticket.orgId));
  const items = scanCatalog().items.map((i) => ({ i, on: isOn(i, org?.toggles ?? {}, agent.toggles) }));
  const offMcp = items.filter((x) => x.i.kind === "mcp" && !x.on && x.i.source === "Claude Code").map((x) => `mcp__${x.i.name}`);
  const offSkill = items.some((x) => x.i.kind === "skill" && !x.on);
  const disallowedTools = [...(agent.canWrite ? [] : ["Edit", "Write", "NotebookEdit", "MultiEdit", "mcp__zippy__open_pr"]), ...offMcp];
  const meta = {
    systemPrompt: { append: await systemPrompt(ticket, agent, dirs) },
    claudeCode: {
      options: {
        allowedTools: ["mcp__zippy"],
        ...(disallowedTools.length && { disallowedTools }),
        // ponytail: SDK `skills` allow-list; unset = all skills load.
        ...(offSkill && { skills: items.filter((x) => x.i.kind === "skill" && x.on).map((x) => x.i.name) }),
      },
    },
  };

  if (sessionRow.acpSessionId) {
    try {
      l.replaying = true;
      await l.conn.loadSession({ sessionId: sessionRow.acpSessionId, cwd, additionalDirectories, mcpServers: mcp, _meta: meta });
      l.acpSessionId = sessionRow.acpSessionId;
    } catch {
      // History gone (e.g. CLI state cleared): fall through to a fresh session.
    } finally {
      l.replaying = false;
    }
  }
  if (!l.acpSessionId) {
    const s = await l.conn.newSession({ cwd, additionalDirectories, mcpServers: mcp, _meta: meta });
    l.acpSessionId = s.sessionId;
    await db.update(agentSessions).set({ acpSessionId: s.sessionId }).where(eq(agentSessions.id, sessionRow.id));
  }
  // Model first: effort levels depend on it. "default" = leave to Claude Code.
  const model = agent.model !== "default" ? agent.model : (org?.defaultModel ?? "default");
  for (const [configId, value] of [["model", model], ["effort", org?.defaultEffort ?? "default"]]) {
    if (value !== "default") await l.conn.setSessionConfigOption({ sessionId: l.acpSessionId, configId, value }).catch(() => {});
  }

  live.set(sessionRow.id, l);
  return l;
}

/** Timeline comments the agent has not seen yet, as a prompt preamble. */
async function catchUp(sessionRow: typeof agentSessions.$inferSelect, ticketId: string, agentId: string, excludeId?: string) {
  const since = sessionRow.acpSessionId ? sessionRow.lastSeenAt : new Date(0);
  const rows = await db
    .select({ id: comments.id, agentId: comments.agentId, payload: comments.payload, handle: agents.handle })
    .from(comments)
    .leftJoin(agents, eq(agents.id, comments.agentId))
    .where(and(eq(comments.ticketId, ticketId), eq(comments.kind, "text"), gt(comments.createdAt, since)))
    .orderBy(asc(comments.createdAt));
  const lines = rows
    .filter((r) => r.agentId !== agentId && r.id !== excludeId)
    .map((r) => {
      const p = r.payload as { text: string; author?: string };
      return `**${r.handle ? `@${r.handle}` : (p.author ?? "User")}:** ${forAgent(p.text)}`;
    });
  return lines.length ? `New on the ticket since your last turn:\n\n${lines.join("\n\n")}\n\n---\n\n` : "";
}

/** Run one agent turn on a ticket. Resolves when the turn ends. */
export async function runAgent(ticketId: string, agentId: string, message: string, triggerCommentId?: string) {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!ticket || !agent) throw new Error("ticket or agent not found");

  const folders = await foldersOf(ticketId);
  if (!folders.length) return addComment(ticketId, null, "error", { text: "Add a working folder to this ticket before you run an agent." });

  await db.insert(agentSessions).values({ ticketId, agentId }).onConflictDoNothing();
  const [sessionRow] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.ticketId, ticketId), eq(agentSessions.agentId, agentId)));

  let l: Live;
  try {
    let current = live.get(sessionRow!.id);
    if (!current) {
      const dirs: Dir[] = [];
      for (const { folder, ws } of folders) {
        const { cwd, branch, setupError } = await ensureWorktree(ticket, folder, ws);
        if (setupError) await addComment(ticketId, null, "error", { text: `Setup command failed in ${ws.name}:\n\n\`\`\`\n${setupError}\n\`\`\`` });
        dirs.push({ ws, cwd, branch });
      }
      current = await start(sessionRow!, ticket, agent, dirs);
    }
    l = current;
  } catch (e) {
    await addComment(ticketId, agent.id, "error", { text: `Agent failed to start: ${(e as Error).message}` });
    return setStatus(ticketId, "blocked");
  }

  const turn = l.turn.then(async () => {
    const left = await budgetLeft(ticketId);
    if (left !== null && left <= 0) return overBudgetNote(ticketId);
    clearTimeout(l.idleTimer);
    l.overBudget = false;
    l.busy = true;
    emit(ticketId, { type: "session", agentId, running: true });
    const preamble = await catchUp(sessionRow!, ticketId, agentId, triggerCommentId);
    await db.update(agentSessions).set({ lastSeenAt: new Date() }).where(eq(agentSessions.id, sessionRow!.id));
    await setStatus(ticketId, "in_progress");
    try {
      const res = await l.conn
        .prompt({ sessionId: l.acpSessionId, prompt: [{ type: "text", text: preamble + message }] })
        .finally(() => (l.work = l.work.then(l.flush)));
      await l.work;
      l.planId = null;
      if (res.usage) {
        await db
          .update(agentSessions)
          .set({ tokensIn: sql`${agentSessions.tokensIn} + ${res.usage.inputTokens}`, tokensOut: sql`${agentSessions.tokensOut} + ${res.usage.outputTokens}` })
          .where(eq(agentSessions.id, sessionRow!.id));
      }
      await l.work; // cost updates land before the budget decision
      if (l.overBudget) return overBudgetNote(ticketId);
      if (res.stopReason === "cancelled") return setStatus(ticketId, "todo");
      if (await afterTurn(ticketId, agentId)) return;
      const [now] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticketId));
      if (res.stopReason === "end_turn" && now?.status === "in_progress") await setStatus(ticketId, "in_review");
    } catch (e) {
      const msg = (e as Error).message;
      await addComment(ticketId, agent.id, "error", {
        text: /auth/i.test(msg) ? "Claude is not logged in. Run `claude auth login` in a terminal, then retry." : msg,
      });
      await setStatus(ticketId, "blocked");
    }
  });
  l.turn = turn
    .catch(() => {})
    .finally(() => {
      l.busy = false;
      emit(ticketId, { type: "session", agentId, running: false });
      l.idleTimer = setTimeout(() => l.proc.kill(), IDLE_MS);
    });
  return turn;
}

export async function cancelAgent(ticketId: string, agentId: string) {
  const [s] = await db.select().from(agentSessions).where(and(eq(agentSessions.ticketId, ticketId), eq(agentSessions.agentId, agentId)));
  const l = s && live.get(s.id);
  if (l) await l.conn.cancel({ sessionId: l.acpSessionId });
}

export async function decideApproval(commentId: string, optionId: string | null) {
  const resolve = pendingApprovals.get(commentId);
  const [c] = await db.select().from(comments).where(eq(comments.id, commentId));
  if (!c) return false;
  await patchComment(c.ticketId, c.id, { ...(c.payload as ApprovalPayload), decision: optionId ?? "cancelled" });
  if (resolve) {
    pendingApprovals.delete(commentId);
    resolve(optionId);
    await setStatus(c.ticketId, "in_progress");
  }
  return true;
}

export function shutdown() {
  for (const l of live.values()) l.proc.kill();
}
