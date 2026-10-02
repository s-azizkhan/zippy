import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { and, asc, desc, eq, gte, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { execFile } from "node:child_process";
import { z, ZodError } from "zod";
import {
  agentInput,
  approvalDecision,
  commentInput,
  labelInput,
  TICKET_ID_RE,
  linearImport,
  pipelineInput,
  routineInput,
  knowledgeInput,
  type PipelineInput,
  type ApprovalPayload,
  type InboxItem,
  type LearningPayload,
  type QuestionPayload,
  mcpServerInput,
  mentionedHandles,
  orgInput,
  patchOf,
  ticketInput,
  ticketPatch,
  workspaceInput,
  type TicketEvent,
} from "@zippy/shared";
import { bus, emit } from "./bus.ts";
import { agentSessions, agents, comments, db, knowledge, labels, mcpServers, orgs, pipelineStages, pipelines, routines, ticketFolders, tickets, workspaces } from "./db/index.ts";
import { importableMcps, installPreset, presets, scanCatalog } from "./catalog.ts";
import { addKnowledge } from "./kb.ts";
import { DEFAULT_AGENTS } from "./default-agents.ts";
import { browse, listFiles } from "./browse.ts";
import { localizeImages, readCached } from "./files.ts";
import { folderDiff, prState, runTests } from "./git.ts";
import { checkPrs } from "./github.ts";
import { authorizeUrl, completeOAuth, dropClient, fetchIssue, getIssue, listMine, ownCommentIds, verifyWebhook } from "./linear.ts";
import { handleMcp, resetHops } from "./mcp.ts";
import { humanDecision, loadPipeline, startPipeline } from "./pipeline.ts";
import { autoStart, createTicket, hasFolders, setFolders } from "./tickets.ts";
import { addComment, cancelAgent, foldersOf, acpHealth, claudeAuthStatus, claudePath, decideApproval, isRunning, runAgent, setStatus } from "./runner.ts";

export const app = new Hono().basePath("/api");

app.onError((e, c) => {
  if (e instanceof ZodError) return c.json({ error: "invalid input", issues: e.issues }, 400);
  if ((e as { cause?: { code?: string } }).cause?.code === "23505") return c.json({ error: "already exists" }, 409);
  console.error(e);
  return c.json({ error: e.message }, 500);
});

const body = async <T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T) => schema.parse(await c.req.json()) as z.infer<T>;

// Tickets are addressable by identifier (COM-768): resolve to the uuid and re-dispatch.
// Identifiers are unique per org only; pass ?org=<orgId> to disambiguate.
const byIdentifier = async (c: Context) => {
  const org = c.req.query("org");
  const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.identifier, c.req.param("id")!), org ? eq(tickets.orgId, org) : undefined));
  if (!t) return c.notFound();
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(`/tickets/${c.req.param("id")}`, `/tickets/${t.id}`);
  return app.fetch(new Request(url, c.req.raw));
};
app.all("/tickets/:id{[A-Z][A-Z0-9]+-[0-9]+}", byIdentifier);
app.all("/tickets/:id{[A-Z][A-Z0-9]+-[0-9]+}/*", byIdentifier);

app.get("/system", (c) => c.json({ claudePath, auth: claudeAuthStatus() }));
// macOS-only native folder picker; server runs on the user's machine
app.post("/system/pick-folder", (c) =>
  new Promise<Response>((res) =>
    execFile("osascript", ["-e", 'POSIX path of (choose folder with prompt "Select working folder")'], (err, out) =>
      res(c.json({ path: err ? null : out.trim().replace(/\/$/, "") })),
    ),
  ),
);
app.get("/system/acp", async (c) => c.json(await acpHealth().catch((e: Error) => ({ ok: false as const, error: e.message }))));

// Orgs
type OrgRow = typeof orgs.$inferSelect;
const publicOrg = ({ linearAuth, ...o }: OrgRow) => ({ ...o, linearConnected: !!linearAuth?.tokens });

app.get("/orgs", async (c) => c.json((await db.select().from(orgs).orderBy(asc(orgs.createdAt))).map(publicOrg)));
app.post("/orgs", async (c) => {
  const input = await body(c, orgInput);
  const org = await db.transaction(async (tx) => {
    const [o] = await tx.insert(orgs).values(input).returning();
    await tx.insert(agents).values(DEFAULT_AGENTS.map((a) => ({ ...a, orgId: o!.id })));
    return o!;
  });
  await createDefaultPipeline(org.id);
  return c.json(publicOrg(org), 201);
});
app.patch("/orgs/:id", async (c) => {
  const [o] = await db.update(orgs).set(await body(c, patchOf(orgInput))).where(eq(orgs.id, c.req.param("id"))).returning();
  return o ? c.json(publicOrg(o)) : c.notFound();
});

