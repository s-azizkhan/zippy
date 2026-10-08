import { randomUUID } from "node:crypto";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { KB_KINDS, httpUrl, type ApprovalPayload, type DraftPayload, type QuestionPayload } from "@zippy/shared";
import { agents, db, knowledge, orgs, ticketFolders, tickets } from "./db/index.ts";
import { addKnowledge, byShortId, render, search } from "./kb.ts";
import { commitsAhead, ensureWorktree, folderDiff, openPr } from "./git.ts";
import { attachPr, createSubIssue } from "./linear.ts";
import { emit } from "./bus.ts";
import { notify } from "./notify.ts";
import { createTicket } from "./tickets.ts";
import { handoff, markAsked } from "./pipeline.ts";
import { addComment, foldersOf, runAgent, setStatus } from "./runner.ts";
import { closeTerminal, getTerminal, listTerminals, readTerminal, spawnTerminal, writeTerminal } from "./term.ts";

// Bearer token -> the agent session it was issued to. Issued per spawned ACP process.
const tokens = new Map<string, { ticketId: string; agentId: string }>();

export function issueToken(ticketId: string, agentId: string) {
  const token = randomUUID();
  tokens.set(token, { ticketId, agentId });
  return token;
}
export const revokeToken = (token: string) => tokens.delete(token);

// Agent-to-agent mentions since the last human comment. Stops mention ping-pong.
const MAX_AGENT_HOPS = 6;
const hops = new Map<string, number>();
export const resetHops = (ticketId: string) => hops.delete(ticketId);

const MAX_KB_PER_TICKET = 8;

// Terminal actions by read-only agents, waiting on an approval card. ponytail: in memory; a restart drops them and the agent asks again.
const pendingTerm = new Map<string, () => Promise<string>>(); // key: approval comment id
/** Runs (or drops) the terminal action behind an approval card; returns the message for the agent, or null when the card was not one. */
export async function runPendingTerm(commentId: string, approved: boolean) {
  const run = pendingTerm.get(commentId);
  if (!run) return null;
  pendingTerm.delete(commentId);
  return approved ? run().catch((e: Error) => `Failed: ${e.message}`) : "The user denied it. Explain what you wanted or ask_user for an alternative.";
}

