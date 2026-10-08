import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { execFile } from "node:child_process";
import { z, ZodError } from "zod";
import {
  agentInput,
  approvalDecision,
  commentInput,
  folderHandle,
  labelInput,
  TICKET_ID_RE,
  linearImport,
  pipelineInput,
  nextRunAt,
  routineInput,
  terminalTemplateInput,
  knowledgeInput,
  type PipelineInput,
  type WorkspaceInput,
  type ApprovalPayload,
  type InboxItem,
  type DraftPayload,
  type LearningPayload,
  type QuestionPayload,
  mcpServerInput,
  mentionedHandles,
  orgCreate,
  orgInput,
  patchOf,
  ticketInput,
  ticketPatch,
  todoInput,
  workspaceInput,
  type TicketEvent,
} from "@zippy/shared";
import { bus, emit } from "./bus.ts";
import { reqlog } from "./reqlog.ts";
import { agentSessions, agents, comments, db, knowledge, labels, mcpServers, orgs, pipelineStages, pipelines, routines, terminalTemplates, ticketFolders, tickets, todos, workspaces } from "./db/index.ts";
import { createDb, maskUrl, readConfig, saveDbUrl, testDb, writeConfig } from "./dbadmin.ts";
import { importableMcps, installPreset, presets, scanCatalog } from "./catalog.ts";
import { addKnowledge } from "./kb.ts";
import { desktopNote, takeNotes } from "./notify.ts";
import { DEFAULT_AGENTS } from "./default-agents.ts";
import { browse, listFiles, resolveIn } from "./browse.ts";
import { localizeImages, readCached, readUpload, saveUpload } from "./files.ts";
import { bodyLimit } from "hono/body-limit";
import { branchInfo, checkout, commitFiles, createBranch, detectFolder, fetchAll, folderDiff, isRepo, mergePr, popStash, prState, pullFf, pushHead, runTests, setIdentity, workingDiff } from "./git.ts";
import { checkPrs } from "./github.ts";
import { authorizeUrl, completeOAuth, dropClient, fetchIssue, listMine, ownCommentIds, verifyWebhook } from "./linear.ts";
import { handleMcp, resetHops } from "./mcp.ts";
import { humanDecision, loadPipeline, startPipeline } from "./pipeline.ts";
import { autoStart, createTicket, hasFolders, setFolders } from "./tickets.ts";
import { killPid, listPorts } from "./ports.ts";
import { closeTerminal, getTerminal, listTerminals, readTerminal, renameTerminal, resizeTerminal, restartTerminal, setTags, spawnTerminal, userEnv, writeTerminal } from "./term.ts";
import { addComment, cancelAgent, foldersOf, acpHealth, claudeAuthStatus, claudeUsage, claudePath, decideApproval, dropIdle, isRunning, runAgent, setStatus } from "./runner.ts";

export const app = new Hono().basePath("/api");
app.use(reqlog);
// CSRF: other sites can only send simple POSTs (form/text body, no custom headers). JSON or x-zippy forces a CORS preflight, which is never answered.
app.use(async (c, next) => {
  if (c.req.method === "POST" && !c.req.header("content-type")?.startsWith("application/json") && !c.req.header("x-zippy")) return c.json({ error: "JSON body required" }, 415);
  await next();
});

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
  const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.identifier, c.req.param("id")!), isNull(tickets.deletedAt), org ? eq(tickets.orgId, org) : undefined));
  if (!t) return c.notFound();
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(`/tickets/${c.req.param("id")}`, `/tickets/${t.id}`);
  return app.fetch(new Request(url, c.req.raw));
};
app.all("/tickets/:id{[A-Z][A-Z0-9]+-[0-9]+}", byIdentifier);
app.all("/tickets/:id{[A-Z][A-Z0-9]+-[0-9]+}/*", byIdentifier);