app.get("/catalog", (c) => c.json({ ...scanCatalog(), presets: presets() }));
app.get("/catalog/mcp", (c) => c.json(importableMcps()));
app.post("/catalog/install/:id", async (c) => ((await installPreset(c.req.param("id"))) ? c.body(null, 204) : c.notFound()));

// Org-scoped resources share the same CRUD shape.
function crud(path: string, table: PgTable & { id: any; orgId: any; createdAt: any }, input: z.ZodObject) {
  app.get(`/orgs/:orgId/${path}`, async (c) =>
    c.json(await db.select().from(table as any).where(eq(table.orgId, c.req.param("orgId"))).orderBy(asc(table.createdAt))),
  );
  app.post(`/orgs/:orgId/${path}`, async (c) => {
    const [row] = await db.insert(table).values({ ...(await body(c, input)), orgId: c.req.param("orgId") }).returning();
    return c.json(row, 201);
  });
  app.patch(`/${path}/:id`, async (c) => {
    const [row] = await db.update(table).set(await body(c, patchOf(input))).where(eq(table.id, c.req.param("id"))).returning();
    return row ? c.json(row) : c.notFound();
  });
  app.delete(`/${path}/:id`, async (c) => {
    await db.delete(table).where(eq(table.id, c.req.param("id")));
    return c.body(null, 204);
  });
}
crud("workspaces", workspaces, workspaceInput);
app.get("/workspaces/:id/files", async (c) => {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, c.req.param("id")));
  return w ? c.json(await listFiles(w.path).catch(() => [])) : c.notFound();
});
app.get("/workspaces/:id/fs", async (c) => {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, c.req.param("id")));
  if (!w) return c.notFound();
  try {
    return c.json(await browse(w.path, c.req.query("path") ?? ""));
  } catch (e: any) {
    return c.json({ error: e.code === "ENOENT" ? "Not found" : e.message }, e.code === "ENOENT" ? 404 : 400);
  }
});
crud("mcp", mcpServers, mcpServerInput);
crud("agents", agents, agentInput);
crud("labels", labels, labelInput);
crud("routines", routines, routineInput);
crud("knowledge", knowledge, knowledgeInput);

// Tickets
type TicketRow = typeof tickets.$inferSelect;

/** Attach each ticket's folders (position order). */
async function withFolders<T extends TicketRow>(rows: T[]) {
  const folders = rows.length
    ? await db.select().from(ticketFolders).where(inArray(ticketFolders.ticketId, rows.map((t) => t.id))).orderBy(asc(ticketFolders.position))
    : [];
  return rows.map((t) => ({ ...t, folders: folders.filter((f) => f.ticketId === t.id) }));
}

async function emitTicket(id: string) {
  const [t] = await withFolders(await db.select().from(tickets).where(eq(tickets.id, id)));
  if (t) emit(id, { type: "ticket", ticket: t });
  return t;
}

/** Tickets this one mentions by ID, and tickets that mention it (body or comments). */
async function related(t: TicketRow) {
  const own = await db.select({ payload: comments.payload }).from(comments).where(and(eq(comments.ticketId, t.id), eq(comments.kind, "text")));
  const text = [t.body, ...own.map((c) => (c.payload as { text?: string }).text ?? "")].join("\n");
  const out = [...new Set([...text.matchAll(TICKET_ID_RE)].map((m) => m[1]!))].filter((id) => id !== t.identifier);
  const word = `\\m${t.identifier}\\M`;
  return db
    .select({ id: tickets.id, identifier: tickets.identifier, title: tickets.title, status: tickets.status })
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, t.orgId),
        sql`${tickets.id} <> ${t.id}`,
        sql`(${out.length ? sql`${tickets.identifier} in ${out}` : sql`false`}
          or ${tickets.body} ~ ${word}
          or exists (select 1 from ${comments} where ${comments.ticketId} = ${tickets.id} and ${comments.payload}->>'text' ~ ${word}))`,
      ),
    );
}

