import { randomUUID } from "node:crypto";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { KB_KINDS, httpUrl, type QuestionPayload } from "@zippy/shared";
import { agents, db, knowledge, orgs, ticketFolders, tickets } from "./db/index.ts";
import { addKnowledge, byShortId, render, search } from "./kb.ts";
import { commitsAhead, folderDiff, openPr } from "./git.ts";
import { attachPr, createSubIssue } from "./linear.ts";
import { createTicket } from "./tickets.ts";
import { handoff, markAsked } from "./pipeline.ts";
import { addComment, foldersOf, runAgent, setStatus } from "./runner.ts";

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

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function buildServer(ticketId: string, agentId: string, canWrite: boolean) {
  const server = new McpServer({ name: "zippy", version: "0.1.0" });

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
      description: "Ask another agent on this ticket to do something. It runs in its own session and replies on the ticket.",
      inputSchema: { handle: z.string().describe("Agent handle without @"), message: z.string() },
    },
    async ({ handle, message }) => {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
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

  if (canWrite) {
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
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await buildServer(who.ticketId, who.agentId, !!agent?.canWrite).connect(transport);
  return transport.handleRequest(c);
}