app.get("/system", (c) => c.json({ claudePath, auth: claudeAuthStatus() }));
// Port manager: what is listening, which command opened it, and a way to stop it.
app.get("/system/ports", async (c) => c.json(await listPorts()));
app.get("/system/ports/:port", async (c) => {
  const port = z.coerce.number().int().min(1).max(65535).parse(c.req.param("port"));
  return c.json(await listPorts(port));
});
app.post("/system/ports/:port/kill", async (c) => {
  const port = z.coerce.number().int().min(1).max(65535).parse(c.req.param("port"));
  const { force, pids } = z.object({ force: z.boolean().default(false), pids: z.array(z.number().int()).optional() }).parse(await c.req.json().catch(() => ({})));
  const rows = (await listPorts(port)).filter((r) => (pids ? pids.includes(r.pid) : true));
  if (!rows.length) return c.json({ error: `Nothing is listening on ${port}` }, 404);
  const killed: number[] = [];
  for (const r of new Map(rows.map((r) => [r.pid, r])).values()) {
    try {
      killPid(r.pid, force);
      killed.push(r.pid);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
  return c.json({ killed });
});
// macOS-only native folder picker; server runs on the user's machine
app.post("/system/pick-folder", (c) =>
  new Promise<Response>((res) =>
    execFile("osascript", ["-e", 'POSIX path of (choose folder with prompt "Select working folder")'], (err, out) =>
      res(c.json({ path: err ? null : out.trim().replace(/\/$/, "") })),
    ),
  ),
);
const dbUrl = z.object({ url: z.string().regex(/^postgres(ql)?:\/\/\S+$/, "must start with postgres://") });
app.get("/system/db", (c) => c.json({ desktop: !!process.env.ZIPPY_CONFIG, mode: process.env.ZIPPY_DB_MODE ?? "env", url: maskUrl(process.env.DATABASE_URL) }));
app.post("/system/db/test", async (c) => c.json(await testDb((await body(c, dbUrl)).url)));
app.post("/system/db/create", async (c) => (await createDb((await body(c, dbUrl)).url), c.body(null, 204)));
app.post("/system/db/save", async (c) => {
  if (!process.env.ZIPPY_CONFIG) return c.json({ error: "desktop app only, set DATABASE_URL in .env" }, 400);
  const { url } = await body(c, z.object({ url: dbUrl.shape.url.nullable() }));
  const t = url && (await testDb(url));
  if (t && !t.ok) return c.json({ error: t.error }, 400);
  saveDbUrl(url);
  return c.body(null, 204);
});
// Desktop global shortcut for the capture box. null = off. The shell re-reads config.json on its tray poll.
const DEFAULT_HOTKEY = "CmdOrCtrl+Shift+Z";
app.get("/system/hotkey", (c) => {
  const desktop = !!process.env.ZIPPY_CONFIG;
  const v = desktop ? readConfig().hotkey : undefined;
  return c.json({ desktop, hotkey: v === undefined ? DEFAULT_HOTKEY : v });
});
app.post("/system/hotkey", async (c) => {
  if (!process.env.ZIPPY_CONFIG) return c.json({ error: "desktop app only" }, 400);
  const { hotkey } = await body(c, z.object({ hotkey: z.string().regex(/^((CmdOrCtrl|Cmd|Ctrl|Alt|Option|Shift|Super|Meta)\+)+[A-Za-z0-9]|F\d{1,2}$/, "modifier + key, e.g. CmdOrCtrl+Shift+Z").nullable() }));
  writeConfig({ hotkey: hotkey === DEFAULT_HOTKEY ? undefined : hotkey });
  return c.body(null, 204);
});
app.post("/system/test-notification", (c) => (desktopNote("Zippy", "Notifications are working."), c.body(null, 204)));
app.get("/system/usage", async (c) => c.json(await claudeUsage()));
app.get("/system/acp", async (c) => c.json(await acpHealth().catch((e: Error) => ({ ok: false as const, error: e.message }))));

// Orgs
type OrgRow = typeof orgs.$inferSelect;
const publicOrg = ({ linearAuth, ...o }: OrgRow) => ({ ...o, linearConnected: !!linearAuth?.tokens });

// Agent library offered in onboarding. Description = the role's first sentence.
app.get("/default-agents", (c) => c.json(DEFAULT_AGENTS.map((a) => ({ handle: a.handle, name: a.name, color: a.color, canWrite: a.canWrite, description: a.rolePromptMd.split("\n").find((l, i) => i > 0 && l.trim()) ?? "" }))));
app.get("/orgs", async (c) => c.json((await db.select().from(orgs).orderBy(asc(orgs.createdAt))).map(publicOrg)));
app.post("/orgs", async (c) => {
  const { agents: picked, ...input } = await body(c, orgCreate);
  const org = await db.transaction(async (tx) => {
    const [o] = await tx.insert(orgs).values(input).returning();
    const chosen = DEFAULT_AGENTS.filter((a) => !picked || picked.includes(a.handle));
    if (chosen.length) await tx.insert(agents).values(chosen.map((a) => ({ ...a, orgId: o!.id })));
    return o!;
  });
  await createStarterPipelines(org.id);
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
function crud(path: string, table: PgTable & { id: any; orgId: any; createdAt: any }, input: z.ZodObject, prepare = async (v: any) => v) {
  app.get(`/orgs/:orgId/${path}`, async (c) =>
    c.json(await db.select().from(table as any).where(eq(table.orgId, c.req.param("orgId"))).orderBy(asc(table.createdAt))),
  );
  app.post(`/orgs/:orgId/${path}`, async (c) => {
    const [row] = await db.insert(table).values({ ...(await prepare(await body(c, input))), orgId: c.req.param("orgId") }).returning();
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
// Unset fields come from the repo: "main" is the schema default, so it yields to origin's HEAD.
crud("workspaces", workspaces, workspaceInput, async (w: WorkspaceInput) => {
  const d = await detectFolder(w.path);
  return { ...w, baseBranch: w.baseBranch === "main" ? d.baseBranch || "main" : w.baseBranch, setupCmd: w.setupCmd || d.setupCmd, testCmd: w.testCmd || d.testCmd };
});
crud("todos", todos, todoInput);
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
// Git controls for a working folder's own checkout (not ticket worktrees).
app.get("/workspaces/:id/git", async (c) => {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, c.req.param("id")));
  return w ? c.json(await branchInfo(w.path)) : c.notFound();
});
app.get("/workspaces/:id/git/diff", async (c) => {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, c.req.param("id")));
  if (!w) return c.notFound();
  return (await isRepo(w.path)) ? c.json(await workingDiff(w.path)) : c.json({ error: `${w.name} is not a git repository.` }, 400);
});
const gitOp = {
  checkout: z.object({ branch: z.string().min(1), stash: z.boolean().default(false) }),
  branch: z.object({ name: z.string().trim().min(1).max(200) }),
  commit: z.object({ message: z.string().trim().min(1).max(10_000), files: z.array(z.string()).min(1), push: z.boolean().default(false) }),
  fetch: z.object({}),
  pull: z.object({}),
  push: z.object({}),
  pop: z.object({}),
  identity: z.object({ name: z.string().trim().max(200).regex(/^[^\n<>]*$/, "no newlines or <>"), email: z.union([z.literal(""), z.email().max(200)]) }),
};
app.post("/workspaces/:id/git/:op{checkout|branch|commit|fetch|pull|push|pop|identity}", async (c) => {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, c.req.param("id")));
  if (!w) return c.notFound();
  const op = c.req.param("op") as keyof typeof gitOp;
  try {
    if (!(await isRepo(w.path))) return c.json({ error: `${w.name} is not a git repository.` }, 400);
    const v: any = gitOp[op].parse(await c.req.json().catch(() => ({})));
    if (op === "checkout") await checkout(w.path, v.branch, v.stash);
    else if (op === "branch") await createBranch(w.path, v.name);
    else if (op === "identity") await setIdentity(w.path, v.name, v.email);
    else if (op === "commit") {
      await commitFiles(w.path, v.message, v.files);
      if (v.push) await pushHead(w.path);
    } else await ({ fetch: fetchAll, pull: pullFf, push: pushHead, pop: popStash } as const)[op as "fetch" | "pull" | "push" | "pop"](w.path);
    return c.body(null, 204);
  } catch (e: any) {
    if (e instanceof ZodError) throw e;
    return c.json({ error: (e.stderr || e.message).trim().split("\n").filter((l: string) => !l.startsWith("Command failed")).join("\n").slice(-500) || e.message }, 400);
  }
});
// Hand a folder or file to the OS: reveal in Finder or open in the user's editor. Server runs on the user's machine.
app.post("/workspaces/:id/open", async (c) => {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, c.req.param("id")));
  if (!w) return c.notFound();
  const { path, app: target } = await body(c, z.object({ path: z.string().default(""), app: z.enum(["finder", "editor"]) }));
  const abs = await resolveIn(w.path, path).catch(() => null);
  if (!abs) return c.json({ error: "Not found" }, 404);
  const mac = process.platform === "darwin";
  const run = (cmd: string, args: string[]) => new Promise<boolean>((res) => execFile(cmd, args, { env: userEnv() }, (err) => res(!err)));
  // ponytail: VS Code's `code` CLI, else the OS default app. Add an editor setting if people use something else.
  const ok = target === "finder" ? await run(mac ? "open" : "xdg-open", mac && path ? ["-R", abs] : [abs]) : (await run("code", [abs])) || (await run(mac ? "open" : "xdg-open", [abs]));
  return ok ? c.body(null, 204) : c.json({ error: `Could not open ${abs}` }, 500);
});
// Terminals: one PTY per session, grouped by working folder; live only as long as the server.
app.get("/orgs/:id/terminals", async (c) => {
  const ws = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, c.req.param("id")));
  return c.json(listTerminals(ws.map((w) => w.id)));
});
app.post("/workspaces/:id/terminals", async (c) => {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, c.req.param("id")));
  if (!w) return c.notFound();
  const { cols, rows, title, command } = z
    .object({ cols: z.number().int().min(1).max(500).default(80), rows: z.number().int().min(1).max(200).default(24), title: z.string().trim().max(60).optional(), command: z.string().trim().max(2000).default("") })
    .parse(await c.req.json().catch(() => ({})));
  try {
    return c.json(spawnTerminal(w.id, w.path, cols, rows, title, command), 201);
  } catch (e: any) {
    return c.json({ error: `Could not start shell: ${e.message}` }, 500);
  }
});
app.get("/terminals/:id/events", (c) => {
  const s = getTerminal(c.req.param("id"));
  if (!s) return c.notFound();
  return streamSSE(c, async (stream) => {
    const data = (d: string) => void stream.writeSSE({ data: JSON.stringify(d) });
    const exit = (code: number) => void stream.writeSSE({ event: "exit", data: String(code) });
    const restart = () => void stream.writeSSE({ event: "restart", data: "" });
    if (s.buf) void stream.writeSSE({ event: "replay", data: JSON.stringify(s.buf) });
    if (!s.alive) exit(s.exitCode ?? 0);
    s.events.on("data", data).on("exit", exit).on("restart", restart);
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 20_000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    s.events.off("data", data).off("exit", exit).off("restart", restart);
  });
});
app.post("/terminals/:id/input", async (c) => {
  const { data } = z.object({ data: z.string().max(1_000_000) }).parse(await c.req.json());
  return getTerminal(c.req.param("id")) ? (writeTerminal(c.req.param("id"), data), c.body(null, 204)) : c.notFound();
});
app.post("/terminals/:id/resize", async (c) => {
  const { cols, rows } = z.object({ cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(200) }).parse(await c.req.json());
  return getTerminal(c.req.param("id")) ? (resizeTerminal(c.req.param("id"), cols, rows), c.body(null, 204)) : c.notFound();
});
app.patch("/terminals/:id", async (c) => {
  const { title, tags } = z.object({ title: z.string().trim().min(1).max(60).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(12).optional() }).parse(await c.req.json());
  const id = c.req.param("id");
  if (!getTerminal(id)) return c.notFound();
  if (title) renameTerminal(id, title);
  if (tags) setTags(id, tags);
  return c.body(null, 204);
});
app.get("/terminals/:id/text", (c) => {
  const text = readTerminal(c.req.param("id"), Math.min(2000, Number(c.req.query("lines")) || 200));
  return text === null ? c.notFound() : c.text(text);
});
// A shell for a ticket: cwd is the folder's worktree when it has one; tagged with the ticket so it shows on the ticket and in the Terminals rail.
app.post("/tickets/:id/terminals", async (c) => {
  const ticketId = c.req.param("id");
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t) return c.notFound();
  const { workspaceId, command, title } = z.object({ workspaceId: z.string().uuid(), command: z.string().trim().max(2000).default(""), title: z.string().trim().max(60).optional() }).parse(await c.req.json());
  const row = (await foldersOf(ticketId)).find((f) => f.ws.id === workspaceId);
  if (!row) return c.json({ error: "That folder is not on this ticket." }, 400);
  try {
    return c.json(spawnTerminal(row.ws.id, row.folder.worktreePath ?? row.ws.path, 80, 24, title || `${t.identifier}${command ? ` ${command.split(" ").slice(0, 3).join(" ")}` : ""}`, command, 0, { tags: [t.identifier], ticketId, ticketKind: t.kind }), 201);
  } catch (e: any) {
    return c.json({ error: `Could not start shell: ${e.message}` }, 500);
  }
});
crud("terminal-templates", terminalTemplates, terminalTemplateInput);
// Run = one shell per step, in that step's folder, with the command typed in as if by the user.
app.post("/terminal-templates/:id/run", async (c) => {
  const [t] = await db.select().from(terminalTemplates).where(eq(terminalTemplates.id, c.req.param("id")));
  if (!t) return c.notFound();
  const ws = new Map((await db.select().from(workspaces).where(eq(workspaces.orgId, t.orgId))).map((w) => [w.id, w]));
  const opened = [];
  for (const step of t.steps) {
    const w = ws.get(step.workspaceId);
    if (!w) continue;
    opened.push(spawnTerminal(w.id, w.path, 80, 24, step.title, step.command, step.delaySec ?? 0));
  }
  return c.json(opened, 201);
});
app.post("/terminals/:id/restart", (c) => {
  const t = restartTerminal(c.req.param("id"));
  return t ? c.json(t) : c.notFound();
});
app.delete("/terminals/:id", (c) => (closeTerminal(c.req.param("id")) ? c.body(null, 204) : c.notFound()));
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
        isNull(tickets.deletedAt),
        sql`${tickets.id} <> ${t.id}`,
        sql`(${out.length ? sql`${tickets.identifier} in ${out}` : sql`false`}
          or ${tickets.body} ~ ${word}
          or exists (select 1 from ${comments} where ${comments.ticketId} = ${tickets.id} and ${comments.payload}->>'text' ~ ${word}))`,
      ),
    );
}