app.get("/orgs/:orgId/tickets", async (c) =>
  c.json(await withFolders(await db.select().from(tickets).where(eq(tickets.orgId, c.req.param("orgId"))).orderBy(desc(tickets.updatedAt)))),
);
app.post("/orgs/:orgId/tickets", async (c) => {
  const ticket = await createTicket(c.req.param("orgId"), await body(c, ticketInput));
  await autoStart(ticket);
  return c.json(await emitTicket(ticket.id), 201);
});

app.get("/tickets/:id", async (c) => {
  const id = c.req.param("id");
  const [ticket] = await withFolders(await db.select().from(tickets).where(eq(tickets.id, id)));
  if (!ticket) return c.notFound();
  const brief = { id: tickets.id, identifier: tickets.identifier, title: tickets.title, status: tickets.status };
  const [timeline, sessions, rel, parent, children] = await Promise.all([
    db.select().from(comments).where(eq(comments.ticketId, id)).orderBy(asc(comments.createdAt)),
    db.select().from(agentSessions).where(eq(agentSessions.ticketId, id)),
    related(ticket),
    ticket.parentId ? db.select(brief).from(tickets).where(eq(tickets.id, ticket.parentId)) : [],
    db.select(brief).from(tickets).where(eq(tickets.parentId, id)).orderBy(asc(tickets.createdAt)),
  ]);
  return c.json({
    ticket,
    related: rel,
    parent: parent[0] ?? null,
    children,
    comments: timeline,
    sessions: sessions.map((s) => ({ ...s, running: isRunning(s.id) })),
    pipeline: ticket.pipelineId ? await loadPipeline(ticket.pipelineId) : null,
    budgetUsd: (await db.select({ b: orgs.budgetUsd }).from(orgs).where(eq(orgs.id, ticket.orgId)))[0]?.b ?? null,
  });
});

app.patch("/tickets/:id", async (c) => {
  const { workspaceIds, ...patch } = await body(c, ticketPatch);
  const [t] = await db
    .update(tickets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tickets.id, c.req.param("id")))
    .returning();
  if (!t) return c.notFound();
  if (workspaceIds) await setFolders(t.id, workspaceIds);
  return c.json(await emitTicket(t.id));
});

// Human comment. Routes to @mentioned agents, else to the assignee.
app.post("/tickets/:id/comments", async (c) => {
  const { body: text, parentId } = await body(c, commentInput);
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, c.req.param("id")));
  if (!ticket) return c.notFound();
  return c.json(await humanComment(ticket, text, { parentId }), 201);
});

/** Human comment from the UI or Linear: routes to @mentioned agents, else the replied-to agent, else the assignee. */
async function humanComment(
  ticket: TicketRow,
  text: string,
  opts: { fromLinear?: boolean; parentId?: string | null; linearCommentId?: string; author?: string } = {},
) {
  const { author, ...rest } = opts;
  const comment = await addComment(ticket.id, null, "text", { text, ...(author && { author }) }, undefined, rest);
  resetHops(ticket.id);
  const handles = mentionedHandles(text);
  const team = await db.select().from(agents).where(eq(agents.orgId, ticket.orgId));
  const [parent] = opts.parentId ? await db.select({ agentId: comments.agentId }).from(comments).where(eq(comments.id, opts.parentId)) : [];
  const fallback = parent?.agentId ?? ticket.assigneeAgentId;
  const targets = handles.length ? team.filter((a) => handles.includes(a.handle)) : team.filter((a) => a.id === fallback);
  for (const a of targets) runAgent(ticket.id, a.id, text, comment.id).catch(console.error);
  return comment;
}

app.post("/comments/:id/answer", async (c) => {
  const { answer } = await body(c, z.object({ answer: z.string().min(1) }));
  const [q] = await db.select().from(comments).where(eq(comments.id, c.req.param("id")));
  if (!q || q.kind !== "question" || !q.agentId) return c.notFound();
  const [updated] = await db.update(comments).set({ payload: { ...(q.payload as QuestionPayload), answer } }).where(eq(comments.id, q.id)).returning();
  emit(q.ticketId, { type: "comment", comment: updated });
  const qp = q.payload as QuestionPayload;
  if (qp.action === "risk" && answer === qp.options[0]) await db.update(tickets).set({ riskApproved: true }).where(eq(tickets.id, q.ticketId));
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, q.ticketId));
  const [agent] = await db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, q.agentId));
  await humanComment(ticket!, `@${agent!.handle} ${answer}`, { parentId: q.id });
  return c.body(null, 204);
});