/** The org's human when `handle` is theirs. */
async function humanOf(orgId: string, handle: string) {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  return org?.profile.handle && org.profile.handle === handle.replace(/^@/, "") ? { org } : undefined;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function buildServer(ticketId: string, agentId: string, canWrite: boolean, inPlace: boolean, chat: boolean) {
  const server = new McpServer({ name: "zippy", version: "0.1.0" });

  if (chat) server.registerTool(
    "propose_ticket",
    {
      description: "Propose a ticket from this chat. It is shown to the user as a draft they review, edit and create themselves; nothing is created yet.",
      inputSchema: { title: z.string().min(1).max(200), body: z.string().describe("Markdown: context, scope and acceptance criteria") },
    },
    async ({ title, body }) => {
      await addComment(ticketId, agentId, "draft", { title, body } satisfies DraftPayload);
      return text("Draft shown to the user, who reviews and creates the ticket. Do not say it was created.");
    },
  );

  server.registerTool(
    "handoff",
    {
      description: "Finish your pipeline stage. Routes the ticket to the next agent (pass) or back for fixes (fail).",
      inputSchema: {
        verdict: z.enum(["pass", "fail"]),
        summary: z.string().describe("One or two sentences: what you did or found."),
        notes: z.string().optional().describe("Details for the next agent: findings, file:line, what to fix."),
      },
    },
    async ({ verdict, summary, notes }) => text(await handoff(ticketId, agentId, verdict, summary, notes)),
  );

  server.registerTool(
    "ask_user",
    {
      description: "Ask the user a decision you cannot make. Give options and your recommendation. Then end your turn; the answer arrives as the next message.",
      inputSchema: {
        question: z.string(),
        options: z.array(z.string()).min(2).max(5),
        recommended: z.string().optional().describe("The option you recommend, verbatim."),
      },
    },
    async ({ question, options, recommended }) => {
      await addComment(ticketId, agentId, "question", { question, options, recommended } satisfies QuestionPayload);
      markAsked(ticketId, agentId);
      return text("Question posted. End your turn now.");
    },
  );

  server.registerTool(
    "mention",
    {
      description: "Ask another agent, or the human, on this ticket to do something. An agent runs in its own session and replies on the ticket; the human is notified.",
      inputSchema: { handle: z.string().describe("Agent or human handle without @"), message: z.string() },
    },
    async ({ handle, message }) => {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      const human = await humanOf(t!.orgId, handle);
      if (human) {
        await addComment(ticketId, agentId, "text", { text: `@${handle.replace(/^@/, "")} ${message}` });
        notify(human.org, t!, "has a message for you").catch(console.error);
        return text("Human was notified.");
      }
      const [target] = await db.select().from(agents).where(and(eq(agents.orgId, t!.orgId), eq(agents.handle, handle.replace(/^@/, ""))));
      if (!target) return text(`No agent @${handle}.`);
      if (target.id === agentId) return text("You cannot mention yourself.");
      const n = (hops.get(ticketId) ?? 0) + 1;
      if (n > MAX_AGENT_HOPS) return text("Too many agent-to-agent mentions without the user. Use ask_user instead.");
      hops.set(ticketId, n);
      const [me] = await db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, agentId));
      await addComment(ticketId, agentId, "text", { text: `@${target.handle} ${message}` });
      runAgent(ticketId, target.id, `@${me!.handle} asks you: ${message}`).catch(console.error);
      return text(`@${target.handle} was asked. Its reply will appear on the ticket.`);
    },
  );

  server.registerTool(
    "assign",
    {
      description: "Assign this ticket to an agent or the human by handle, or pass \"none\" to unassign. The human is notified.",
      inputSchema: { handle: z.string().describe("Agent or human handle without @, or none") },
    },
    async ({ handle }) => {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      const h = handle.replace(/^@/, "");
      const human = await humanOf(t!.orgId, h);
      const [target] = human || h === "none" ? [] : await db.select().from(agents).where(and(eq(agents.orgId, t!.orgId), eq(agents.handle, h)));
      if (!human && !target && h !== "none") return text(`No agent or human @${h}.`);
      const [u] = await db.update(tickets).set({ assigneeAgentId: target?.id ?? null, assigneeHuman: !!human, updatedAt: new Date() }).where(eq(tickets.id, ticketId)).returning();
      emit(ticketId, { type: "ticket", ticket: { ...u!, folders: (await foldersOf(ticketId)).map((f) => f.folder) } });
      if (human) notify(human.org, t!, "was assigned to you").catch(console.error);
      return text(human ? `Assigned to @${h} (human).` : target ? `Assigned to @${h}.` : "Unassigned.");
    },
  );

  server.registerTool(
    "create_subtickets",
    {
      description: "Split this ticket into sub-issues (also created in Linear when this ticket is linked). They start in Todo with this ticket's folders; nobody is assigned.",
      inputSchema: {
        tickets: z
          .array(
            z.object({
              title: z.string().min(1).max(200),
              body: z.string().describe("Markdown: scope and acceptance criteria"),
              blockedBy: z.array(z.number().int().min(0)).optional().describe("Indexes of earlier items in this list that must finish first"),
            }),
          )
          .min(1)
          .max(12),
      },
    },
    async ({ tickets: items }) => {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      const [org] = await db.select().from(orgs).where(eq(orgs.id, t!.orgId));
      const workspaceIds = (await foldersOf(ticketId)).map((f) => f.ws.id);
      const made: string[] = [];
      for (const [i, item] of items.entries()) {
        const deps = (item.blockedBy ?? []).filter((n) => n < i).map((n) => made[n]!);
        let linear;
        if (t!.linearId && org!.linearAuth?.tokens) {
          const issue = await createSubIssue(org!, t!, { title: item.title, description: item.body, blockedBy: deps });
          linear = { identifier: issue.id, linearId: issue.uuid, linearUrl: issue.url };
        }
        const body = deps.length && !linear ? `${item.body}\n\nBlocked by ${deps.join(", ")}` : item.body;
        const sub = await createTicket(t!.orgId, { title: item.title, body, workspaceIds, assigneeAgentId: null, priority: "none", labelIds: [], status: "todo" }, { parentId: ticketId, linear });
        made.push(sub.identifier);
      }
      await addComment(ticketId, agentId, "text", { text: `Split into sub-issues: ${made.join(", ")}` });
      return text(`Created ${made.join(", ")}.`);
    },
  );

  server.registerTool(
    "kb_add",
    {
      description:
        "Save a durable lesson to the org knowledge base, used on future tickets. Use when the user corrects you or states a preference, or you hit a non-obvious gotcha, command or useful link. Not for facts obvious from the code. Near-duplicates are merged.",
      inputSchema: {
        kind: z.enum(KB_KINDS),
        text: z.string().min(1).max(300).describe("One sentence, imperative, self-contained"),
        url: httpUrl.optional(),
        folder: z.string().optional().describe("Working folder name if it only applies there; omit for the whole org"),
        replaces: z.string().optional().describe("Short id of an outdated entry this corrects"),
      },
    },
    async ({ kind, text: lesson, url, folder, replaces }) => {
      const [t] = await db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketId));
      const added = await db.$count(knowledge, and(eq(knowledge.ticketId, ticketId), eq(knowledge.source, "agent")));
      if (added >= MAX_KB_PER_TICKET) return text("Knowledge limit for this ticket reached. Keep only what matters most.");
      if (replaces) {
        const old = await byShortId(t!.orgId, replaces);
        if (!old) return text(`No entry ${replaces}.`);
        if (old.source === "user") return text("That entry was written by the user. Use ask_user to suggest the change.");
        await db.delete(knowledge).where(eq(knowledge.id, old.id));
      }
      const ws = folder ? (await foldersOf(ticketId)).find((f) => f.ws.name === folder)?.ws : undefined;
      const { row, created } = await addKnowledge(t!.orgId, { kind, text: lesson, url: url ?? "", workspaceId: ws?.id ?? null, pinned: false }, { source: "agent", agentId, ticketId });
      return text(created ? `Saved [${row.id.slice(0, 8)}].` : `Already known as [${row.id.slice(0, 8)}]; reinforced.`);
    },
  );

  server.registerTool(
    "kb_search",
    {
      description: "Search the org knowledge base beyond the entries already in your prompt.",
      inputSchema: { query: z.string().min(2) },
    },
    async ({ query }) => {
      const [t] = await db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketId));
      const rows = await search(t!.orgId, (await foldersOf(ticketId)).map((f) => f.ws.id), query);
      return text(rows.length ? render(rows) : "No matches.");
    },
  );

  // Terminals: real PTY shells that outlive the turn. Read-only agents and chats get list/read; opening and typing need canWrite. The human sees them live on the Terminals page, tagged with this ticket and the agent.
  const termLine = (t: ReturnType<typeof listTerminals>[number]) => `${t.id}  ${t.alive ? (t.process && !/^(-?zsh|-?bash|fish|sh)$/.test(t.process) ? `running ${t.process}` : "idle") : `exited ${t.exitCode}`}  "${t.title}"${t.command ? `  $ ${t.command}` : ""}  [${t.tags.join(" ")}]`;
  const ownTerms = async () => {
    const dirs = await foldersOf(ticketId);
    return listTerminals(dirs.map((d) => d.ws.id)).filter((t) => t.ticketId === ticketId);
  };
  server.registerTool(
    "terminal_read",
    { description: "Read the last lines of output from a terminal on this ticket.", inputSchema: { id: z.string(), lines: z.number().int().min(1).max(1000).default(80) } },
    async ({ id, lines }) => {
      const t = getTerminal(id);
      if (!t || t.ticketId !== ticketId) return text("No such terminal on this ticket. Call list_terminals.");
      const out = readTerminal(id, lines) ?? "";
      return text(`${out.trim() || "(no output yet)"}\n\n[${t.alive ? "running" : `exited ${t.exitCode}`}]`);
    },
  );
  server.registerTool(
    "list_terminals",
    { description: "Terminals opened for this ticket (yours and the user's), with id, state, title, command and tags.", inputSchema: {} },
    async () => {
      const mine = await ownTerms();
      return text(mine.length ? mine.map(termLine).join("\n") : "No terminals on this ticket.");
    },
  );

  // Read-only agents may still open / type into / close shells, but each such action is an approval card the human allows first.
  // Approved actions run in decideApproval → runPendingTerm; the agent is re-prompted with the result.
  const gated = async (title: string, run: () => Promise<string>) => {
    if (canWrite) return text(await run());
    const c = await addComment(ticketId, agentId, "approval", {
      title,
      kind: "terminal",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    } satisfies ApprovalPayload);
    pendingTerm.set(c.id, run);
    await setStatus(ticketId, "needs_input");
    markAsked(ticketId, agentId);
    return text("You are read-only, so this needs the user's approval. A card was posted. End your turn now; you will be messaged with the result.");
  };
  server.registerTool(
    "open_terminal",
    {
      description: "Open a persistent shell in a working folder (its worktree when one exists) and optionally run a command in it. Use for long-running things the user should be able to watch and keep: dev servers, watchers, test loops. For one-off commands use your own shell instead. Returns the terminal id. The user sees it live on the Terminals page. Read-only agents: the user approves first.",
      inputSchema: {
        folder: z.string().optional().describe("Working folder name; default: your cwd folder"),
        command: z.string().max(2000).optional().describe("Command typed into the shell right after it opens"),
        title: z.string().max(60).optional().describe("Short name shown to the user, e.g. \"dev server\""),
      },
    },
    async ({ folder, command, title }) => {
      const dirs = await foldersOf(ticketId);
      const row = folder ? dirs.find((d) => d.ws.name === folder) : dirs[0];
      if (!row) return text(folder ? `No working folder "${folder}" on this ticket.` : "This ticket has no working folder.");
      const [t] = await db.select({ identifier: tickets.identifier, kind: tickets.kind }).from(tickets).where(eq(tickets.id, ticketId));
      const [me] = await db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, agentId));
      const name = title || command?.split(" ").slice(0, 3).join(" ") || `@${me!.handle}`;
      return gated(`Open terminal in ${row.ws.name}${command ? `: \`${command}\`` : ""}`, async () => {
        const info = spawnTerminal(row.ws.id, row.folder.worktreePath ?? row.ws.path, 120, 30, name, command ?? "", 0, { tags: [`@${me!.handle}`, t!.identifier], ticketId, ticketKind: t!.kind, agentId });
        await addComment(ticketId, agentId, "text", { text: `Opened terminal **${name}** in ${row.ws.name}${command ? `: \`${command}\`` : ""} (see Terminals on this ticket).` });
        return `Terminal ${info.id} opened in ${info.cwd}. Read it with terminal_read; it keeps running after your turn.`;
      });
    },
  );
  server.registerTool(
    "terminal_write",
    {
      description: "Type into a terminal you opened on this ticket. Sends input plus Enter unless enter=false (use that for raw keys like Ctrl-C = \"\\u0003\"). Read-only agents: the user approves first.",
      inputSchema: { id: z.string(), input: z.string().max(4000), enter: z.boolean().default(true) },
    },
    async ({ id, input, enter }) => {
      const t = getTerminal(id);
      if (!t || t.ticketId !== ticketId) return text("No such terminal on this ticket. Call list_terminals.");
      // Agents type only into shells they opened: never into the human's, and never into another agent's.
      if (t.agentId !== agentId) return text("That terminal was not opened by you. Read it, or open your own.");
      if (!t.alive) return text("That terminal has exited. Open a new one.");
      return gated(`Type into terminal "${t.title}": \`${enter ? input : JSON.stringify(input)}\``, async () => {
        if (!getTerminal(id)?.alive) return "That terminal has exited meanwhile.";
        writeTerminal(id, enter ? `${input}\r` : input);
        return "Sent. Wait a moment, then terminal_read.";
      });
    },
  );
  server.registerTool(
    "close_terminal",
    { description: "Close a terminal you opened on this ticket (kills its process). Read-only agents: the user approves first.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const t = getTerminal(id);
      if (!t || t.ticketId !== ticketId) return text("No such terminal on this ticket.");
      if (t.agentId !== agentId) return text("That terminal was not opened by you; ask the user to close it.");
      return gated(`Close terminal "${t.title}"`, async () => (closeTerminal(id) ? "Closed." : "Already gone."));
    },
  );

  if (canWrite) {
    if (!inPlace) server.registerTool(
      "create_worktree",
      {
        description: "Create (or reuse) the isolated git worktree and branch for a working folder. Call it before your first file change in that folder, not before.",
        inputSchema: { folder: z.string().describe("Working folder name") },
      },
      async ({ folder }) => {
        const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
        const row = (await foldersOf(ticketId)).find((f) => f.ws.name === folder);
        if (!t || !row) return text(`No working folder "${folder}" on this ticket.`);
        const { cwd, branch, setupError } = await ensureWorktree(t, row.folder, row.ws);
        emit(ticketId, { type: "ticket", ticket: { ...t, folders: (await foldersOf(ticketId)).map((f) => f.folder) } });
        return text(`Edit and commit in ${cwd}${branch ? ` (branch ${branch})` : " (not a git repo)"}.${setupError ? `\nSetup command failed:\n${setupError}` : ""}`);
      },
    );

    server.registerTool(
      "open_pr",
      {
        description: "Push this ticket's branch in every folder with new commits and open one GitHub PR per folder. Commit first. Returns the PR URLs.",
        inputSchema: { title: z.string().describe("Short PR title, no ticket ID"), body: z.string().describe("Markdown: summary, changes, test results") },
      },
      async ({ title, body }) => {
        const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
        const [org] = await db.select().from(orgs).where(eq(orgs.id, t!.orgId));
        const link = t!.linearUrl ? `[${t!.identifier}](${t!.linearUrl})` : t!.identifier;
        const folders = await foldersOf(ticketId);
        if (!t!.riskApproved) {
          const risky: string[] = [];
          for (const { folder, ws } of folders) {
            if (ws.riskPaths.length) risky.push(...(await folderDiff(folder, ws)).files.filter((f) => f.risky).map((f) => `${ws.name}: ${f.path}`));
          }
          if (risky.length) {
            await addComment(ticketId, agentId, "question", {
              question: `This change touches protected paths:\n\n${risky.map((p) => `- \`${p}\``).join("\n")}\n\nOpen the PR?`,
              options: ["Approve PR", "Hold"],
              action: "risk",
            } satisfies QuestionPayload);
            markAsked(ticketId, agentId);
            return text("Some changed files are on protected paths, so the user must approve before the PR opens. A question was posted. End your turn now; you will get a message when it is approved, then call open_pr again.");
          }
        }
        const results: string[] = [];
        for (const { folder, ws } of folders) {
          if (!(await commitsAhead(folder, ws))) continue;
          try {
            const url = await openPr(t!, folder, ws, title, `${body}\n\n---\nTicket: ${link} · opened by Zippy`);
            await db
              .update(ticketFolders)
              .set({ prUrl: url, prTitle: title, prState: "OPEN", reviewSeenAt: new Date(), ciHandledSha: null })
              .where(and(eq(ticketFolders.ticketId, ticketId), eq(ticketFolders.workspaceId, ws.id)));
            await addComment(ticketId, agentId, "pr", { url, title: `${ws.name}: ${title}` });
            attachPr(org!, t!, url, `[${t!.identifier}] ${title}`).catch(console.error);
            results.push(`${ws.name}: ${url}`);
          } catch (e) {
            results.push(`${ws.name}: could not open the PR: ${(e as Error).message}`);
          }
        }
        if (!results.length) return text("No folder has new commits. Commit your work first.");
        if (results.some((r) => r.includes("http"))) await setStatus(ticketId, "in_review");
        return text(results.join("\n"));
      },
    );
  }
  return server;
}

/** Stateless MCP endpoint: one server per request, identity from the bearer token. */
export async function handleMcp(c: Context) {
  const token = c.req.header("authorization")?.replace(/^Bearer /, "");
  const who = token && tokens.get(token);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const [agent] = await db.select({ canWrite: agents.canWrite }).from(agents).where(eq(agents.id, who.agentId));
  const [org] = await db.select({ useActiveBranch: orgs.useActiveBranch, kind: tickets.kind }).from(orgs).innerJoin(tickets, eq(tickets.orgId, orgs.id)).where(eq(tickets.id, who.ticketId));
  // Newer clients send a protocol revision the SDK rejects with 404; fall back to the default.
  const v = c.req.header("mcp-protocol-version");
  if (v && !SUPPORTED_PROTOCOL_VERSIONS.includes(v)) c.req.raw.headers.delete("mcp-protocol-version");
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const chat = org?.kind === "chat";
  await buildServer(who.ticketId, who.agentId, !!agent?.canWrite && !chat, !!org?.useActiveBranch, chat).connect(transport);
  return transport.handleRequest(c);
}