app.get("/orgs/:orgId/tickets", async (c) =>
  c.json(await withFolders(await db.select().from(tickets).where(and(eq(tickets.orgId, c.req.param("orgId")), eq(tickets.kind, "ticket"), isNull(tickets.deletedAt))).orderBy(desc(tickets.updatedAt)))),
);

// Chats: conversations with one agent, kept off the board. Tickets come out of them via the create_ticket tool.
app.get("/orgs/:orgId/chats", async (c) =>
  c.json(await db.select().from(tickets).where(and(eq(tickets.orgId, c.req.param("orgId")), eq(tickets.kind, "chat"), isNull(tickets.deletedAt), eq(tickets.archived, c.req.query("archived") === "1"))).orderBy(desc(tickets.createdAt))),
);
app.post("/orgs/:orgId/chats", async (c) => {
  const { agentId, workspaceIds, message } = await body(c, z.object({ agentId: z.string().uuid(), workspaceIds: z.array(z.string().uuid()).min(1), message: z.string().min(1) }));
  const chat = await createTicket(c.req.param("orgId"), { title: message.split("\n")[0]!.slice(0, 60), body: "", workspaceIds, assigneeAgentId: agentId, priority: "none", labelIds: [], status: "todo" }, { chat: true });
  await humanComment(chat, message);
  return c.json(chat, 201);
});
app.post("/orgs/:orgId/tickets", async (c) => {
  const ticket = await createTicket(c.req.param("orgId"), await body(c, ticketInput));
  await autoStart(ticket);
  return c.json(await emitTicket(ticket.id), 201);
});