app.post("/tickets/:id/run", async (c) => {
  const { agentId } = await body(c, z.object({ agentId: z.string().uuid().optional() }));
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, c.req.param("id")));
  const target = agentId ?? ticket?.assigneeAgentId;
  if (!ticket || !target) return c.json({ error: "assign an agent first" }, 400);
  runAgent(ticket.id, target, "Start work on this ticket.").catch(console.error);
  return c.body(null, 202);
});

app.post("/tickets/:id/cancel", async (c) => {
  const { agentId } = await body(c, z.object({ agentId: z.string().uuid() }));
  await cancelAgent(c.req.param("id"), agentId);
  return c.body(null, 202);
});

app.post("/approvals/:id", async (c) => {
  const { optionId } = await body(c, approvalDecision);
  return (await decideApproval(c.req.param("id"), optionId)) ? c.body(null, 204) : c.notFound();
});

// Pipelines
const DEFAULT_PIPELINE: { name: string; handle: string; instruction: string; onPass: string; onFail: string }[] = [
  { name: "Validate", handle: "validator", instruction: "Validate the ticket against the code. Add missing context and acceptance criteria.", onPass: "next", onFail: "human" },
  { name: "Plan", handle: "planner", instruction: "Write the implementation plan.", onPass: "next", onFail: "human" },
  { name: "Implement", handle: "executor", instruction: "Implement the plan in the worktree. Run the tests. Commit your work.", onPass: "next", onFail: "human" },
  { name: "Review", handle: "reviewer", instruction: "Review the branch diff (`git diff origin/HEAD...HEAD` or against the base branch).", onPass: "next", onFail: "2" },
  { name: "Security review", handle: "security", instruction: "Security-review the branch diff.", onPass: "next", onFail: "2" },
  { name: "Open PR", handle: "executor", instruction: "All reviews passed. Make sure everything is committed, call open_pr, then hand off pass.", onPass: "done", onFail: "human" },
];

async function createDefaultPipeline(orgId: string) {
  const team = await db.select().from(agents).where(eq(agents.orgId, orgId));
  const stages = DEFAULT_PIPELINE.flatMap((s) => {
    const a = team.find((x) => x.handle === s.handle);
    return a ? [{ name: s.name, agentId: a.id, instruction: s.instruction, onPass: s.onPass, onFail: s.onFail, humanGate: false }] : [];
  });
  return savePipeline(orgId, null, { name: "Default", autoStart: false, maxLoops: 3, stages });
}

async function savePipeline(orgId: string, id: string | null, input: PipelineInput) {
  return db.transaction(async (tx) => {
    const { stages, ...p } = input;
    const [row] = id
      ? await tx.update(pipelines).set(p).where(eq(pipelines.id, id)).returning()
      : await tx.insert(pipelines).values({ ...p, orgId }).returning();
    // Update stages in place by position so running tickets keep their stage id.
    const existing = await tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, row!.id));
    for (const [position, s] of stages.entries()) {
      const cur = existing.find((e) => e.position === position);
      if (cur) await tx.update(pipelineStages).set(s).where(eq(pipelineStages.id, cur.id));
      else await tx.insert(pipelineStages).values({ ...s, position, pipelineId: row!.id });
    }
    await tx.delete(pipelineStages).where(and(eq(pipelineStages.pipelineId, row!.id), gte(pipelineStages.position, stages.length)));
    return row!;
  });
}

app.get("/orgs/:orgId/pipelines", async (c) => {
  const rows = await db.select({ id: pipelines.id }).from(pipelines).where(eq(pipelines.orgId, c.req.param("orgId"))).orderBy(asc(pipelines.createdAt));
  return c.json(await Promise.all(rows.map((r) => loadPipeline(r.id))));
});
app.post("/orgs/:orgId/pipelines", async (c) => c.json(await savePipeline(c.req.param("orgId"), null, await body(c, pipelineInput)), 201));
app.post("/orgs/:orgId/pipelines/default", async (c) => c.json(await createDefaultPipeline(c.req.param("orgId")), 201));
app.put("/pipelines/:id", async (c) => {
  const [p] = await db.select().from(pipelines).where(eq(pipelines.id, c.req.param("id")));
  return p ? c.json(await savePipeline(p.orgId, p.id, await body(c, pipelineInput))) : c.notFound();
});
app.delete("/pipelines/:id", async (c) => {
  await db.delete(pipelines).where(eq(pipelines.id, c.req.param("id")));
  return c.body(null, 204);
});

