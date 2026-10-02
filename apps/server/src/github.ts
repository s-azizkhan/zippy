import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { agents, db, pipelines, ticketFolders, tickets } from "./db/index.ts";
import { addComment, runAgent, setStatus } from "./runner.ts";

const exec = promisify(execFile);

/** gh exits non-zero when checks fail or are pending; the JSON is still on stdout. */
async function gh<T>(cwd: string, args: string[]): Promise<T | null> {
  const r = await exec("gh", args, { cwd, maxBuffer: 16 * 1024 * 1024 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

type Check = { name: string; bucket: string; link: string };
type Review = { author: { login: string }; authorAssociation: string; body: string; state: string; submittedAt: string };
type Inline = { user: { login: string }; author_association: string; path: string; line: number | null; body: string; created_at: string };

// Review text becomes agent instructions: only people with repo rights may steer an agent.
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const isBot = (login: string) => login.endsWith("[bot]");

/** Failed-step log of a GitHub Actions job link, tail only. Other CI providers: link only. */
async function failedLog(cwd: string, link: string) {
  const run = /\/actions\/runs\/(\d+)/.exec(link)?.[1];
  if (!run) return "";
  const r = await exec("gh", ["run", "view", run, "--log-failed"], { cwd, maxBuffer: 64 * 1024 * 1024 }).catch(() => null);
  return r?.stdout.slice(-6000) ?? "";
}

/** The agent that fixes PR feedback: the assignee if it can write, else the org's first writer. */
async function fixer(ticket: typeof tickets.$inferSelect) {
  const team = await db.select().from(agents).where(eq(agents.orgId, ticket.orgId));
  return team.find((a) => a.id === ticket.assigneeAgentId && a.canWrite) ?? team.find((a) => a.canWrite);
}

/** Counts a fix round. False = loop limit hit; the ticket goes to the user instead. */
async function spendLoop(ticket: typeof tickets.$inferSelect) {
  const [p] = ticket.pipelineId ? await db.select().from(pipelines).where(eq(pipelines.id, ticket.pipelineId)) : [];
  const max = p?.maxLoops ?? 3;
  if (ticket.loopCount + 1 > max) {
    await addComment(ticket.id, null, "error", { text: `Stopped after ${max} fix loops on PR feedback. Decide how to continue.` });
    await setStatus(ticket.id, "needs_input");
    return false;
  }
  await db.update(tickets).set({ loopCount: ticket.loopCount + 1 }).where(eq(tickets.id, ticket.id));
  return true;
}

/** One pass over open PRs: failed CI and new review comments go back to the fixing agent. */
export async function checkPrs() {
  const open = await db.select().from(ticketFolders).where(eq(ticketFolders.prState, "OPEN"));
  for (const f of open) {
    if (!f.prUrl || !f.worktreePath) continue;
    const cwd = f.worktreePath;
    const where = and(eq(ticketFolders.ticketId, f.ticketId), eq(ticketFolders.workspaceId, f.workspaceId));
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, f.ticketId));
    if (!ticket || ["done", "canceled"].includes(ticket.status)) continue;
    const agent = await fixer(ticket);
    if (!agent) continue;

    const pr = await gh<{ headRefOid: string; number: number; reviews: Review[] }>(cwd, ["pr", "view", f.prUrl, "--json", "headRefOid,number,reviews"]);
    if (!pr) continue;

    // CI: act once per head commit, after every check finished.
    const checks = (await gh<Check[]>(cwd, ["pr", "checks", f.prUrl, "--json", "name,bucket,link"])) ?? [];
    const failed = checks.filter((c) => c.bucket === "fail");
    if (failed.length && !checks.some((c) => c.bucket === "pending") && f.ciHandledSha !== pr.headRefOid) {
      await db.update(ticketFolders).set({ ciHandledSha: pr.headRefOid }).where(where);
      await addComment(ticket.id, null, "error", { text: `CI failed on ${f.prUrl}: ${failed.map((c) => `[${c.name}](${c.link})`).join(", ")}. Sent to @${agent.handle}.` });
      if (await spendLoop(ticket)) {
        const log = await failedLog(cwd, failed[0]!.link);
        runAgent(
          ticket.id,
          agent.id,
          [
            `CI failed on ${f.prUrl} (worktree ${cwd}).`,
            failed.map((c) => `- ${c.name}: ${c.link}`).join("\n"),
            log && `Failed log (tail):\n\`\`\`\n${log}\n\`\`\``,
            "Fix the cause, run the tests, commit, then call open_pr to push the fix.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        ).catch(console.error);
      }
    }

    // Reviews: first sight sets the baseline, later passes forward what is new.
    const since = f.reviewSeenAt;
    const now = new Date();
    await db.update(ticketFolders).set({ reviewSeenAt: now }).where(where);
    if (!since) continue;
    const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(f.prUrl)?.[1];
    const inline = repo ? ((await gh<Inline[]>(cwd, ["api", `repos/${repo}/pulls/${pr.number}/comments`])) ?? []) : [];
    const fresh = [
      ...pr.reviews
        .filter((r) => new Date(r.submittedAt) > since && r.body.trim() && !isBot(r.author.login) && TRUSTED.has(r.authorAssociation))
        .map((r) => `- **${r.author.login}** (${r.state.toLowerCase().replace("_", " ")}): ${r.body}`),
      ...inline
        .filter((c) => new Date(c.created_at) > since && !isBot(c.user.login) && TRUSTED.has(c.author_association))
        .map((c) => `- **${c.user.login}** on \`${c.path}${c.line ? `:${c.line}` : ""}\`: ${c.body}`),
    ];
    if (!fresh.length) continue;
    await addComment(ticket.id, null, "text", { text: `New PR review feedback on ${f.prUrl}:\n\n${fresh.join("\n")}`, author: "GitHub" });
    if (await spendLoop(ticket)) {
      runAgent(
        ticket.id,
        agent.id,
        `New review feedback on ${f.prUrl} (worktree ${cwd}):\n\n${fresh.join("\n")}\n\nAddress each point (or reply why not), commit, then call open_pr to push.`,
      ).catch(console.error);
    }
  }
}