// Quick capture (CLI, tray): the folder containing `cwd`, else the first org's first folder.
app.post("/quick", async (c) => {
  const { title, body: text, cwd } = await body(c, z.object({ title: z.string().min(1).max(200), body: z.string().default(""), cwd: z.string().optional() }));
  const all = await db.select().from(workspaces).orderBy(asc(workspaces.createdAt));
  const [first] = await db.select({ id: orgs.id }).from(orgs).orderBy(asc(orgs.createdAt)).limit(1);
  const ws = all.find((w) => cwd && (cwd === w.path || cwd.startsWith(`${w.path}/`))) ?? all.find((w) => w.orgId === first?.id);
  const orgId = ws?.orgId ?? first?.id;
  if (!orgId) return c.json({ error: "Create an organization first." }, 400);
  const ticket = await createTicket(orgId, ticketInput.parse({ title, body: text, workspaceIds: ws ? [ws.id] : [] }));
  await autoStart(ticket);
  return c.json(await emitTicket(ticket.id), 201);
});

// Queue: start a pipeline on every Todo ticket that has a folder and none running. Org maxLive caps how many run at once.
app.post("/orgs/:orgId/queue", async (c) => {
  const { pipelineId } = await body(c, z.object({ pipelineId: z.string().uuid() }));
  const rows = await db
    .selectDistinct({ id: tickets.id })
    .from(tickets)
    .innerJoin(ticketFolders, eq(ticketFolders.ticketId, tickets.id))
    .where(and(eq(tickets.orgId, c.req.param("orgId")), eq(tickets.kind, "ticket"), eq(tickets.status, "todo"), eq(tickets.archived, false), isNull(tickets.deletedAt), isNull(tickets.stageId)));
  for (const r of rows) startPipeline(r.id, pipelineId).catch(console.error);
  return c.json({ started: rows.length });
});