app.post("/tickets/:id/pipeline", async (c) => {
  const { pipelineId } = await body(c, z.object({ pipelineId: z.string().uuid() }));
  const [t] = await db.select().from(tickets).where(eq(tickets.id, c.req.param("id")));
  if (!t || !(await hasFolders(t.id))) return c.json({ error: "Add a working folder first." }, 400);
  await startPipeline(t.id, pipelineId);
  return c.body(null, 202);
});
app.post("/tickets/:id/advance", async (c) => {
  const { verdict, note } = await body(c, z.object({ verdict: z.enum(["pass", "fail"]), note: z.string().optional() }));
  await humanDecision(c.req.param("id"), verdict, note);
  return c.body(null, 202);
});

// Routines: a ticket from a template every N hours.
async function runRoutine(r: typeof routines.$inferSelect) {
  await db.update(routines).set({ lastRunAt: new Date() }).where(eq(routines.id, r.id));
  const date = new Date().toISOString().slice(0, 10);
  const t = await createTicket(r.orgId, { title: `${r.title} (${date})`, body: r.body, workspaceIds: r.workspaceIds, assigneeAgentId: r.assigneeAgentId, priority: "none", labelIds: [], status: "todo" });
  if (r.pipelineId && r.workspaceIds.length) await startPipeline(t.id, r.pipelineId);
  else if (r.assigneeAgentId) runAgent(t.id, r.assigneeAgentId, "Start work on this ticket.").catch(console.error);
  return t;
}

app.post("/routines/:id/run", async (c) => {
  const [r] = await db.select().from(routines).where(eq(routines.id, c.req.param("id")));
  return r ? c.json(await runRoutine(r), 201) : c.notFound();
});

// ponytail: 1-minute tick, first run one interval after creation; "Run now" for immediate.
setInterval(async () => {
  const due = await db
    .select()
    .from(routines)
    .where(and(eq(routines.enabled, true), sql`coalesce(${routines.lastRunAt}, ${routines.createdAt}) + make_interval(hours => ${routines.everyHours}) <= now()`));
  for (const r of due) await runRoutine(r).catch((e) => console.error("[routine]", r.name, e.message));
}, 60_000).unref();

// Tickets an agent is assigned to or has a session on, newest first.
app.get("/agents/:id/work", async (c) => {
  const id = c.req.param("id");
  const rows = await db
    .select({ ticket: { id: tickets.id, identifier: tickets.identifier, title: tickets.title, status: tickets.status, updatedAt: tickets.updatedAt }, assigned: tickets.assigneeAgentId, session: { id: agentSessions.id, costUsd: agentSessions.costUsd, tokensIn: agentSessions.tokensIn, tokensOut: agentSessions.tokensOut } })
    .from(tickets)
    .leftJoin(agentSessions, and(eq(agentSessions.ticketId, tickets.id), eq(agentSessions.agentId, id)))
    .where(or(eq(tickets.assigneeAgentId, id), isNotNull(agentSessions.id)))
    .orderBy(desc(tickets.updatedAt))
    .limit(100);
  return c.json(rows.map((r) => ({ ticket: r.ticket, assigned: r.assigned === id, running: !!r.session && isRunning(r.session.id), costUsd: r.session?.costUsd ?? 0, tokens: (r.session?.tokensIn ?? 0) + (r.session?.tokensOut ?? 0) })));
});

// Agent test run: a throwaway ticket with a sample prompt, worked by that agent.
app.post("/agents/:id/test", async (c) => {
  const { workspaceIds, prompt } = await body(c, z.object({ workspaceIds: z.array(z.string().uuid()).min(1), prompt: z.string().min(1) }));
  const [a] = await db.select().from(agents).where(eq(agents.id, c.req.param("id")));
  if (!a) return c.notFound();
  const t = await createTicket(a.orgId, { title: `Test run: @${a.handle}`, body: prompt, workspaceIds, assigneeAgentId: a.id, priority: "none", labelIds: [], status: "todo" });
  runAgent(t.id, a.id, prompt).catch(console.error);
  return c.json(t, 201);
});

