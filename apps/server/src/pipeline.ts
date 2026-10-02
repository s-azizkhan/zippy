import { asc, eq } from "drizzle-orm";
import type { HandoffPayload } from "@zippy/shared";
import { agents, db, pipelineStages, pipelines, tickets } from "./db/index.ts";
import { addComment, runAgent, setStatus } from "./runner.ts";

type Stage = typeof pipelineStages.$inferSelect;

export const HANDOFF_RULE =
  "When your part is done, call the `handoff` tool from the zippy MCP server with verdict `pass` or `fail`, a short summary, and notes for the next agent. Do not end your turn without it.";

export async function loadPipeline(pipelineId: string) {
  const [p] = await db.select().from(pipelines).where(eq(pipelines.id, pipelineId));
  if (!p) return null;
  const stages = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)).orderBy(asc(pipelineStages.position));
  return { ...p, stages };
}

// Routing waits for the handing-off agent's turn to end. key: ticketId
const pendingRoute = new Map<string, () => Promise<unknown>>();
// Agents that handed off in their current turn, and agents already nudged once. key: `${ticketId}:${agentId}`
const handedOff = new Set<string>();
const nudged = new Set<string>();
const asked = new Set<string>();

/** ask_user was called: the turn may end without a handoff. */
export const markAsked = (ticketId: string, agentId: string) => asked.add(`${ticketId}:${agentId}`);

export async function startPipeline(ticketId: string, pipelineId: string) {
  const p = await loadPipeline(pipelineId);
  if (!p?.stages.length) throw new Error("Pipeline has no stages.");
  await db.update(tickets).set({ pipelineId, loopCount: 0 }).where(eq(tickets.id, ticketId));
  return enterStage(ticketId, p.stages[0]!, null);
}

async function enterStage(ticketId: string, stage: Stage, notes: string | null) {
  const [t] = await db
    .update(tickets)
    .set({ stageId: stage.id, assigneeAgentId: stage.agentId, updatedAt: new Date() })
    .where(eq(tickets.id, ticketId))
    .returning();
  await addComment(ticketId, stage.agentId, "stage", { name: stage.name, loop: t!.loopCount });
  const message = [`Pipeline stage: **${stage.name}**.`, stage.instruction, notes && `Notes from the previous stage:\n\n${notes}`, HANDOFF_RULE]
    .filter(Boolean)
    .join("\n\n");
  runAgent(ticketId, stage.agentId, message).catch(console.error);
}

async function finish(ticketId: string) {
  const [t] = await db.update(tickets).set({ stageId: null }).where(eq(tickets.id, ticketId)).returning();
  await setStatus(ticketId, "in_review");
  return t;
}

/** Resolve "next" | "done" | "human" | position into a stage, "done", or "human". */
export function target(stages: Stage[], from: Stage, ref: string): Stage | "done" | "human" {
  if (ref === "done" || ref === "human") return ref;
  if (ref === "next") return stages.find((s) => s.position === from.position + 1) ?? "done";
  return stages.find((s) => s.position === Number(ref)) ?? "human";
}

/** Called by the zippy MCP `handoff` tool. Returns the text the agent sees. */
export async function handoff(ticketId: string, agentId: string, verdict: "pass" | "fail", summary: string, notes?: string): Promise<string> {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  const p = t?.pipelineId ? await loadPipeline(t.pipelineId) : null;
  const stage = p?.stages.find((s) => s.id === t!.stageId);
  if (!t || !p || !stage) return "No pipeline is running on this ticket. Nothing was routed; just reply normally.";
  if (stage.agentId !== agentId) return `The current stage is "${stage.name}", owned by another agent. Nothing was routed.`;

  handedOff.add(`${ticketId}:${agentId}`);
  const dest = target(p.stages, stage, verdict === "pass" ? stage.onPass : stage.onFail);
  const destName = dest === "done" ? "Done" : dest === "human" ? "You" : dest.name;
  const gate = verdict === "pass" && stage.humanGate;
  await addComment(ticketId, agentId, "handoff", {
    verdict,
    summary,
    notes,
    stage: stage.name,
    next: gate ? `You (approval), then ${destName}` : destName,
  } satisfies HandoffPayload);

  if (gate || dest === "human") {
    pendingRoute.set(ticketId, () => setStatus(ticketId, "needs_input"));
    return "Handoff recorded. A human will review before the next stage.";
  }
  if (dest === "done") {
    pendingRoute.set(ticketId, () => finish(ticketId));
    return "Handoff recorded. Pipeline complete.";
  }
  if (verdict === "fail") {
    if (t.loopCount + 1 > p.maxLoops) {
      pendingRoute.set(ticketId, async () => {
        await addComment(ticketId, null, "error", { text: `Stopped after ${p.maxLoops} fix loops. Decide how to continue.` });
        await setStatus(ticketId, "needs_input");
      });
      return "Handoff recorded. Loop limit reached; a human will decide.";
    }
    await db.update(tickets).set({ loopCount: t.loopCount + 1 }).where(eq(tickets.id, ticketId));
  }
  const from = (await db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, agentId)))[0]!.handle;
  const carried = [`From @${from} (${stage.name}, ${verdict}): ${summary}`, notes].filter(Boolean).join("\n\n");
  pendingRoute.set(ticketId, () => enterStage(ticketId, dest, carried));
  return `Handoff recorded. Next: ${dest.name}.`;
}

/** Human decision on a gated or human-routed stage. pass = continue as if the stage passed; fail = send back with a note. */
export async function humanDecision(ticketId: string, verdict: "pass" | "fail", note?: string) {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  const p = t?.pipelineId ? await loadPipeline(t.pipelineId) : null;
  const stage = p?.stages.find((s) => s.id === t!.stageId);
  if (!t || !p || !stage) throw new Error("No pipeline stage is waiting.");
  if (verdict === "fail") return enterStage(ticketId, stage, note ? `Feedback from the user:\n\n${note}` : "The user sent this back. Read the latest comments.");
  const dest = target(p.stages, stage, stage.onPass);
  if (dest === "done" || dest === "human") return finish(ticketId);
  return enterStage(ticketId, dest, note ? `Note from the user:\n\n${note}` : null);
}

/**
 * Runner hook after an agent turn. Returns true when the pipeline owns the status change.
 * Nudges a stage agent once if it ended its turn without a handoff.
 */
export async function afterTurn(ticketId: string, agentId: string): Promise<boolean> {
  const key = `${ticketId}:${agentId}`;
  const route = pendingRoute.get(ticketId);
  if (route && handedOff.has(key)) {
    pendingRoute.delete(ticketId);
    handedOff.delete(key);
    nudged.delete(key);
    await route();
    return true;
  }
  if (asked.delete(key)) {
    await setStatus(ticketId, "needs_input");
    return true;
  }
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  const [stage] = t?.stageId ? await db.select().from(pipelineStages).where(eq(pipelineStages.id, t.stageId)) : [];
  if (!stage || stage.agentId !== agentId) return false;
  if (!nudged.has(key)) {
    nudged.add(key);
    runAgent(ticketId, agentId, `You ended your turn without a handoff. ${HANDOFF_RULE} If you need the user, use ask_user.`).catch(console.error);
    return true;
  }
  nudged.delete(key);
  await setStatus(ticketId, "needs_input");
  return true;
}