app.get("/tickets/:id", async (c) => {
  const id = c.req.param("id");
  const [ticket] = await withFolders(await db.select().from(tickets).where(and(eq(tickets.id, id), isNull(tickets.deletedAt))));
  if (!ticket) return c.notFound();
  const brief = { id: tickets.id, identifier: tickets.identifier, title: tickets.title, status: tickets.status };
  const [timeline, sessions, rel, parent, children] = await Promise.all([
    db.select().from(comments).where(eq(comments.ticketId, id)).orderBy(asc(comments.createdAt)),
    db.select().from(agentSessions).where(eq(agentSessions.ticketId, id)),
    related(ticket),
    ticket.parentId ? db.select(brief).from(tickets).where(eq(tickets.id, ticket.parentId)) : [],
    db.select(brief).from(tickets).where(and(eq(tickets.parentId, id), isNull(tickets.deletedAt))).orderBy(asc(tickets.createdAt)),
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
  const [before] = await db.select({ agent: tickets.assigneeAgentId }).from(tickets).where(eq(tickets.id, c.req.param("id")));
  const [t] = await db
    .update(tickets)
    .set({ ...patch, ...(patch.assigneeAgentId && { assigneeHuman: false }), ...(patch.assigneeHuman && { assigneeAgentId: null }), updatedAt: new Date() })
    .where(eq(tickets.id, c.req.param("id")))
    .returning();
  if (!t) return c.notFound();
  if (workspaceIds) {
    await setFolders(t.id, workspaceIds);
    dropIdle(t.id);
  }
  if (patch.assigneeAgentId && patch.assigneeAgentId !== before?.agent) runAgent(t.id, patch.assigneeAgentId, "Start work on this ticket.").catch(console.error);
  return c.json(await emitTicket(t.id));
});

// Soft delete an archived ticket and its sub-issues; related rows stay but are unreachable.
app.delete("/tickets/:id", async (c) => {
  const id = c.req.param("id");
  const [t] = await db.update(tickets).set({ deletedAt: new Date() }).where(and(eq(tickets.id, id), eq(tickets.archived, true), isNull(tickets.deletedAt))).returning({ id: tickets.id });
  if (!t) return c.json({ error: "Only archived tickets can be deleted." }, 409);
  await db.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.parentId, id));
  return c.body(null, 204);
});