// Linear
app.get("/linear/connect", async (c) => c.redirect(await authorizeUrl(c.req.query("orgId")!)));
app.get("/linear/callback", async (c) => {
  await completeOAuth(c.req.query("code")!, c.req.query("state")!);
  return c.redirect(`${process.env.WEB_URL ?? "http://localhost:5199"}/settings?linear=connected`);
});
app.delete("/orgs/:id/linear", async (c) => {
  await db.update(orgs).set({ linearAuth: null, linearWorkspace: null }).where(eq(orgs.id, c.req.param("id")));
  dropClient(c.req.param("id"));
  return c.body(null, 204);
});
app.get("/orgs/:orgId/linear/issues", async (c) => {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, c.req.param("orgId")));
  const user = c.req.query("user")?.trim();
  if (!org?.linearAuth?.tokens) return c.json({ error: "Connect Linear in Settings first." }, 400);
  if (!user) return c.json({ error: "Enter your Linear username." }, 400);
  return c.json(await listMine(org, user, c.req.query("fresh") === "1"));
});
app.get("/orgs/:orgId/linear/issues/:id", async (c) => {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, c.req.param("orgId")));
  if (!org?.linearAuth?.tokens) return c.json({ error: "Connect Linear in Settings first." }, 400);
  return c.json(await getIssue(org, c.req.param("id")));
});
app.post("/orgs/:orgId/linear/import", async (c) => {
  const { ref, workspaceIds, assigneeAgentId } = await body(c, linearImport);
  const [org] = await db.select().from(orgs).where(eq(orgs.id, c.req.param("orgId")));
  if (!org?.linearAuth?.tokens) return c.json({ error: "Connect Linear in Settings first." }, 400);
  const issue = await fetchIssue(org, ref);
  const [existing] = await db.select().from(tickets).where(and(eq(tickets.orgId, org.id), eq(tickets.linearId, issue.uuid)));
  if (existing) return c.json(existing);
  // Reuse org labels by name; create missing ones with Linear's color.
  const orgLabels = await db.select().from(labels).where(eq(labels.orgId, org.id));
  const labelIds: string[] = [];
  for (const l of issue.labels.nodes) {
    const found = orgLabels.find((x) => x.name.toLowerCase() === l.name.toLowerCase());
    labelIds.push(found?.id ?? (await db.insert(labels).values({ orgId: org.id, name: l.name, color: l.color }).returning())[0]!.id);
  }
  const [ticket] = await db
    .insert(tickets)
    .values({ orgId: org.id, identifier: issue.id, title: issue.title, body: await localizeImages(issue.description ?? ""), linearId: issue.uuid, linearUrl: issue.url, assigneeAgentId, labelIds })
    .returning();
  await setFolders(ticket!.id, workspaceIds);
  await syncFromLinear(ticket!, { issue, route: false });
  await autoStart(ticket!);
  return c.json(await emitTicket(ticket!.id), 201);
});
type LinearIssue = Awaited<ReturnType<typeof fetchIssue>>;

/**
 * Pull title, description and new comments from Linear. Comments are matched by Linear id, so our own
 * mirrored comments (which store theirs) are never re-imported. `route` sends new comments to agents.
 */
async function syncFromLinear(t: TicketRow, opts: { issue?: LinearIssue; route?: boolean } = {}) {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, t.orgId));
  if (!org?.linearAuth?.tokens || !t.linearId) return 0;
  const issue = opts.issue ?? (await fetchIssue(org, t.identifier));
  if (!opts.issue) {
    const body = await localizeImages(issue.description ?? "");
    if (body !== t.body || issue.title !== t.title) {
      await db.update(tickets).set({ title: issue.title, body, updatedAt: new Date() }).where(eq(tickets.id, t.id));
      await emitTicket(t.id);
    }
  }
  const known = await db.select({ id: comments.id, lid: comments.linearCommentId }).from(comments).where(and(eq(comments.ticketId, t.id), isNotNull(comments.linearCommentId)));
  const byLinearId = new Map(known.map((k) => [k.lid!, k.id]));
  let added = 0;
  for (const cm of issue.comments.nodes) {
    if (byLinearId.has(cm.id) || ownCommentIds.has(cm.id)) continue;
    const text = await localizeImages(cm.body);
    const author = cm.user?.name ?? "Linear";
    const parentId = cm.parent ? (byLinearId.get(cm.parent.id) ?? null) : null;
    const row = opts.route
      ? await humanComment(t, text, { fromLinear: true, parentId, linearCommentId: cm.id, author })
      : await addComment(t.id, null, "text", { text, author }, undefined, { createdAt: new Date(cm.createdAt), fromLinear: true, linearCommentId: cm.id, parentId });
    byLinearId.set(cm.id, row.id);
    added++;
  }
  return added;
}

app.post("/tickets/:id/linear/sync", async (c) => {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, c.req.param("id")));
  if (!t) return c.notFound();
  return c.json({ added: await syncFromLinear(t, { route: true }) });
});

app.get("/files/:key", async (c) => {
  const f = await readCached(c.req.param("key"));
  if (!f) return c.notFound();
  return c.body(f.body, 200, { "content-type": f.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" });
});

// ponytail: polls open Linear tickets every 60s; the webhook makes this instant when a public URL exists.
setInterval(async () => {
  const open = await db.select().from(tickets).where(and(isNotNull(tickets.linearId), notInArray(tickets.status, ["done", "canceled"])));
  for (const t of open) await syncFromLinear(t, { route: true }).catch((e) => console.error("[linear sync]", t.identifier, e.message));
}, 60_000).unref();

app.post("/linear/webhook", async (c) => {
  const raw = await c.req.text();
  if (!verifyWebhook(raw, c.req.header("linear-signature"))) return c.json({ error: "bad signature" }, 401);
  const e = JSON.parse(raw) as {
    type: string;
    action: string;
    webhookTimestamp: number;
    data: { id: string; issueId?: string; body?: string; parentId?: string; botActor?: unknown };
  };
  if (Math.abs(Date.now() - e.webhookTimestamp) > 60_000) return c.json({ error: "stale" }, 401);
  if (e.type !== "Comment" || e.action !== "create" || !e.data.issueId || ownCommentIds.has(e.data.id) || e.data.botActor) return c.body(null, 204);
  const linked = await db.select().from(tickets).where(eq(tickets.linearId, e.data.issueId));
  const [parent] = e.data.parentId ? await db.select({ id: comments.id }).from(comments).where(eq(comments.linearCommentId, e.data.parentId)) : [];
  for (const ticket of linked) await humanComment(ticket, e.data.body ?? "", { fromLinear: true, parentId: parent?.id, linearCommentId: e.data.id });
  return c.body(null, 204);
});

app.all("/mcp", handleMcp);

// Verify: branch diff per folder, and on-demand test runs posted as timeline cards.
app.get("/tickets/:id/diff", async (c) => c.json(await Promise.all((await foldersOf(c.req.param("id"))).map(({ folder, ws }) => folderDiff(folder, ws, c.req.query("merged") === "1")))));

app.post("/tickets/:id/tests", async (c) => {
  const ticketId = c.req.param("id");
  const folders = (await foldersOf(ticketId)).filter(({ ws }) => ws.testCmd);
  if (!folders.length) return c.json({ error: "No folder on this ticket has a test command. Set one in Settings → Working folders." }, 400);
  for (const { folder, ws } of folders) {
    runTests(folder, ws)
      .then((result) => addComment(ticketId, null, "test", result))
      .catch(console.error);
  }
  return c.json({ started: folders.map((f) => f.ws.name) }, 202);
});

/** Everything waiting on a human, newest first. Actions reuse the answer/approval/advance routes. */
app.get("/orgs/:orgId/inbox", async (c) => {
  const open = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.orgId, c.req.param("orgId")), inArray(tickets.status, ["needs_input", "in_review", "blocked"])));
  const learnings = await db
    .select({ c: comments, t: tickets })
    .from(comments)
    .innerJoin(tickets, eq(tickets.id, comments.ticketId))
    .where(and(eq(tickets.orgId, c.req.param("orgId")), eq(comments.kind, "learning"), sql`${comments.payload}->>'status' is null`));
  const learned: InboxItem[] = learnings.map(({ c: l, t }) => ({
    kind: "learning",
    ticket: { id: t.id, identifier: t.identifier, title: t.title, status: t.status as InboxItem["ticket"]["status"] },
    commentId: l.id,
    agentId: l.agentId,
    title: (l.payload as LearningPayload).text,
    options: [{ id: "accept", label: "Add to context", primary: true }, { id: "dismiss", label: "Dismiss" }],
    createdAt: l.createdAt.toISOString(),
  }));
  if (!open.length) return c.json(learned);
  const rows = await db
    .select()
    .from(comments)
    .where(and(inArray(comments.ticketId, open.map((t) => t.id)), inArray(comments.kind, ["question", "approval", "error", "handoff", "pr", "text"])))
    .orderBy(desc(comments.createdAt));
  const items: InboxItem[] = [];
  for (const t of open) {
    const ticket = { id: t.id, identifier: t.identifier, title: t.title, status: t.status as InboxItem["ticket"]["status"] };
    const mine = rows.filter((r) => r.ticketId === t.id);
    const before = items.length;
    for (const q of mine.filter((r) => r.kind === "question" && !(r.payload as QuestionPayload).answer)) {
      const p = q.payload as QuestionPayload;
      items.push({ kind: "question", ticket, commentId: q.id, agentId: q.agentId, title: p.question, options: p.options.map((o) => ({ id: o, label: o, primary: o === p.recommended || (p.action === "risk" && o === p.options[0]) })), createdAt: q.createdAt.toISOString() });
    }
    if (t.status === "needs_input") {
      for (const a of mine.filter((r) => r.kind === "approval" && (r.payload as ApprovalPayload).decision == null)) {
        const p = a.payload as ApprovalPayload;
        items.push({ kind: "approval", ticket, commentId: a.id, agentId: a.agentId, title: p.title, options: p.options.map((o) => ({ id: o.optionId, label: o.name, primary: o.kind.startsWith("allow") })), createdAt: a.createdAt.toISOString() });
      }
    }
    if (items.length > before) continue;
    const last = mine[0];
    const lastText = last ? ((last.payload as { text?: string; summary?: string }).text ?? (last.payload as { summary?: string }).summary ?? "") : "";
    const at = (last?.createdAt ?? t.updatedAt).toISOString();
    if (t.status === "needs_input" && t.stageId) {
      items.push({ kind: "gate", ticket, agentId: last?.agentId ?? null, title: "Pipeline stage waits for you", detail: lastText, options: [{ id: "pass", label: "Approve & continue", primary: true }, { id: "fail", label: "Redo stage" }], createdAt: at });
    } else if (t.status === "in_review") {
      items.push({ kind: "review", ticket, agentId: last?.agentId ?? null, title: "Ready for your review", detail: lastText, createdAt: at });
    } else {
      items.push({ kind: "blocked", ticket, agentId: last?.agentId ?? null, title: t.status === "blocked" ? "Blocked" : "Needs input", detail: lastText, createdAt: at });
    }
  }
  return c.json([...items, ...learned].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

/** Accept a proposed learning (legacy comments) into the knowledge base, or dismiss it. */
app.post("/comments/:id/learning", async (c) => {
  const { accept } = await body(c, z.object({ accept: z.boolean() }));
  const [l] = await db.select().from(comments).where(eq(comments.id, c.req.param("id")));
  if (!l || l.kind !== "learning") return c.notFound();
  const p = l.payload as LearningPayload;
  if (p.status) return c.body(null, 204);
  if (accept) {
    const [t] = await db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, l.ticketId));
    await addKnowledge(t!.orgId, { kind: "fact", text: p.text.slice(0, 500), url: "", workspaceId: p.workspaceId, pinned: false }, { source: "agent", agentId: l.agentId, ticketId: l.ticketId });
  }
  const [updated] = await db.update(comments).set({ payload: { ...p, status: accept ? "accepted" : "dismissed" } }).where(eq(comments.id, l.id)).returning();
  emit(l.ticketId, { type: "comment", comment: updated });
  return c.body(null, 204);
});