// Human comment. Routes to @mentioned agents, else to the assignee.
app.post("/tickets/:id/comments", async (c) => {
  const { body: text, parentId } = await body(c, commentInput);
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, c.req.param("id")));
  if (!ticket) return c.notFound();
  if (ticket.kind === "chat" && ticket.archived) return c.json({ error: "This chat is archived. Unarchive it to continue." }, 409);
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
  if (ticket.kind === "chat") {
    // @folder-name in a chat brings that folder in.
    const have = (await foldersOf(ticket.id)).map((f) => f.ws.id);
    const add = (await db.select().from(workspaces).where(eq(workspaces.orgId, ticket.orgId))).filter((w) => !have.includes(w.id) && handles.includes(folderHandle(w.name)));
    if (add.length) {
      await setFolders(ticket.id, [...have, ...add.map((w) => w.id)]);
      dropIdle(ticket.id);
      await emitTicket(ticket.id);
    }
  }
  const team = await db.select().from(agents).where(eq(agents.orgId, ticket.orgId));
  const [parent] = opts.parentId ? await db.select({ agentId: comments.agentId }).from(comments).where(eq(comments.id, opts.parentId)) : [];
  const fallback = parent?.agentId ?? ticket.assigneeAgentId;
  const targets = handles.length ? team.filter((a) => handles.includes(a.handle)) : team.filter((a) => a.id === fallback);
  for (const a of targets) runAgent(ticket.id, a.id, text, comment.id).catch(console.error);
  return comment;
}

// The new-issue dialog reports the ticket it created from a chat draft.
app.post("/comments/:id/created", async (c) => {
  const { identifier } = await body(c, z.object({ identifier: z.string() }));
  const [d] = await db.select().from(comments).where(and(eq(comments.id, c.req.param("id")), eq(comments.kind, "draft")));
  if (!d) return c.notFound();
  const [updated] = await db.update(comments).set({ payload: { ...(d.payload as DraftPayload), identifier } }).where(eq(comments.id, d.id)).returning();
  emit(d.ticketId, { type: "comment", comment: updated });
  return c.body(null, 204);
});

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
type Preset = { name: string; stages: { name: string; handle: string; instruction: string; onPass?: string; onFail?: string; humanGate?: boolean }[] };
const ST = {
  validate: { name: "Validate", handle: "validator", instruction: "Validate the ticket against the code. Add missing context and acceptance criteria." },
  plan: { name: "Plan", handle: "planner", instruction: "Write the implementation plan." },
  implement: { name: "Implement", handle: "executor", instruction: "Implement the plan in the worktree. Run the tests. Commit your work." },
  review: { name: "Review", handle: "reviewer", instruction: "Review the branch diff (`git diff origin/HEAD...HEAD` or against the base branch)." },
  security: { name: "Security review", handle: "security", instruction: "Security-review the branch diff." },
  pr: { name: "Open PR", handle: "executor", instruction: "All reviews passed. Make sure everything is committed, call open_pr, then hand off pass.", onPass: "done" },
};
// onFail: "human" (default) or the 0-based index of the stage to loop back to.
const PRESETS: Preset[] = [
  { name: "Default", stages: [ST.validate, ST.plan, ST.implement, { ...ST.review, onFail: "2" }, { ...ST.security, onFail: "2" }, ST.pr] },
  { name: "Quick fix", stages: [ST.implement, { ...ST.review, onFail: "0" }, ST.pr] },
  { name: "Plan and build", stages: [ST.plan, ST.implement, ST.pr] },
  { name: "Secure build", stages: [ST.plan, ST.implement, { ...ST.security, onFail: "1" }, { ...ST.review, onFail: "1" }, ST.pr] },
  {
    name: "Debug and fix",
    stages: [
      { name: "Diagnose", handle: "debugger", instruction: "Reproduce the problem and find the root cause. Do not change code; write up the findings." },
      { ...ST.implement, instruction: "Fix the root cause found in the diagnosis. Add a regression test. Run the tests. Commit your work." },
      { name: "Test", handle: "tester", instruction: "Run the full test suite and try to break the fix.", onFail: "1" },
      ST.pr,
    ],
  },
  {
    name: "Research and design",
    stages: [
      { name: "Research", handle: "researcher", instruction: "Research the problem, existing code and prior art. Summarize the findings." },
      { name: "Design", handle: "architect", instruction: "Propose a design with trade-offs.", humanGate: true },
      ST.implement,
      { ...ST.review, onFail: "2" },
      ST.pr,
    ],
  },
  { name: "Docs", stages: [{ name: "Write docs", handle: "docs", instruction: "Write or update the documentation for this ticket. Commit your work." }, { ...ST.review, onFail: "0" }, ST.pr] },
];

// Adds the presets that don't exist yet; skips ones whose agents aren't on the team.
async function createStarterPipelines(orgId: string) {
  const [team, have] = await Promise.all([db.select().from(agents).where(eq(agents.orgId, orgId)), db.select({ name: pipelines.name }).from(pipelines).where(eq(pipelines.orgId, orgId))]);
  const made = [];
  for (const p of PRESETS) {
    const stages = p.stages.map((s) => ({ name: s.name, agentId: team.find((a) => a.handle === s.handle)?.id, instruction: s.instruction, onPass: s.onPass ?? "next", onFail: s.onFail ?? "human", humanGate: s.humanGate ?? false }));
    if (have.some((h) => h.name === p.name) || stages.some((s) => !s.agentId)) continue;
    made.push(await savePipeline(orgId, null, { name: p.name, autoStart: false, labelIds: [], maxLoops: 3, stages: stages as PipelineInput["stages"] }));
  }
  return made;
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
app.post("/orgs/:orgId/pipelines/default", async (c) => c.json(await createStarterPipelines(c.req.param("orgId")), 201));
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
  const t = await createTicket(r.orgId, { title: `${r.title} (${date})`, body: r.body, workspaceIds: r.workspaceIds, assigneeAgentId: r.assigneeAgentId, priority: "none", labelIds: [], status: "todo" }, { routineId: r.id });
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
  const due = (await db.select().from(routines).where(eq(routines.enabled, true))).filter((r) => nextRunAt(r) <= new Date());
  for (const r of due) await runRoutine(r).catch((e) => console.error("[routine]", r.name, e.message));
}, 60_000).unref();

// Agent sessions mid-turn right now (tickets and chats).
async function runningOf(orgId: string) {
  const rows = await db
    .select({ s: agentSessions, t: { id: tickets.id, identifier: tickets.identifier, title: tickets.title, kind: tickets.kind } })
    .from(agentSessions)
    .innerJoin(tickets, eq(tickets.id, agentSessions.ticketId))
    .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt)));
  return rows.filter((r) => isRunning(r.s.id)).map((r) => ({ agentId: r.s.agentId, ticket: r.t, costUsd: r.s.costUsd }));
}
app.get("/orgs/:orgId/running", async (c) => c.json(await runningOf(c.req.param("orgId"))));