// ponytail: polling gh every 2 min; switch to a GitHub webhook when hosted.
setInterval(() => checkPrs().catch((e) => console.error("[github]", e.message)), 120_000).unref();
setInterval(async () => {
  const open = await db.select().from(ticketFolders).where(and(isNotNull(ticketFolders.prUrl), eq(ticketFolders.prState, "OPEN")));
  const touched = new Set<string>();
  for (const f of open) {
    const state = f.worktreePath && (await prState(f.worktreePath, f.prUrl!));
    if (!state || state === "OPEN") continue;
    await db.update(ticketFolders).set({ prState: state }).where(and(eq(ticketFolders.ticketId, f.ticketId), eq(ticketFolders.workspaceId, f.workspaceId)));
    touched.add(f.ticketId);
  }
  for (const ticketId of touched) {
    const prs = (await db.select().from(ticketFolders).where(eq(ticketFolders.ticketId, ticketId))).filter((f) => f.prUrl);
    if (prs.every((f) => f.prState === "MERGED")) await setStatus(ticketId, "done");
    else await emitTicket(ticketId);
  }
}, 120_000).unref();

app.get("/tickets/:id/events", (c) =>
  streamSSE(c, async (stream) => {
    const id = c.req.param("id");
    const send = (e: TicketEvent) => void stream.writeSSE({ data: JSON.stringify(e) });
    bus.on(id, send);
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 20_000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    bus.off(id, send);
  }),
);