// Tickets an agent is assigned to or has a session on, newest first.
app.get("/agents/:id/work", async (c) => {
  const id = c.req.param("id");
  const rows = await db
    .select({ ticket: { id: tickets.id, identifier: tickets.identifier, title: tickets.title, status: tickets.status, updatedAt: tickets.updatedAt }, assigned: tickets.assigneeAgentId, session: { id: agentSessions.id, costUsd: agentSessions.costUsd, tokensIn: agentSessions.tokensIn, tokensOut: agentSessions.tokensOut } })
    .from(tickets)
    .leftJoin(agentSessions, and(eq(agentSessions.ticketId, tickets.id), eq(agentSessions.agentId, id)))
    .where(and(eq(tickets.kind, "ticket"), isNull(tickets.deletedAt), or(eq(tickets.assigneeAgentId, id), isNotNull(agentSessions.id))))
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
  if (!process.env.ZIPPY_CONFIG) return c.redirect(`${process.env.WEB_URL ?? "http://localhost:5199"}/settings?linear=connected`);
  // Desktop: OAuth ran in the user's browser; hand back to the app.
  const back = "zippy://settings?linear=connected";
  return c.html(`<!doctype html><meta charset="utf-8"><title>Zippy</title><body style="font:15px system-ui;display:grid;place-items:center;height:90vh"><p>Linear connected. <a href="${back}">Return to Zippy</a>, then close this tab.</p><script>location.href=${JSON.stringify(back)}</script>`);
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
  const issue = await fetchIssue(org, c.req.param("id"));
  const comments = await Promise.all(issue.comments.nodes.map(async (cm) => ({ id: cm.id, body: await localizeImages(cm.body), createdAt: cm.createdAt, author: cm.user?.name ?? null, parentId: cm.parentId })));
  const x = issue as typeof issue & { status?: string; statusType?: string; priority?: { name: string }; assignee?: string; createdBy?: string; team?: string; dueDate?: string; createdAt?: string; attachments?: { id: string; title: string; url: string }[] };
  return c.json({ uuid: issue.uuid, id: issue.id, title: issue.title, url: issue.url, status: x.status, statusType: x.statusType, priority: x.priority, assignee: x.assignee, createdBy: x.createdBy, team: x.team, dueDate: x.dueDate, createdAt: x.createdAt, labels: issue.labels.nodes.map((l) => l.name), links: (x.attachments ?? []).filter((a) => /^https?:\/\//i.test(a.url)), description: await localizeImages(issue.description ?? ""), comments });
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

app.post("/uploads", bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
  const name = c.req.query("name") ?? "file";
  const { key, inline } = await saveUpload(name, await c.req.arrayBuffer());
  return c.json({ url: `/api/uploads/${key}`, name, inline }, 201);
});
app.get("/uploads/:key", async (c) => {
  const f = await readUpload(c.req.param("key"));
  if (!f) return c.notFound();
  return c.body(f.body, 200, { "content-type": f.type, "x-content-type-options": "nosniff", "content-disposition": `${f.inline ? "inline" : "attachment"}; filename="${f.name}"`, "cache-control": "private, max-age=31536000, immutable" });
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

// Approve = squash-merge every open PR on the ticket, then Done.
app.post("/tickets/:id/merge", async (c) => {
  const id = c.req.param("id");
  const open = (await foldersOf(id)).filter(({ folder }) => folder.prUrl && folder.prState === "OPEN");
  if (!open.length) return c.json({ error: "No open PR on this ticket." }, 400);
  for (const { folder, ws } of open) {
    const err = await mergePr(folder.worktreePath ?? ws.path, folder.prUrl!).then(() => null, (e: { stderr?: string; message: string }) => e.stderr?.trim() || e.message);
    if (err) return c.json({ error: `${ws.name}: ${err}` }, 409);
    await db.update(ticketFolders).set({ prState: "MERGED" }).where(and(eq(ticketFolders.ticketId, id), eq(ticketFolders.workspaceId, ws.id)));
  }
  await setStatus(id, "done");
  return c.body(null, 204);
});

/** Everything waiting on a human, newest first. Actions reuse the answer/approval/advance routes. */
async function inboxOf(orgId: string): Promise<InboxItem[]> {
  const open = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), inArray(tickets.status, ["needs_input", "in_review", "blocked"])));
  const learnings = await db
    .select({ c: comments, t: tickets })
    .from(comments)
    .innerJoin(tickets, eq(tickets.id, comments.ticketId))
    .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), eq(comments.kind, "learning"), sql`${comments.payload}->>'status' is null`));
  const learned: InboxItem[] = learnings.map(({ c: l, t }) => ({
    kind: "learning",
    ticket: { id: t.id, identifier: t.identifier, title: t.title, status: t.status as InboxItem["ticket"]["status"], priority: t.priority as InboxItem["ticket"]["priority"] },
    commentId: l.id,
    agentId: l.agentId,
    title: (l.payload as LearningPayload).text,
    options: [{ id: "accept", label: "Add to context", primary: true }, { id: "dismiss", label: "Dismiss" }],
    createdAt: l.createdAt.toISOString(),
  }));
  if (!open.length) return learned;
  const rows = await db
    .select()
    .from(comments)
    .where(and(inArray(comments.ticketId, open.map((t) => t.id)), inArray(comments.kind, ["question", "approval", "error", "handoff", "pr", "text"])))
    .orderBy(desc(comments.createdAt));
  const withPr = new Set((await db.select({ id: ticketFolders.ticketId }).from(ticketFolders).where(and(inArray(ticketFolders.ticketId, open.map((t) => t.id)), eq(ticketFolders.prState, "OPEN")))).map((r) => r.id));
  const items: InboxItem[] = [];
  for (const t of open) {
    const ticket = { id: t.id, identifier: t.identifier, title: t.title, status: t.status as InboxItem["ticket"]["status"], priority: t.priority as InboxItem["ticket"]["priority"] };
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
      const options = withPr.has(t.id) ? [{ id: "merge", label: "Merge PR", primary: true }, { id: "done", label: "Mark done" }] : undefined;
      items.push({ kind: "review", ticket, agentId: last?.agentId ?? null, title: "Ready for your review", detail: lastText, options, createdAt: at });
    } else {
      items.push({ kind: "blocked", ticket, agentId: last?.agentId ?? null, title: t.status === "blocked" ? "Blocked" : "Needs input", detail: lastText, createdAt: at });
    }
  }
  return [...items, ...learned].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
app.get("/orgs/:orgId/inbox", async (c) => c.json(await inboxOf(c.req.param("orgId"))));

// Desktop shell poll: running Zippers, inbox size (across orgs) and pending notifications.
app.get("/tray", async (c) => {
  const [all, names] = await Promise.all([db.select({ id: orgs.id }).from(orgs), db.select({ id: agents.id, name: agents.name }).from(agents)]);
  const name = new Map(names.map((a) => [a.id, a.name]));
  const [running, inbox] = await Promise.all([Promise.all(all.map((o) => runningOf(o.id))), Promise.all(all.map((o) => inboxOf(o.id)))]);
  return c.json({
    notes: takeNotes(),
    inbox: inbox.flat().length,
    running: running.flat().map(({ agentId, ticket: t }) => ({
      label: `${name.get(agentId) ?? "Zipper"} · ${t.kind === "chat" ? t.title : `${t.identifier} ${t.title}`}`,
      path: t.kind === "chat" ? `/chat/${t.id}` : `/t/${t.identifier}`,
    })),
  });
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
